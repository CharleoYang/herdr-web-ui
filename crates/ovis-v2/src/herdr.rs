//! herdr's socket client (T-03): one JSON line per request, one per reply, with a timeout, an
//! explicit error map, and a version gate. A reply that never completes is never taken as a success.

use std::{io::ErrorKind, path::Path, process, time::Duration};

use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, net::UnixStream, time::timeout};

/// herdr's own error codes, and the failures this client can hit before it sends anything.
#[derive(Debug)]
pub enum RpcError {
    Timeout,
    Closed,
    BadFrame(String),
    Socket(String),
    Remote { code: String, message: String },
    Version { protocol: i64 },
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Timeout => write!(f, "timeout"),
            RpcError::Closed => write!(f, "closed"),
            RpcError::BadFrame(reason) => write!(f, "bad_frame: {reason}"),
            RpcError::Socket(reason) => write!(f, "socket_error: {reason}"),
            RpcError::Remote { code, message } => write!(f, "{code}: {message}"),
            RpcError::Version { protocol } => write!(f, "unsupported protocol {protocol}"),
        }
    }
}

impl std::error::Error for RpcError {}

pub struct Herdr {
    path: std::path::PathBuf,
    timeout: Duration,
}

/// The protocol this gateway is built against: v1 refuses a lower one too.
const MIN_PROTOCOL: i64 = 22;

impl Herdr {
    pub fn new(path: impl AsRef<Path>, timeout_ms: u64) -> Self {
        Self { path: path.as_ref().to_path_buf(), timeout: Duration::from_millis(timeout_ms) }
    }

    /// One call: connect, write a line, read a line. A connection is never shared between calls,
    /// as herdr itself answers one request per connection.
    pub async fn call(&self, id: &str, method: &str, params: &str) -> Result<String, RpcError> {
        let stream = match UnixStream::connect(&self.path).await {
            Ok(stream) => stream,
            Err(error) => {
                let reason = if error.kind() == ErrorKind::NotFound { "no such socket".to_string() } else { error.to_string() };
                return Err(RpcError::Socket(reason));
            }
        };
        let (read_half, mut write_half) = stream.into_split();
        let frame = format!("{{\"id\":\"{id}\",\"method\":\"{method}\",\"params\":{params}}}\n");
        timeout(self.timeout, write_half.write_all(frame.as_bytes()))
            .await
            .map_err(|_| RpcError::Timeout)?
            .map_err(|error| RpcError::Socket(error.to_string()))?;
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let read = timeout(self.timeout, reader.read_line(&mut line))
            .await
            .map_err(|_| RpcError::Timeout)?
            .map_err(|error| RpcError::Socket(error.to_string()))?;
        if read == 0 {
            return Err(RpcError::Closed);
        }
        let trimmed = line.trim();
        // a reply that is not a result/error frame is refused, never handed on as if it answered
        if !trimmed.starts_with('{') || (!trimmed.contains("\"result\"") && !trimmed.contains("\"error\"")) {
            return Err(RpcError::BadFrame("not a result/error frame".into()));
        }
        Ok(line)
    }

    /// The daemon's negotiated protocol. A lower one refuses the whole gateway instead of half-working.
    pub async fn ping(&self) -> Result<i64, RpcError> {
        let answer = self.call("ping", "ping", "{}").await?;
        let protocol = answer
            .split("\"protocol\"")
            .nth(1)
            .and_then(|tail| tail.split(|c: char| !c.is_ascii_digit()).find(|part| !part.is_empty()))
            .and_then(|digits| digits.parse::<i64>().ok())
            .ok_or_else(|| RpcError::BadFrame("ping carried no protocol".into()))?;
        if protocol < MIN_PROTOCOL {
            return Err(RpcError::Version { protocol });
        }
        Ok(protocol)
    }
}

/// The `--selftest-rpc` runner: a fixture daemon answers on the socket and this prints one verdict
/// per case. It never touches a real herdr.
pub async fn selftest(path: &Path) {
    let client = Herdr::new(path, 1_500);
    let mut failures = 0;
    let mut report = |name: &str, ok: bool, detail: &str| {
        println!("{} {}{}", if ok { "ok" } else { "FAIL" }, name, if detail.is_empty() { String::new() } else { format!(" ({detail})") });
        if !ok {
            failures += 1;
        }
    };

    match client.call("1", "ping", "{}").await {
        Ok(answer) if answer.contains("protocol") => report("a normal call answers", true, ""),
        other => report("a normal call answers", false, &format!("{other:?}")),
    }
    match client.call("2", "split", "{}").await {
        Ok(answer) if answer.contains("split") => report("a fragmented reply is reassembled", true, ""),
        other => report("a fragmented reply is reassembled", false, &format!("{other:?}")),
    }
    match client.call("3", "bad", "{}").await {
        Err(RpcError::BadFrame(_)) | Err(RpcError::Closed) => report("a malformed reply is refused", true, ""),
        other => report("a malformed reply is refused", false, &format!("{other:?}")),
    }
    match client.call("4", "slow", "{}").await {
        Err(RpcError::Timeout) => report("a reply past its timeout is refused", true, ""),
        other => report("a reply past its timeout is refused", false, &format!("{other:?}")),
    }
    match client.ping().await {
        Err(RpcError::Version { protocol }) if protocol == 21 => report("an old protocol is refused", true, ""),
        other => report("an old protocol is refused", false, &format!("{other:?}")),
    }
    let missing = Herdr::new(path.with_extension("does-not-exist"), 1_500);
    match missing.call("5", "ping", "{}").await {
        Err(RpcError::Socket(_)) => report("a missing socket is an error, not a hang", true, ""),
        other => report("a missing socket is an error, not a hang", false, &format!("{other:?}")),
    }

    if failures > 0 {
        process::exit(1);
    }
    println!("herdr-selftest: all checks passed");
}
