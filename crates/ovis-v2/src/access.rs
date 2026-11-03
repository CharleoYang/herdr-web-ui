//! Admission for HTTP and WS requests (spec T-10 core).
//!
//! A direct loopback peer is trusted. Anything reached through a trusted proxy must carry the
//! token, an allowed Origin and a device that has not been revoked. Forwarding headers from a peer
//! we do not trust are rejected rather than believed.

use std::collections::HashSet;

pub struct Access {
    token: Option<String>,
    origins: HashSet<String>,
    revoked: HashSet<String>,
    trust_proxy: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Reject(&'static str),
}

pub struct Evidence<'a> {
    pub loopback: bool,
    pub forwarded: bool,
    pub token: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub device: Option<&'a str>,
}

impl Access {
    pub fn new(token: Option<String>, origins: Vec<String>, revoked: Vec<String>, trust_proxy: bool) -> Self {
        Self { token, origins: origins.into_iter().collect(), revoked: revoked.into_iter().collect(), trust_proxy }
    }

    pub fn admit(&self, evidence: &Evidence) -> Decision {
        if evidence.device.is_some_and(|device| self.revoked.contains(device)) {
            // a revoked device is refused before any admission owner is named
            return Decision::Reject("device");
        }
        if evidence.forwarded && !self.trust_proxy {
            return Decision::Reject("forwarded");
        }
        let remote = !evidence.loopback || (evidence.forwarded && self.trust_proxy);
        if remote {
            if let Some(expected) = &self.token {
                if evidence.token != Some(expected.as_str()) {
                    return Decision::Reject("token");
                }
            }
        }
        if let Some(origin) = evidence.origin {
            if !self.origins.is_empty() && !self.origins.contains(origin) {
                return Decision::Reject("origin");
            }
        }
        Decision::Allow
    }
}
