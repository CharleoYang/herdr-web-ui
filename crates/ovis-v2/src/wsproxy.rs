//! Raw upgrade proxy: WebSockets are forwarded to the upstream as bytes (spec T-08's remote
//! whole-connection hop). v2 never speaks the protocol, so compression, extensions and any
//! subprotocol stay exactly the upstream's.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{body::Incoming, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub type Out = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

/// `http://host:port` -> ("host", port). Only plain hosts: the proxy never invents TLS.
fn authority(upstream: &str) -> Option<(String, u16)> {
    let rest = upstream.strip_prefix("http://").or_else(|| upstream.strip_prefix("https://"))?;
    let rest = rest.trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (host.to_string(), port.parse().ok()?),
        None => (rest.to_string(), 80),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port))
}

fn head(request: &Request<Incoming>, authority: &str) -> Option<Vec<u8>> {
    // v2 already admitted the browser's Origin; the upstream must see its own origin or it 403s
    let origin = format!("http://{authority}");
    let path = request.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let mut out = format!("{} {} HTTP/1.1\r\n", request.method(), path).into_bytes();
    for (name, value) in request.headers().iter() {
        // Host belongs to the upstream; every other header (upgrade, sec-websocket-*, cookie,
        // origin, authorization) is the client's and is forwarded unchanged
        let name_text = name.as_str();
        if name_text.eq_ignore_ascii_case("host") {
            continue;
        }
        if name_text.eq_ignore_ascii_case("origin") {
            out.extend_from_slice(b"origin: ");
            out.extend_from_slice(origin.as_bytes());
            out.extend_from_slice(b"\r\n");
            continue;
        }
        out.extend_from_slice(name_text.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("host: {authority}\r\n\r\n").as_bytes());
    Some(out)
}

fn status_of(head: &[u8]) -> Option<StatusCode> {
    let text = std::str::from_utf8(head).ok()?;
    let line = text.lines().next()?;
    let code = line.split_whitespace().nth(1)?;
    StatusCode::from_bytes(code.as_bytes()).ok()
}

/// Forwards an upgrade request. A 101 is answered only after the upstream really switched.
pub async fn proxy_upgrade(request: Request<Incoming>, upstream: &str) -> Result<Response<Out>, StatusCode> {
    let (host, port) = authority(upstream).ok_or(StatusCode::BAD_GATEWAY)?;
    let mut stream = TcpStream::connect((host.as_str(), port)).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let request_head = head(&request, &format!("{host}:{port}")).ok_or(StatusCode::BAD_REQUEST)?;
    if std::env::var_os("OVIS_V2_DEBUG_WS").is_some() {
        eprintln!("wsproxy head: {}", String::from_utf8_lossy(&request_head).replace("\r\n", " | "));
    }
    stream.write_all(&request_head).await.map_err(|_| StatusCode::BAD_GATEWAY)?;

    // read the upstream's response head only: anything after it belongs to the switched protocol
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > 64 * 1024 {
            return Err(StatusCode::BAD_GATEWAY);
        }
        let read = stream.read(&mut chunk).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if read == 0 {
            return Err(StatusCode::BAD_GATEWAY);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    if std::env::var_os("OVIS_V2_DEBUG_WS").is_some() {
        eprintln!("wsproxy answer: {}", String::from_utf8_lossy(&buffer[..head_end]).replace("\r\n", " | "));
    }
    let head_bytes = buffer[..head_end].to_vec();
    let leftover = buffer[head_end..].to_vec();
    let status = status_of(&head_bytes).ok_or(StatusCode::BAD_GATEWAY)?;

    if status != StatusCode::SWITCHING_PROTOCOLS {
        // not a switch: hand the upstream's answer back as it is, body included
        let mut body = leftover;
        let mut rest = Vec::new();
        if stream.read_to_end(&mut rest).await.is_ok() {
            body.extend_from_slice(&rest);
        }
        let mut response = Response::new(Full::new(Bytes::from(body)).map_err(|never: std::convert::Infallible| match never {}).boxed());
        *response.status_mut() = status;
        if let Ok(text) = std::str::from_utf8(&head_bytes) {
            for line in text.lines().skip(1) {
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("transfer-encoding") {
                        continue;
                    }
                    if let (Ok(name), Ok(value)) = (name.trim().parse::<hyper::header::HeaderName>(), value.trim().parse::<hyper::header::HeaderValue>()) {
                        response.headers_mut().append(name, value);
                    }
                }
            }
        }
        return Ok(response);
    }

    // the client's upgrade resolves only once this 101 has been sent, so take the future first
    let upgraded = hyper::upgrade::on(request);
    tokio::spawn(async move {
        let Ok(upgraded) = upgraded.await else {
            return;
        };
        let mut client = TokioIo::new(upgraded);
        if !leftover.is_empty() && client.write_all(&leftover).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut stream).await;
        let _ = client.shutdown().await;
    });

    let mut response = Response::new(Full::new(Bytes::new()).map_err(|never: std::convert::Infallible| match never {}).boxed());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    if let Ok(text) = std::str::from_utf8(&head_bytes) {
        for line in text.lines().skip(1) {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("transfer-encoding") {
                    continue;
                }
                if let (Ok(name), Ok(value)) = (name.trim().parse::<hyper::header::HeaderName>(), value.trim().parse::<hyper::header::HeaderValue>()) {
                    response.headers_mut().append(name, value);
                }
            }
        }
    }
    Ok(response)
}
