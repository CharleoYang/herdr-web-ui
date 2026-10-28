# Decisions — Use the existing machine SSE roster with bounded REST fallback instead of redundant 5-second roster polling

| ID | Decision | Evidence | Owner | Date |
| --- | --- | --- | --- | --- |
| R-01 | Reuse the current machine SSE channel; do not add WebSocket roster transport | `src/App.tsx:559-625`; `server/machine-api.ts:43-74`; `server/machines.ts:295-303` | Main, under user delegation | 2026-10-16 |
| R-02 | Stream health requires a valid complete snapshot from the current connection; keep five-second fallback and bounded REST backstop | Existing SSE subscribe supplies an initial snapshot; App already fences older reads via `SnapshotRequests` | Main, under user delegation | 2026-10-16 |
| R-03 | Keep health/auth and server discovery unchanged; scope only redundant browser roster reads | `src/App.tsx:453-482`; `server/machines.ts:189,765` | Main, under user delegation | 2026-10-16 |
| R-04 | Separate source review from real QA; no Main-flow test execution | Explicit user model split and real-browser release requirement, 2026-10-16 | User | 2026-10-16 |
| R-05 | 已评审字节通过平台 PR 合入隔离集成分支，再在实际合并提交独立验证；不把源码 PASS 或原作者临时观测代替真实 QA | PR #3 merge `393928e7dbe791b2de2c0732f33fd5668720eba1`；合并后 mcli 8/0、类型/构建通过、真实浏览器 7/7 | Main | 2026-10-16 |
| R-06 | Native Goal criterion 使用注册主树；保留 pre-cutover 验收失败，待 canonical 真正交付后再由 QA 完成 Goal；不改 registry、临时绝对路径判据或伪造 PASS | `/tmp/roster-refresh-postmerge-mcli/goal-acceptance.md`；LoopX cwd 源码证据，原环境丢失推断已撤回 | Main | 2026-10-16 |
