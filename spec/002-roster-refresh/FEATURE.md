# Use the existing machine SSE roster with bounded REST fallback instead of redundant 5-second roster polling

## Intent
Reduce redundant full-roster HTTP reads while the existing machine SSE stream is delivering authoritative snapshots. Keep the existing event channel and stale-response fencing; do not invent a second WebSocket or replace the Bun bridge.

Predecessor: `spec-001-chat-realtime` remains a separate delivery/real-browser gate. This feature owns only roster-refresh policy and its regression proof; developing it in a disjoint worktree does not claim the predecessor is released.


## Scope
In scope:
- After the first valid `machines` snapshot on the current SSE connection, suppress the browser's redundant five-second roster GET cadence; retain a bounded authoritative REST backstop of at most 30 seconds while visible.
- Before that snapshot, after SSE error/reconnect, and with SSE unavailable, retain the existing five-second REST fallback. A mere TCP/EventSource open is not proof a complete roster was received.
- Force a fresh read on visibility restore and explicit roster-changing actions. Preserve `SnapshotRequests` invalidation so older responses cannot overwrite newer events or requests.
- Keep health/auth polling on its current cadence, pause background reads as today, and preserve multi-PC identity, selection, status, alerts and preference behavior.
- Add a focused real-browser regression using the actual App and Bun bridge in an isolated, test-owned environment. Network delays/outages may be controlled; API response payloads must not be replaced with fabricated success.

Out of scope: changing server/SSH discovery cadence, device/usage/worktree polls, chat conversation or prompt transport, WebGL, Electron/Tauri, and broader UI restyling.


## Acceptance criteria
- Healthy-stream case: after a current valid full snapshot, no redundant five-second roster GET; an authoritative REST backstop still occurs within 30 seconds while visible. Health/auth requests continue independently.
- Fallback controls: unavailable stream and open-without-initial-snapshot retain five-second roster reads; an error after a healthy stream returns to fallback and a later valid snapshot restores event-led operation.
- Recovery and ordering: visibility restore and explicit changes force reads; stale HTTP success/failure cannot overwrite newer SSE/status state; reconnect cannot reuse the previous connection's healthy baseline.
- User-visible roster changes and pane status remain correct in the real browser, with no introduced console/network errors. A hidden page does not keep polling.
- Regression: `bun test src/lib/snapshotRequests.test.ts src/lib/snapshot.test.ts`, `bun run typecheck`, `bun run build`, and `bun scripts/roster-refresh-browser-qa.ts` pass in independent QA. The new browser command must start/use a real isolated bridge, drive real Chromium, assert the request/transition matrix, and retain screenshots plus network/console evidence; an offline harness is not browser PASS.
- Main does not execute validation. Development and source review use `tokens/gpt-6.1-sol`; QA uses `mcli/deepseek-v4.1-flash`. User delegated design/implementation/integration decisions on 2026-10-16 and requires a report on takeover.
