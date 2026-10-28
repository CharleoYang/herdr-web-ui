# Context report — chat realtime (current code only)

S1 已关闭。需求在 `spec/001-chat-realtime/FEATURE.md`。冻结任务 T-01..T-05 在 `spec/001-chat-realtime/task.md`。本报告只记录这些路径上的现状，不提出新帧或新 feature。

## Protocol

`shared/protocol.ts`

- `ServerFeature`（约 1179 行）现为 `"submit" | "pending-input" | "pending-hold" | "secret-input" | "input-ready" | "take-over" | "watch" | "conversation-watch" | "ping"`。没有 `conversation-delta`，没有 `prompt-push`。
- `ServerMessage`（约 1208–1209 行）的 `conversation-changed` 只有 `pane_id` 和 opaque `signature`。注释写明 signature 不是 REST ETag，客户端应重拉现有 conversation 端点。
- 同文件注释（约 194 行）里 `GET /api/pane/prompt?pane_id=` 的正文是 `{ prompt: InteractivePrompt | null, suggestion: string | null, restored: string | null }`。`InteractivePrompt` 约 1009 行。
- `GET /api/pane/conversation` 的 `ConversationResponse`（约 588 行）带 `source`、`turns`、可选 `history_id`、`cursor`、`metadata`。分页 `before` / `from` 与 409 `history_changed` 都在这条 REST 上。
- 客户端已有 `conversation-watch { pane_id, enabled }`（约 1117–1119 行）。注释：需要 `"conversation-watch"` 和一次 attachment；detach 清掉 interest；REST 仍是权威。

`server/index.ts`

- `SERVER_FEATURES`（约 227 行）与上面的 `ServerFeature` 字面量相同，首帧 `snapshot.features` 发出这份列表（约 2858 行）。
- `conversation-watch`（约 3014–3029 行）：`enabled` 时必须已经 attach，然后 `conversationInterests.add` 并 `conversations.watch`；否则 `not_attached`。`enabled: false` 删掉 interest，无人再感兴趣则 `unwatch`。

## Server push

`server/conversation-monitor.ts`

- `ConversationMonitor` 是本机 stat 循环，不是 turn 解析器。`STAT_INTERVAL_MS = 250`，`RESOLVE_INTERVAL_MS = 5000`，`MISSING_RESOLVE_INTERVAL_MS = 2000`。
- `publish`（约 70–74 行）在 observed 字符串变化时，用 salt + paneId + observed 做 sha256，base64url 截 22 字符，回调 `(paneId, signature)`。
- `read` 只基于定位到的 transcript 路径、session、文件及 WAL 的 stat 身份组装观察值；这里的定位解析不是 turn 解析，不产出 conversation 页或 turns，也不读 PTY 字节。

`server/index.ts` 约 541–546 行：该回调只给同时满足 `!closing`、`WebSocket.OPEN`、`attached.has(paneId)`、`conversationInterests.has(paneId)` 的连接发 `{ type: "conversation-changed", pane_id, signature }`。未 attach 或未 watch 的连接收不到。

## Client refresh

`src/lib/conversationRefresh.ts`

- `BACKSTOP_MS = 10_000`。有 push 时，丢失的推送仍靠这次全量 conversation 读取对账。
- `INVALIDATION_MS = 2000`。没有 push 的 chat（旧 bridge，或放开 pane 的 tab）按这个间隔读。有 push 时，后续 invalidate 也不会快过这 2 秒：`drain`（约 103 行）在 `newestAt + INVALIDATION_MS` 之前直接停；`invalidate` 若落在窗口内，则把定时器设到该窗口末尾（约 113–117 行）。
- `setPushes(true)` 时 backstop 用 `BACKSTOP_MS`，否则用 `INVALIDATION_MS`（约 83–84 行）。
- `page()` 只排队更老的一页，不把历史翻页变成推送。

`src/components/ChatView.tsx`

- `PROMPT_POLL_MS = 2000`（约 90 行）。可见、已连接、未结束且有 agent 时，`readPrompt` 在 `finally` 里再次 `setTimeout(..., PROMPT_POLL_MS)`（约 1145–1171 行），读 `GET /api/pane/prompt`。
- `invalidationKey` 变化且 pane 未换、chat 可见时，只调用 `conversationRefresh.invalidate()`（约 1060–1064 行）。不直接改 turns。
- 更老的一页仍是 `fetchPaneConversation(paneId, { before })`（约 1090–1100 行）。
- 重连且可见时 `conversationRefresh.refresh()`（约 1077–1087 行），走 REST。

`src/components/PaneTerminal.tsx` 约 1129–1132 行：收到本 pane 的 `conversation-changed`，且 chat 还在、页面不是 hidden，只 `setChatInvalidation((current) => current + 1)`。没有别的 conversation 帧可处理。

## 明确不在现有实现里

- 没有从 PTY 字节推导聊天 turn 的推送路径。scrollback 聊天用终端输出触发同一次 `invalidate()`（`ChatView.tsx` 约 1069–1074 行），仍受 `INVALIDATION_MS` 约束。
- 5 秒 session roster、设备、usage、worktree 轮询不在这条 conversation / prompt 链上。
- Electron、Tauri、xterm WebGL 不在 `FEATURE.md` 范围内，本报告未查打包层。
