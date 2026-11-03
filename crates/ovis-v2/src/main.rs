//! ovis-v2: the gateway skeleton (T-01).
//!
//! Serves the SPA's `dist/` from a loopback listener only. `--selftest` performs the same checks
//! the step's Bun validator does, without a second process. No public bind is ever accepted: the
//! public port belongs to v1 until the plan's T-11.

use std::{
    convert::Infallible,
    io::Write,
    env,
    error::Error,
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    process,
    time::UNIX_EPOCH,
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
mod access;
mod conversation;
mod herdr;
mod proxy;
mod pane_http;
mod pty;
mod session;
mod state;
use hyper::{body::Incoming, Request, Response, StatusCode};
use std::sync::Arc;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

type Body = Full<Bytes>;
type Out = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

fn boxed(body: Bytes) -> Out {
    Full::new(body).map_err(|never: Infallible| match never {}).boxed()
}
type Result<T, E = Box<dyn Error + Send + Sync>> = std::result::Result<T, E>;

fn json_response(text: String) -> Response<Out> {
    let mut response = Response::new(boxed(Bytes::from(text)));
    response.headers_mut().insert("content-type", "application/json".parse().unwrap());
    response
}

async fn request_json(request: Request<Incoming>) -> serde_json::Value {
    let Ok(collected) = request.into_body().collect().await else {
        return serde_json::Value::Null;
    };
    serde_json::from_slice(&collected.to_bytes()).unwrap_or(serde_json::Value::Null)
}

const USAGE: &str = "usage: ovis-v2 --dist <dir> [--port <n>] [--host 127.0.0.1] [--selftest] [--test-listen]";

struct Args {
    dist: PathBuf,
    port: u16,
    host: IpAddr,
    selftest: bool,
    test_listen: bool,
    upstream: Option<Arc<str>>,
    trace: Option<PathBuf>,
    rpc_selftest: Option<PathBuf>,
    herdr_socket: Option<PathBuf>,
    state_path: Option<PathBuf>,
    transcripts: Option<PathBuf>,
    token: Option<String>,
    origins: Vec<String>,
    revoked: Vec<String>,
    trust_proxy: bool,
}

fn parse() -> Result<Args> {
    let mut dist = PathBuf::from("dist");
    let mut port: u16 = 7414;
    let mut host: IpAddr = "127.0.0.1".parse()?;
    let mut selftest = false;
    let mut test_listen = false;
    let mut upstream: Option<Arc<str>> = None;
    let mut trace: Option<PathBuf> = None;
    let mut rpc_selftest: Option<PathBuf> = None;
    let mut herdr_socket: Option<PathBuf> = None;
    let mut state_path: Option<PathBuf> = None;
    let mut transcripts: Option<PathBuf> = None;
    let mut token: Option<String> = None;
    let mut origins: Vec<String> = Vec::new();
    let mut revoked: Vec<String> = Vec::new();
    let mut trust_proxy = false;
    let mut argv = env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--dist" => dist = PathBuf::from(argv.next().ok_or("--dist needs a directory")?),
            "--port" => port = argv.next().ok_or("--port needs a number")?.parse()?,
            "--host" => host = argv.next().ok_or("--host needs an address")?.parse()?,
            "--selftest" => selftest = true,
            "--test-listen" => test_listen = true,
            "--upstream" => upstream = Some(Arc::from(argv.next().ok_or("--upstream needs a URL")?)),
            "--trace" => trace = Some(PathBuf::from(argv.next().ok_or("--trace needs a file")?)),
            "--selftest-rpc" => rpc_selftest = Some(PathBuf::from(argv.next().ok_or("--selftest-rpc needs a socket path")?)),
            "--herdr-socket" => herdr_socket = Some(PathBuf::from(argv.next().ok_or("--herdr-socket needs a path")?)),
            "--state" => state_path = Some(PathBuf::from(argv.next().ok_or("--state needs a path")?)),
            "--transcripts" => transcripts = Some(PathBuf::from(argv.next().ok_or("--transcripts needs a path")?)),
            "--token" => token = Some(argv.next().ok_or("--token needs a value")?),
            "--allow-origin" => origins.extend(argv.next().ok_or("--allow-origin needs a value")?.split(',').map(|v| v.to_string())),
            "--revoke" => revoked.extend(argv.next().ok_or("--revoke needs a value")?.split(',').map(|v| v.to_string())),
            "--trust-proxy" => trust_proxy = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                process::exit(0);
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}").into()),
        }
    }
    if let Some(fromEnv) = env::var_os("OVIS_V2_PORT") {
        if port == 7414 {
            port = fromEnv.to_string_lossy().parse()?;
        }
    }
    Ok(Args { dist, port, host, selftest, test_listen, upstream, trace, rpc_selftest, herdr_socket, state_path, transcripts, token, origins, revoked, trust_proxy })
}

