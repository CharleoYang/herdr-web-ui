//! Pending input and composer drafts with durable recovery (spec T-07 core).
//!
//! The store is a single JSON document, written atomically. An item left in `sending` when the
//! process dies is recovered as `uncertain`: the write may or may not have landed, and claiming
//! `done` would lose that distinction.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct PendingItem {
    pub id: String,
    pub pane_id: String,
    pub text: String,
    pub state: String,
}

#[derive(Default)]
struct State {
    pending: Vec<PendingItem>,
    drafts: HashMap<String, String>,
    next_id: u64,
}

pub struct Store {
    path: PathBuf,
    state: Mutex<State>,
}

impl Store {
    /// Loads the state file if it exists. Anything caught mid-send becomes `uncertain`.
    pub fn load(path: &Path) -> Arc<Self> {
        let mut state = State::default();
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                state.next_id = value.get("next_id").and_then(Value::as_u64).unwrap_or(1);
                if let Some(items) = value.get("pending").and_then(Value::as_array) {
                    for item in items {
                        let mut status = item.get("state").and_then(Value::as_str).unwrap_or("queued").to_string();
                        if status == "sending" {
                            status = "uncertain".into();
                        }
                        state.pending.push(PendingItem {
                            id: item.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                            pane_id: item.get("pane_id").and_then(Value::as_str).unwrap_or_default().to_string(),
                            text: item.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
                            state: status,
                        });
                    }
                }
                if let Some(drafts) = value.get("drafts").and_then(Value::as_object) {
                    for (pane, text) in drafts {
                        if let Some(text) = text.as_str() {
                            state.drafts.insert(pane.clone(), text.to_string());
                        }
                    }
                }
            }
        }
        if state.next_id == 0 {
            state.next_id = 1;
        }
        Arc::new(Self { path: path.to_path_buf(), state: Mutex::new(state) })
    }

    fn snapshot(state: &State) -> Value {
        json!({
            "next_id": state.next_id,
            "pending": state.pending.iter().map(|item| json!({
                "id": item.id, "pane_id": item.pane_id, "text": item.text, "state": item.state,
            })).collect::<Vec<_>>(),
            "drafts": state.drafts,
        })
    }

    /// Atomic write: a crash must never leave a half-written state file.
    fn persist(&self, state: &State) {
        let tmp = self.path.with_extension("tmp");
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&tmp, serde_json::to_string(&Self::snapshot(state)).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    pub fn submit(&self, pane_id: &str, text: &str) -> String {
        let mut state = self.state.lock().unwrap();
        let id = format!("p{}", state.next_id);
        state.next_id += 1;
        state.pending.push(PendingItem { id: id.clone(), pane_id: pane_id.into(), text: text.into(), state: "queued".into() });
        self.persist(&state);
        id
    }

    pub fn resolve(&self, id: &str, outcome: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(item) = state.pending.iter_mut().find(|item| item.id == id) else {
            return false;
        };
        item.state = outcome.into();
        self.persist(&state);
        true
    }

    pub fn list(&self, pane_id: Option<&str>) -> Vec<PendingItem> {
        let state = self.state.lock().unwrap();
        state.pending.iter()
            .filter(|item| pane_id.map_or(true, |pane| item.pane_id == pane))
            .cloned()
            .collect()
    }

    pub fn set_draft(&self, pane_id: &str, draft: &str) {
        let mut state = self.state.lock().unwrap();
        state.drafts.insert(pane_id.into(), draft.into());
        self.persist(&state);
    }

    pub fn draft(&self, pane_id: &str) -> String {
        self.state.lock().unwrap().drafts.get(pane_id).cloned().unwrap_or_default()
    }

    pub fn export(&self) -> String {
        let state = self.state.lock().unwrap();
        serde_json::to_string(&Self::snapshot(&state)).unwrap_or_default()
    }
}
