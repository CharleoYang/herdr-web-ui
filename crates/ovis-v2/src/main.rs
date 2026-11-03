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
mod proxy;
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

const USAGE: &str = "usage: ovis-v2 --dist <dir> [--port <n>] [--host 127.0.0.1] [--selftest] [--test-listen]";

struct Args {
    dist: PathBuf,
    port: u16,
    host: IpAddr,
    selftest: bool,
    test_listen: bool,
    upstream: Option<Arc<str>>,
    trace: Option<PathBuf>,
}

fn parse() -> Result<Args> {
    let mut dist = PathBuf::from("dist");
    let mut port: u16 = 7414;
    let mut host: IpAddr = "127.0.0.1".parse()?;
    let mut selftest = false;
    let mut test_listen = false;
    let mut upstream: Option<Arc<str>> = None;
    let mut trace: Option<PathBuf> = None;
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
    Ok(Args { dist, port, host, selftest, test_listen, upstream, trace })
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

async fn serve(dist: PathBuf, upstream: Option<Arc<str>>, trace: Option<PathBuf>, request: Request<Incoming>) -> std::result::Result<Response<Out>, Infallible> {
    let path = request.uri().path();
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
                        tasks.spawn(async move {
                            let conn = hyper::server::conn::http1::Builder::new()
                                .serve_connection(io, hyper::service::service_fn(move |request| {
                                    let dist = dist.clone();
                                    let upstream = upstream.clone();
                                    let trace = trace.clone();
                                    async move { serve(dist, upstream, trace, request).await }
                                }));
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