/// Only a loopback listener: a public bind would move traffic the plan has not migrated yet.
fn loopback(addr: IpAddr) -> bool {
    addr.is_loopback()
}

/// An ETag that changes exactly when the file changes, without reading it.
fn etag(meta: &std::fs::Metadata) -> String {
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    format!("\"{:x}-{:x}\"", meta.len(), modified)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "map" => "application/json; charset=utf-8",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// A path inside `dist/`: the leading slash is dropped and no `..` is followed.
fn resolve(dist: &Path, request_path: &str) -> Option<PathBuf> {
    let clean = request_path.split(['?', '#']).next().unwrap_or("/");
    let mut out = dist.to_path_buf();
    let mut any = false;
    for part in Path::new(clean).components() {
        match part {
            Component::Normal(segment) => {
                if segment == ".." {
                    return None;
                }
                out.push(segment);
                any = true;
            }
            Component::CurDir | Component::RootDir => {}
            _ => return None,
        }
    }
    if !any {
        out.push("index.html");
    }
    if out.is_dir() {
        out.push("index.html");
    }
    Some(out)
}

struct FileAnswer {
    body: Bytes,
    status: StatusCode,
    etag: String,
    encoding: Option<&'static str>,
    content_type: &'static str,
    range: Option<(u64, u64, u64)>,
}

/// Reads one asset, honouring a precompressed sibling, an ETag match and a single byte range.
async fn asset(dist: &Path, request: &Request<Incoming>) -> Option<FileAnswer> {
    let path = resolve(dist, request.uri().path())?;
    let accept_gzip = request.headers().get("accept-encoding").and_then(|v| v.to_str().ok()).map(|v| v.contains("gzip")).unwrap_or(false);
    // A range is taken from the identity representation: a slice of a gzip stream cannot be decoded.
    let ranged = request.headers().contains_key("range");
    let gz = PathBuf::from(format!("{}.gz", path.display()));
    let (chosen, encoding) = if accept_gzip && !ranged && gz.is_file() { (gz, Some("gzip")) } else { (path, None) };
    let meta = tokio::fs::metadata(&chosen).await.ok()?;
    let tag = etag(&meta);
    if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
        return Some(FileAnswer {
            body: Bytes::new(),
            status: StatusCode::NOT_MODIFIED,
            etag: tag,
            encoding,
            content_type: content_type(&chosen),
            range: None,
        });
    }
    let bytes = Bytes::from(tokio::fs::read(&chosen).await.ok()?);
    let total = bytes.len() as u64;
    let mut status = StatusCode::OK;
    let mut range = None;
    let mut body = bytes;
    if let Some(header) = request.headers().get("range").and_then(|v| v.to_str().ok()) {
        if let Some(spec) = header.strip_prefix("bytes=") {
            let (start_s, end_s) = spec.split_once('-')?;
            let start: u64 = start_s.parse().ok()?;
            let end: u64 = if end_s.is_empty() { total.saturating_sub(1) } else { end_s.parse().ok()? };
            if start < total && start <= end {
                let last = end.min(total - 1);
                body = body.slice(start as usize..=(last) as usize);
                status = StatusCode::PARTIAL_CONTENT;
                range = Some((start, last, total));
            } else {
                status = StatusCode::RANGE_NOT_SATISFIABLE;
                body = Bytes::new();
                range = None;
            }
        }
    }
    Some(FileAnswer { body, status, etag: tag, encoding, content_type: content_type(&chosen), range })
}

fn respond(answer: FileAnswer) -> Response<Out> {
    let mut response = Response::new(boxed(answer.body));
    *response.status_mut() = answer.status;
    response.headers_mut().insert("etag", answer.etag.parse().unwrap());
    response.headers_mut().insert("content-type", answer.content_type.parse().unwrap());
    if let Some(encoding) = answer.encoding {
        response.headers_mut().insert("content-encoding", encoding.parse().unwrap());
    }
    if let Some((start, last, total)) = answer.range {
        response.headers_mut().insert("content-range", format!("bytes {start}-{last}/{total}").parse().unwrap());
    }
    response
}

