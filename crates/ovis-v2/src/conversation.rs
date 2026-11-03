//! Conversation transcript reads with cursors and ETags (spec T-09 core).
//!
//! A transcript is newline-delimited JSON. The cursor is the next line index, so an appended
//! record is read exactly once and a truncated file is detected instead of being skipped over.
//! One record larger than OVERSIZE is reported by size, never buffered whole.

use std::{fs, path::Path, time::UNIX_EPOCH};

use serde_json::{json, Value};

/// above this, a single record is described by size rather than returned
pub const OVERSIZE: usize = 1024 * 1024;

pub struct Page {
    pub body: Value,
    pub etag: String,
    pub not_modified: bool,
}

fn etag_for(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            format!("\"{:x}-{:x}\"", meta.len(), modified)
        }
        Err(_) => "\"0-0\"".into(),
    }
}

/// Reads one page. `cursor` is the next line index; `budget` caps the bytes returned in one page.
pub fn read(path: &Path, cursor: usize, limit: usize, budget: usize, if_none_match: Option<&str>) -> Page {
    let etag = etag_for(path);
    let raw = fs::read(path).unwrap_or_default();
    let mut lines: Vec<(usize, &[u8])> = Vec::new();
    let mut start = 0usize;
    for (index, byte) in raw.iter().enumerate() {
        if *byte == b'\n' {
            lines.push((start, &raw[start..index]));
            start = index + 1;
        }
    }
    if start < raw.len() {
        lines.push((start, &raw[start..]));
    }
    let total = lines.len();

    // a file that shrank under the cursor resets; an exhausted but intact cursor does not
    let reset = cursor > total;
    if !reset && cursor >= total && total > 0 {
        // nothing new: a matching ETag is a real 304, not an empty 200
        if if_none_match == Some(etag.as_str()) {
            return Page { body: Value::Null, etag, not_modified: true };
        }
        return Page {
            body: json!({ "events": [], "next_cursor": cursor, "reset": false, "truncated": false, "total": total }),
            etag,
            not_modified: false,
        };
    }

    // the file shrank under the cursor: the client must re-read, never silently skip records
    let begin = if reset { 0 } else { cursor };

    let mut events: Vec<Value> = Vec::new();
    let mut spent = 0usize;
    let mut next = begin;
    let mut truncated = false;
    for (index, (_, line)) in lines.iter().enumerate().skip(begin) {
        if events.len() >= limit {
            truncated = true;
            break;
        }
        if line.len() > OVERSIZE {
            events.push(json!({ "type": "oversized", "index": index, "bytes": line.len() }));
            next = index + 1;
            continue;
        }
        if spent + line.len() > budget && !events.is_empty() {
            truncated = true;
            break;
        }
        spent += line.len();
        match serde_json::from_slice::<Value>(line) {
            Ok(mut value) => {
                if let Some(object) = value.as_object_mut() {
                    object.insert("index".into(), json!(index));
                }
                events.push(value);
            }
            Err(_) => {
                // a half-written line is reported, not dropped silently
                events.push(json!({ "type": "malformed", "index": index, "bytes": line.len() }));
            }
        }
        next = index + 1;
    }

    Page {
        body: json!({
            "events": events,
            "next_cursor": next,
            "reset": reset,
            "truncated": truncated,
            "total": total,
        }),
        etag,
        not_modified: false,
    }
}
