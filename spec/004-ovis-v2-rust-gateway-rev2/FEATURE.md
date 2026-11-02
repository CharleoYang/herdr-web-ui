# Ovis v2 rev2: Rust gateway, connection-level ownership, 13 steps

## Intent

Replace the Bun gateway's hot path (WS fan-out, pane attach, conversation reads) with a Rust
service, keeping the server protocol and the React SPA byte-identical. The Rust PTY host already
runs attached terminals here (0.72–0.83 MB per pane against Node's 39.4 MB); this feature is the
gateway around it.

## Scope

- In: a `crates/ovis-v2` binary that serves `dist/`, proxies everything not yet native, and after
  T-08 owns whole WS connections; `/api/session`; output window + PTY ownership; input/keys
  ordering; submit/pending; conversation with ancestry masking; access parity.
- Out (proxied in v2.0): `omo-tasks` and its four sources, `machines/**` (SSH/bridge), push,
  devices, usage, updates, telemetry, portal/relay.
- The public port does not move until T-10 (access parity) + T-08 (connection ownership) + T-09
  (conversation) are green; `OVIS_V2=0` rolls back to v1 at once.

## Acceptance criteria

- `docs/v2-rust-gateway.md` §5: every step's validator fails on HEAD, fails on a wrong
  implementation, and refuses a v1-substituted answer.
- Targets in §1 are treated as unvalidated hypotheses until §9's method measures them; T-12
  reports whole-process-tree RSS, not the Rust PID alone.
- Round-1 review (`local://ovis-v2-review.md`) blocking findings closed before implementation.