fn json_value(value: serde_json::Value, key: &str, status: StatusCode) -> Response<Out> {
    let body = boxed(Bytes::from(serde_json::json!({ key: value }).to_string()));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert("content-type", "application/json; charset=utf-8".parse().unwrap());
    response
}

fn json_error(error: impl std::fmt::Display, status: StatusCode) -> Response<Out> {
    let body = boxed(Bytes::from(format!("{{\"error\":\"{}\"}}\n", error)));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
}

async fn serve(dist: PathBuf, upstream: Option<Arc<str>>, trace: Option<PathBuf>, herdr_socket: Option<PathBuf>, store: Arc<state::Store>, transcripts: Option<PathBuf>, access: Arc<access::Access>, request: Request<Incoming>) -> std::result::Result<Response<Out>, Infallible> {
    let path = request.uri().path();
    if path.starts_with("/api/") {
        let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(|value| value.to_string());
        let token = header("authorization").and_then(|value| value.strip_prefix("Bearer ").map(|rest| rest.to_string()))
            .or_else(|| request.uri().query().unwrap_or("").split('&').find_map(|pair| pair.strip_prefix("token=")).map(|value| value.to_string()));
        let origin = header("origin");
        let device = header("x-device-id");
        let evidence = access::Evidence {
            loopback: true,
            forwarded: header("x-forwarded-for").is_some(),
            token: token.as_deref(),
            origin: origin.as_deref(),
            device: device.as_deref(),
        };
        if let access::Decision::Reject(reason) = access.admit(&evidence) {
            let status = if reason == "token" { StatusCode::UNAUTHORIZED } else { StatusCode::FORBIDDEN };
            let mut response = json_response(format!("{{\"error\":\"{reason}\"}}"));
            *response.status_mut() = status;
            return Ok(response);
        }
    }
    // the test-only PTY endpoint: a WebSocket with the output window, gated on --test-listen AND
    // the test-listen cargo feature; a production build has no such entry
    #[cfg(feature = "test-listen")]
    if path == "/test/pty" {
        let allowed = true;
        if allowed {
            let query = request.uri().query().unwrap_or("");
            let pane_id = query.split('&').find_map(|pair| pair.strip_prefix("pane_id=")).map(|value| value.to_string());
            let command = query
                .split('&')
                .find_map(|pair| pair.strip_prefix("cmd="))
                .map(|raw| raw.split('+').map(|part| part.to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            if command.is_empty() {
                let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"missing cmd\"}\n")));
                *response.status_mut() = StatusCode::BAD_REQUEST;
                return Ok(response);
            }
            if request.headers().contains_key("upgrade") {
                // RFC 6455: the handshake is not complete without Sec-WebSocket-Accept
                use sha1::{Digest, Sha1};
                let accept = request.headers().get("sec-websocket-key").and_then(|value| value.to_str().ok()).map(|key| {
                    let mut sha = Sha1::new();
                    sha.update(key.as_bytes());
                    sha.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(sha.finalize())
                });
                let upgraded = hyper::upgrade::on(request);
                tokio::spawn(async move {
                    match upgraded.await {
                        Ok(upgraded) => {
                            let stream = tokio_tungstenite::WebSocketStream::from_raw_socket(TokioIo::new(upgraded), tokio_tungstenite::tungstenite::protocol::Role::Server, None).await;
                            pty::attach(stream, 120, 40, command, pane_id, herdr_socket.clone()).await;
                        }
                        Err(error) => eprintln!("pty upgrade failed: {error}"),
                    }
                });
                let mut response = Response::new(boxed(Bytes::new()));
                *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
                response.headers_mut().insert("upgrade", "websocket".parse().unwrap());
                response.headers_mut().insert("connection", "Upgrade".parse().unwrap());
                if let Some(accept) = accept {
                    response.headers_mut().insert("sec-websocket-accept", accept.parse().unwrap());
                }
                return Ok(response);
            }
        }
    }

    // spec T-09 core: transcript reads with cursor, ETag, truncation and oversize handling
    if path == "/test/conversation" || path == "/api/conversation" {
        let query = request.uri().query().unwrap_or("");
        let param = |name: &str| query.split('&').find_map(|pair| pair.strip_prefix(name));
        let session = param("session=").unwrap_or("");
        // a session id names a file, never a path: no traversal out of the transcripts directory
        if session.is_empty() || session.contains('/') || session.contains("..") {
            let mut response = json_response("{\"error\":\"bad session\"}".into());
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        let cursor = param("cursor=").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
        let limit = param("limit=").and_then(|value| value.parse::<usize>().ok()).unwrap_or(100);
        let budget = param("budget=").and_then(|value| value.parse::<usize>().ok()).unwrap_or(256 * 1024);
        let directory = transcripts.clone().unwrap_or_else(|| PathBuf::from("."));
        let file = directory.join(format!("{session}.jsonl"));
        let if_none_match = request.headers().get("if-none-match").and_then(|value| value.to_str().ok()).map(|value| value.to_string());
        let page = conversation::read(&file, cursor, limit, budget, if_none_match.as_deref());
        if page.not_modified {
            let mut response = Response::new(boxed(Bytes::new()));
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            response.headers_mut().insert("etag", page.etag.parse().unwrap());
            return Ok(response);
        }
        let mut response = json_response(page.body.to_string());
        response.headers_mut().insert("etag", page.etag.parse().unwrap());
        return Ok(response);
    }

    // spec T-07 core: durable pending input and composer drafts (test seam until T-08's real routes)
    #[cfg(feature = "test-listen")]
    if path == "/test/state/export" {
        return Ok(json_response(store.export()));
    }
    if (path == "/test/pending" || path == "/api/pending") && request.method() == hyper::Method::GET {
        let query = request.uri().query().unwrap_or("");
        let pane = query.split('&').find_map(|pair| pair.strip_prefix("pane_id="));
        let items: Vec<serde_json::Value> = store.list(pane).iter().map(|item| serde_json::json!({
            "id": item.id, "pane_id": item.pane_id, "text": item.text, "state": item.state,
        })).collect();
        return Ok(json_response(serde_json::json!({ "pending": items }).to_string()));
    }
    if (path == "/test/pending/submit" || path == "/api/pending/submit") && request.method() == hyper::Method::POST {
        let body = request_json(request).await;
        let pane = body.get("pane_id").and_then(serde_json::Value::as_str).unwrap_or("");
        let text = body.get("text").and_then(serde_json::Value::as_str).unwrap_or("");
        if pane.is_empty() {
            let mut response = json_response("{\"error\":\"missing pane_id\"}".into());
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        let id = store.submit(pane, text);
        return Ok(json_response(serde_json::json!({ "id": id }).to_string()));
    }
    if (path == "/test/pending/resolve" || path == "/api/pending/resolve") && request.method() == hyper::Method::POST {
        let body = request_json(request).await;
        let id = body.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
        let outcome = body.get("outcome").and_then(serde_json::Value::as_str).unwrap_or("done");
        let ok = store.resolve(id, outcome);
        return Ok(json_response(serde_json::json!({ "ok": ok }).to_string()));
    }
    if path == "/test/composer" || path == "/api/composer" {
        if request.method() == hyper::Method::GET {
            let query = request.uri().query().unwrap_or("");
            let pane = query.split('&').find_map(|pair| pair.strip_prefix("pane_id=")).unwrap_or("");
            return Ok(json_response(serde_json::json!({ "draft": store.draft(pane) }).to_string()));
        }
        let body = request_json(request).await;
        let pane = body.get("pane_id").and_then(serde_json::Value::as_str).unwrap_or("");
        let draft = body.get("draft").and_then(serde_json::Value::as_str).unwrap_or("");
        store.set_draft(pane, draft);
        return Ok(json_response("{\"ok\":true}".into()));
    }

    // native pane reads: single herdr calls, with v1's own parameter validation
    if path == "/api/pane/read" {
        if request.method() != hyper::Method::GET {
            let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"use GET\"}\n")));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        let query = request.uri().query().unwrap_or("");
        let pane = query.split('&').find_map(|pair| pair.strip_prefix("pane_id=")).unwrap_or("").to_string();
        if pane.is_empty() {
            let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"missing_pane_id\"}\n")));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        let source = query.split('&').find_map(|pair| pair.strip_prefix("source=")).unwrap_or("visible");
        let format = query.split('&').find_map(|pair| pair.strip_prefix("format=")).unwrap_or("text");
        let allowed_source = ["detection", "recent", "recent_unwrapped", "visible"].contains(&source);
        let allowed_format = ["ansi", "text"].contains(&format);
        if !allowed_source || !allowed_format {
            let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"invalid_source_or_format\"}\n")));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        if let Some(socket) = &herdr_socket {
            return Ok(match pane_http::read(socket, &pane, source, format).await {
                Ok(value) => json_value(value, "read", StatusCode::OK),
                Err(error) => json_error(error, StatusCode::BAD_GATEWAY),
            });
        }
    }
    if path == "/api/pane/scroll" {
        let query = request.uri().query().unwrap_or("");
        let pane = query.split('&').find_map(|pair| pair.strip_prefix("pane_id=")).unwrap_or("").to_string();
        if pane.is_empty() && request.method() == hyper::Method::GET {
            let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"missing_pane_id\"}\n")));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return Ok(response);
        }
        if let Some(socket) = &herdr_socket {
            if request.method() == hyper::Method::GET {
                return Ok(match pane_http::scroll_info(socket, &pane).await {
                    Ok(value) => json_value(value, "scroll", StatusCode::OK),
                    Err(error) => json_error(error, StatusCode::BAD_GATEWAY),
                });
            }
            if request.method() == hyper::Method::POST {
                let body = match request.into_body().collect().await {
                    Ok(collected) => collected.to_bytes(),
                    Err(_) => Bytes::new(),
                };
                let payload: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({}));
                let pane_id = payload.get("pane_id").and_then(|v| v.as_str()).unwrap_or("");
                let offset = payload.get("offset_from_bottom").and_then(|v| v.as_u64());
                if pane_id.is_empty() || offset.is_none() {
                    let mut response = Response::new(boxed(Bytes::from_static(b"{\"error\":\"invalid_scroll_request\"}\n")));
                    *response.status_mut() = StatusCode::BAD_REQUEST;
                    return Ok(response);
                }
                return Ok(match pane_http::scroll(socket, pane_id, offset.unwrap()).await {
                    Ok(value) => json_value(value, "scroll", StatusCode::OK),
                    Err(error) => json_error(error, StatusCode::BAD_GATEWAY),
                });
            }
        }
    }

    // a snapshot this gateway answers itself: the RPC read, never a v1 proxy
    if path == "/api/session" {
        if let Some(socket) = herdr_socket {
            let boot = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            return Ok(match session::snapshot(&socket, &boot).await {
                Ok(value) => {
                    let body = boxed(Bytes::from(value.to_string()));
                    let mut response = Response::new(body);
                    response.headers_mut().insert("content-type", "application/json; charset=utf-8".parse().unwrap());
                    response
                }
                Err(error) => {
                    let body = boxed(Bytes::from(format!("{{\"error\":\"{}\"}}\n", error)));
                    let mut response = Response::new(body);
                    *response.status_mut() = StatusCode::BAD_GATEWAY;
                    response
                }
            });
        }
    }
    // the surface this gateway does not own yet goes to v1, streamed, never buffered
    if let Some(upstream) = upstream {
        if path.starts_with("/api/") || path.starts_with("/_portal/") {
            if request.headers().contains_key("upgrade") {
                // the WebSocket handover is T-08's: not silently proxied half way
                let mut response = Response::new(boxed(Bytes::from_static(b"WebSocket handover is T-08\n")));
                *response.status_mut() = StatusCode::NOT_IMPLEMENTED;
                return Ok(response);
            }
            if let Some(trace_path) = &trace {
                // one JSON line per forwarded operation: the T-02 three-way reconciliation reads this
                let line = format!("{{\"method\":\"{}\",\"path\":\"{}\",\"target\":\"upstream\"}}\n", request.method(), path);
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(trace_path) {
                    let _ = file.write_all(line.as_bytes());
                }
            }
            let proxy = proxy::Proxy::new(upstream);
            return Ok(match proxy.forward(request).await {
                Ok(response) => response,
                Err(_) => {
                    let mut response = proxy::unavailable();
                    let (parts, body) = response.into_parts();
                    let mut response = Response::new(boxed(body.collect().await.map(|c| c.to_bytes()).unwrap_or_default()));
                    *response.status_mut() = parts.status;
                    response
                }
            });
        }
    }
    let response = match asset(&dist, &request).await {
        Some(answer) => respond(answer),
        None => {
            let mut response = Response::new(boxed(Bytes::from_static(b"not found\n")));
            *response.status_mut() = StatusCode::NOT_FOUND;
            response
        }
    };
    Ok(response)
}

