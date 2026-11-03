# Decisions — Ovis v2 rev2: Rust gateway, connection-level ownership, 13 steps

| ID | Decision | Evidence | Owner | Date |
| --- | --- | --- | --- | --- |

- 2026-11-03 用户裁定：今后对计划的 review **不做措辞级过度较真**（术语、句式、行文风格不作为阻断项）。评审只针对会被代码证伪的事实、契约缺口、无法判别的判据与无法回退的路径。

## T-08 前置：v1 lease / pending 语义核对（2026-11-03，读自 server/core/pending.ts）

交接状态机必须照 v1 的真实语义实现，不得按我们的简化模型臆造：

1. **Lease = { sighting, authority }**，且**每一步都重新授权**：`authorizePending` 要求
   `pendingAuthorities.get(owner)?.get(paneId) === lease.authority`，否则抛 `pending_lease_lost`
   （pending.ts:352-399）。attachment 或回到 interact 不得复活已捕获的 lease（:357）。
2. **状态**：`queued` → `sending` → `done | uncertain`；`held` 是挂起待审。故障时对 `queued`
   与多数 `held` 重新 hold，但 `pending_target_changed` / `launch_gone` 除外（pending.ts:157-160）。
   我当前 store 只有 queued/sending/done/uncertain，**缺 held 与 rehold 规则**。
3. **首消息 lease 按次获取、不保留**（pending.ts:54），可重试错误码集合为
   `{input_not_ready, pending_lease_lost, disconnected, read_only}`（:59）。
4. **secret prompt 拒绝写入**（pending.ts:521）。
5. **回执身份是 slot token**，失效与迟到确认不得重复释放（pending.ts:206-208）。
6. 写入在 lease、deadline 或 pane 状态中途变化时被拒（pending.ts:683）。

另：v1 的 pending 输入**只在内存**，`server/pending-input.ts` 与 `server/core/**` 均无落盘
（grep 无 writeFile/readFile 持久化）。因此 "v1 持久导入" 只能是 T-08 在线交接时的导出，
不存在可读取的 v1 状态文件格式；不实现文件导入器。

