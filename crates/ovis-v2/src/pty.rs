//! PTY ownership with v1's output window (T-06).
//!
//! One sidecar per attachment. Its bytes are forwarded with a monotonically increasing offset;
//! the consumer ACKs offsets. Above 256 KiB unacknowledged we stop reading; when it drops under
//! 64 KiB we resume; at 1 MiB the connection is closed with code 4008 — never a growing buffer.

use std::{process::Stdio, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};

use bytes::{BufMut, BytesMut};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::{Child, Command}, sync::{Mutex, Notify}};
use tokio_tungstenite::tungstenite::{protocol::{frame::coding::CloseCode, CloseFrame}, Message};

const HIGH_WATER: usize = 256 * 1024;
const LOW_WATER: usize = 64 * 1024;
const HARD_CAP: usize = 1024 * 1024;
/// how long a consumer may sit above the high-water mark with no ACK before it loses the
/// connection (v1 also ends stalled output; its budget is tuned in T-08, not guessed here)
const STALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// The binary the gateway spawns for every attachment (P0's Rust PTY host).
fn sidecar_binary() -> String {
    std::env::var("OVIS_PTY_SIDECAR_BIN").unwrap_or_else(|_| "ovis-pty-sidecar".to_string())
}

pub struct Window {
    buffered: usize,
    acked: u64,
}

/// One attachment: sidecar stdout → frames, client ACKs → the window.
pub async fn attach(stream: tokio_tungstenite::WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>, cols: u16, rows: u16, command: Vec<String>) {
    if command.is_empty() {
        return;
    }
    let mut child = match Command::new(sidecar_binary())
        .arg(cols.to_string())
        .arg(rows.to_string())
        .args(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("pty: cannot start the sidecar: {error}");
            return;
        }
    };
    let mut stdout = child.stdout.take().expect("pty stdout");
    let stdin = child.stdin.take().expect("pty stdin");
    let mut stdin = stdin;
    let (mut sink, mut source) = stream.split();
    let window = Arc::new(Mutex::new(Window { buffered: 0, acked: 0 }));
    // one attachment's input order: every write is rechecked against the generation, and a typed
    // ESC settles longer than ordinary text (v1's 40 ms / 300 ms)
    let generation = Arc::new(AtomicU64::new(0));
    let mut last_typed: Option<(Instant, bool)> = None;
    let resume = Arc::new(Notify::new());
    let mut offset: u64 = 0;
    let mut buf = [0u8; 16 * 1024];

    let ack_window = window.clone();
    let ack_resume = resume.clone();
    let acks = async move {
        let mut stdin = stdin;
        let mut generation = generation;
        while let Some(Ok(message)) = source.next().await {
            if let Message::Text(text) = message {
                if text == "detach" {
                    generation.fetch_add(1, Ordering::SeqCst);
                    break;
                }
                if let Some(input) = text.strip_prefix("input:") {
                    // the settle wait belongs to the previous write, then the generation is rechecked
                    if let Some((at, escaped)) = last_typed {
                        let budget = if escaped { Duration::from_millis(300) } else { Duration::from_millis(40) };
                        let elapsed = at.elapsed();
                        if elapsed < budget {
                            tokio::time::sleep(budget - elapsed).await;
                        }
                    }
                    if generation.load(Ordering::SeqCst) != 0 {
                        break;
                    }
                    let escaped = input.ends_with('\u{1b}');
                    let frame = serde_json::json!({ "t": "i", "d": input }).to_string() + "\n";
                    if stdin.write_all(frame.as_bytes()).await.is_err() {
                        break;
                    }
                    last_typed = Some((Instant::now(), escaped));
                    // test-only observability (never to the client): when the write actually happened
                    eprintln!("input-write {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
                    continue;
                }
                if let Some(rest) = text.strip_prefix("ack:") {
                    if let Ok(at) = rest.parse::<u64>() {
                        let mut window = ack_window.lock().await;
                        if at > window.acked {
                            let freed = (at - window.acked) as usize;
                            window.acked = at;
                            window.buffered = window.buffered.saturating_sub(freed);
                            if window.buffered < LOW_WATER {
                                ack_resume.notify_one();
                            }
                        }
                    }
                }
            }
        }
    };

    let writer = {
        let window = window.clone();
        let resume = resume.clone();
        let sink_ref = &mut sink;
        async move {
            loop {
                // the window decides whether the next read may happen at all
                {
                    let current = window.lock().await.buffered;
                    if current >= HIGH_WATER {
                        // wait for the consumer to catch up, but only for the stall budget: a consumer
                        // that never ACKs loses the connection with 4008, never an unbounded buffer
                        if tokio::time::timeout(STALL_BUDGET, resume.notified()).await.is_err() {
                            let _ = sink_ref.send(Message::Close(Some(CloseFrame { code: CloseCode::from(4008u16), reason: "output stalled".into() }))).await;
                            break;
                        }
                    }
                }
                let read = match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let mut frame = BytesMut::with_capacity(8 + read);
                frame.put_u64_le(offset);
                frame.put_slice(&buf[..read]);
                if sink_ref.send(Message::Binary(frame.to_vec().into())).await.is_err() {
                    break;
                }
                offset += read as u64;
                {
                    let mut window = window.lock().await;
                    window.buffered += read;
                    if window.buffered > HARD_CAP {
                        // v1's refusal: the slow consumer loses the connection, not the process's memory
                        let _ = sink_ref.send(Message::Close(Some(CloseFrame { code: CloseCode::from(4008u16), reason: "output window exceeded".into() }))).await;
                        break;
                    }
                }
            }
        }
    };

    // stdin stays open: closing it would tell the sidecar to stop (P0's direct-spawn observation)
    tokio::select! {
        _ = acks => {}
        _ = writer => {}
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}
