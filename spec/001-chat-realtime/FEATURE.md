# Chat conversation and prompt updates push over the existing WebSocket; REST stays authoritative for history and reconnect

## Intent

可见聊天在现有 WebSocket 上收到 conversation 与 prompt 更新后立即显示，不再等 `INVALIDATION_MS`（`src/lib/conversationRefresh.ts`，当前 2000ms）失效冷却，也不再等 `PROMPT_POLL_MS`（`src/components/ChatView.tsx`，当前 2000ms）轮询。断线重连后仍以 REST `/api/pane/conversation` 会话页为准。现有 `conversation-changed` 只带 pane_id 和 opaque signature，REST 分页仍是历史与重连的权威。

## Scope

在内：

- 可选 feature `conversation-delta` 与 `prompt-push`。未声明这些 feature 的旧 bridge 行为不变：仍只靠 `conversation-changed` 加 REST。
- 增量来自现有 conversation 读取，不从 PTY 字节推导 turn。
- 签名不符、缺段、超限时回退 REST。
- `BACKSTOP_MS` 全量对账保留。

在外：

- Electron / Tauri 打包。
- xterm WebGL。
- 替换 5 秒 session roster、设备、usage、worktree 轮询。
- 从 PTY 字节推导聊天 turn。

## Acceptance criteria

目标（`spec/001-chat-realtime/acceptance.json` objective）：可见聊天从现有 WebSocket 应用 conversation 与 prompt 更新，不再依赖 2 秒失效冷却或 2 秒 prompt 轮询；重连后仍与 REST conversation 页一致。

- `push-contract`：conversation 推送契约通过，包括 snapshot 未声明 feature 时不发 delta 或 prompt 帧。测试：`bun test server/conversation-push.contract.test.ts`（`server/conversation-push.contract.test.ts`，超时 120 秒）。
- `client-refresh`：客户端 socket 测试通过。未声明新 feature 的 bridge 仍使用现有 `conversation-changed` 加 REST 节奏。测试：`bun test src/lib/ws.test.ts`（`src/lib/ws.test.ts`，超时 120 秒）。