async fn run(args: Args) -> Result<()> {
    if !loopback(args.host) {
        eprintln!("ovis-v2: only a loopback listener is allowed (got {})", args.host);
        process::exit(2);
    }
    let upstream = args.upstream.clone();
    let trace = args.trace.clone();
    let herdr_socket = args.herdr_socket.clone();
    let store = state::Store::load(args.state_path.as_deref().unwrap_or(Path::new("ovis-v2-state.json")));
    let transcripts = args.transcripts.clone();
    let access = Arc::new(access::Access::new(args.token.clone(), args.origins.clone(), args.revoked.clone(), args.trust_proxy));
    let dist = args.dist.canonicalize().unwrap_or_else(|_| args.dist.clone());
    if !dist.is_dir() {
        eprintln!("ovis-v2: --dist {} is not a directory", dist.display());
        process::exit(2);
    }
    if args.test_listen && !cfg!(feature = "test-listen") {
        eprintln!("ovis-v2: --test-listen needs a build with `--features test-listen`");
        process::exit(2);
    }
    let listener = TcpListener::bind(SocketAddr::new(args.host, args.port)).await?;
    let bound = listener.local_addr()?;
    // the validator parses this line to learn the ephemeral port
    println!("listening on http://{}", bound);
    let _ = std::io::stdout().flush();
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let accept = {
        let dist = dist.clone();
        async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _peer) = match accepted {
                            Ok(pair) => pair,
                            Err(error) => {
                                eprintln!("ovis-v2: accept failed: {error}");
                                break;
                            }
                        };
                        let io = TokioIo::new(stream);
                        let dist = dist.clone();
                        let upstream = upstream.clone();
                        let trace = trace.clone();
                        let herdr_socket = herdr_socket.clone();
                        let store = store.clone();
                        let transcripts = transcripts.clone();
                        let access = access.clone();
                        tasks.spawn(async move {
                            let conn = hyper::server::conn::http1::Builder::new()
                                .serve_connection(io, hyper::service::service_fn(move |request| {
                                    let dist = dist.clone();
                                    let upstream = upstream.clone();
                                    let trace = trace.clone();
                                    let herdr_socket = herdr_socket.clone();
                                    let store = store.clone();
                                    let transcripts = transcripts.clone();
                                    let access = access.clone();
                                    async move { serve(dist, upstream, trace, herdr_socket, store, transcripts, access, request).await }
                                }))
                                .with_upgrades();
                            let _ = conn.await;
                        });
                    }
                    _ = stop_rx.changed() => break,
                }
            }
            // graceful exit: in-flight requests get two seconds before the tasks are aborted
            let deadline = tokio::time::sleep(std::time::Duration::from_secs(2));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => { tasks.abort_all(); break; }
                    joined = tasks.join_next() => {
                        if joined.is_none() { break; }
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = accept => {}
        _ = shutdown_signal() => {}
    }
    let _ = stop_tx;
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = interrupt.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let args = parse()?;
    if let Some(socket) = &args.rpc_selftest {
        herdr::selftest(socket).await;
        return Ok(());
    }
    if args.selftest {
        return selftest(args).await;
    }
    run(args).await
}

/// The same assertions the Bun validator makes, from inside the binary: bind, serve, exit.
async fn selftest(args: Args) -> Result<()> {
    let mut args = args;
    args.port = 0;
    let listener = TcpListener::bind(SocketAddr::new(args.host, 0)).await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    println!("selftest port: {port}");
    let _ = std::io::stdout().flush();
    let dist = args.dist.canonicalize().unwrap_or_else(|_| args.dist.clone());
    if !dist.is_dir() {
        eprintln!("ovis-v2: --dist {} is not a directory", dist.display());
        process::exit(2);
    }
    let index = resolve(&dist, "/").expect("index resolves");
    if !index.exists() {
        eprintln!("selftest: {} is missing", index.display());
        process::exit(1);
    }
    println!("selftest ok: serves {} on a loopback listener", index.display());
    Ok(())
}
