//! `/api/session` from herdr itself (T-04): the snapshot is read over the RPC client, never
//! answered by proxying v1, and the fields that name this process are ours.

use std::path::Path;

use serde_json::{json, Value};

use crate::herdr::{Herdr, RpcError};

/// A snapshot with this bridge's own boot marker. The tracker-derived fields (background counts,
/// plans, finish ids) belong to the steps that own those trackers, not to this one.
pub async fn snapshot(socket: &Path, boot_id: &str) -> Result<Value, RpcError> {
    let client = Herdr::new(socket, 10_000);
    let answer = client.call("session", "session.snapshot", "{}").await?;
    let value: Value = serde_json::from_str(&answer).map_err(|error| RpcError::BadFrame(error.to_string()))?;
    // herdr answers {result:{snapshot:{…}}}: do not nest the snapshot a second time
    let snapshot = value.get("result").and_then(|result| result.get("snapshot")).or(value.get("result")).cloned().unwrap_or(value);
    Ok(json!({
        "snapshot": snapshot,
        "finish_epoch": boot_id,
        "served_by": "v2",
    }))
}
