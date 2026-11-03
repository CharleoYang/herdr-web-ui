//! Native pane reads (T-04b): `read` and `scroll` are single herdr calls. `find`, `selection` and
//! `plan` are composed of reads and stay proxied until their step lands.

use std::path::Path;

use serde_json::Value;

use crate::herdr::{Herdr, RpcError};

/// The response v1's /api/pane/read returns: `{read:{...}}`.
pub async fn read(socket: &Path, pane: &str, source: &str, format: &str) -> Result<Value, RpcError> {
    let client = Herdr::new(socket, 10_000);
    let params = format!("{{\"pane_id\":\"{pane}\",\"source\":\"{source}\",\"format\":\"{format}\"}}");
    let answer = client.call("pane.read", "pane.read", &params).await?;
    let value: Value = serde_json::from_str(&answer).map_err(|error| RpcError::BadFrame(error.to_string()))?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

/// `pane.scroll_info` for GET, `pane.scroll` for POST with an offset.
pub async fn scroll_info(socket: &Path, pane: &str) -> Result<Value, RpcError> {
    let client = Herdr::new(socket, 10_000);
    let params = format!("{{\"pane_id\":\"{pane}\"}}");
    let answer = client.call("pane.scroll_info", "pane.scroll_info", &params).await?;
    let value: Value = serde_json::from_str(&answer).map_err(|error| RpcError::BadFrame(error.to_string()))?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

pub async fn scroll(socket: &Path, pane: &str, offset: u64) -> Result<Value, RpcError> {
    let client = Herdr::new(socket, 10_000);
    let params = format!("{{\"pane_id\":\"{pane}\",\"offset_from_bottom\":{offset}}}");
    let answer = client.call("pane.scroll", "pane.scroll", &params).await?;
    let value: Value = serde_json::from_str(&answer).map_err(|error| RpcError::BadFrame(error.to_string()))?;
    Ok(value.get("result").cloned().unwrap_or(value))
}
