//! The loopback HTTP proxy (T-02): every route the gateway does not own natively is forwarded to
//! v1, byte for byte, and streams are never buffered. v1 stays the public entry until T-11.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{body::Incoming, Request, Response, StatusCode, Uri};
use hyper_util::{client::legacy::{connect::HttpConnector, Client}, rt::TokioExecutor};

/// The parts of a request that belong to the connection, not to the application, are not forwarded.
fn hop(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization" | "te" | "trailer"
            | "transfer-encoding" | "upgrade" | "host" | "content-length")
}

pub struct Proxy {
    client: Client<HttpConnector, http_body_util::combinators::BoxBody<Bytes, hyper::Error>>,
    upstream: Arc<str>,
}

pub type BoxedBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

impl Proxy {
    pub fn new(upstream: Arc<str>) -> Self {
        let connector = HttpConnector::new();
        let client = Client::builder(TokioExecutor::new()).build(connector);
        Self { client, upstream }
    }

    /// Forwards one request to v1, streaming the response back without collecting it.
    pub async fn forward(&self, request: Request<Incoming>) -> Result<Response<BoxedBody>, StatusCode> {
        let (parts, body) = request.into_parts();
        let path = parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
        let uri: Uri = format!("{}{}", self.upstream.trim_end_matches('/'), path)
            .parse()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut builder = Request::builder().method(parts.method).uri(uri);
        {
            let headers = builder.headers_mut().expect("headers");
            for (name, value) in parts.headers.iter() {
                if hop(name.as_str()) {
                    continue;
                }
                headers.insert(name, value.clone());
            }
        }
        let forwarded = builder.body(body.boxed()).map_err(|_| StatusCode::BAD_REQUEST)?;
        let response = self.client.request(forwarded).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        let (parts, body) = response.into_parts();
        let mut response = Response::new(body.boxed());
        {
            let headers = response.headers_mut();
            for (name, value) in parts.headers.iter() {
                if hop(name.as_str()) {
                    continue;
                }
                headers.insert(name, value.clone());
            }
        }
        *response.status_mut() = parts.status;
        Ok(response)
    }
}

/// A 502 with a reason, not a fabricated success, when v1 cannot be reached.
pub fn unavailable() -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(b"upstream unavailable\n")));
    *response.status_mut() = StatusCode::BAD_GATEWAY;
    response
}
