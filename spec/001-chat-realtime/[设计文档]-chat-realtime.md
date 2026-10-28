# 设计文档 — chat realtime

需求：`spec/001-chat-realtime/FEATURE.md`。任务边界：`spec/001-chat-realtime/task.md` 的 T-01..T-05，本文不改那张表。现状：`spec/001-chat-realtime/context-report.md`。

## 保留 REST 权威

`GET /api/pane/conversation` 继续是历史页、重连后的最新页、以及任何对不上的推送的权威。REST 页不携带 monitor signature；`conversation-changed.signature` 是 `ConversationMonitor` 的 opaque 值，不是 REST ETag（`shared/protocol.ts`）。分页 `before` / `from`、409 `history_changed`、scrollback 没有 native 文件，这些语义仍由 REST 负责。

因此：

- 历史翻页只走 REST。`ConversationRefresh.page()` 的语义不变。
- 断线重连、隐藏恢复和 REST 对账时，清空已接受 delta 的 monitor signature；REST 读取期间丢弃 delta，不缓存、不在 REST 完成后回放。REST 返回后，下一帧只有自包含完整最新页才可接受，以整页替换建立新的推送基线，不能拿 REST 页或 `conversation-changed` 的通知签名来证明基线。
- `conversation-delta.delta.turns` 是当前最新一页的完整替换，不是 turn 补丁。不按 role 追加，不按最后一项覆盖，不覆盖已加载的历史页。签名链不符、缺段、乱序、读不出一整页或 payload 超过 256 KiB：不发 delta，只发原有 `conversation-changed`，客户端走现有 `invalidate()`，再读 REST。不存在部分 delta 或截断后的中间态。

## 最新页与两套签名状态

- 客户端已有 `signature.current` 是 `JSON.stringify` 内容摘要，只用于已有的内容比较。另存「本连接、本 pane 最后接受的 delta 的 opaque signature」；二者独立，不能互相转换或互相证明。`conversation-changed.signature` 只触发失效，不能提前更新已接受 delta 的签名。
- 有已接受的 monitor 基线时，非 null 的 `base_signature` 必须与它相等；否则整帧丢弃并 invalidate。重复的当前 signature 不再应用。没有基线（包括 REST 之后）时，只能通过完整最新页替换建立基线；即使帧带非 null 的前帧签名，也不宣称它已与 REST 核对。
- `base_signature: null` 只表示没有可核对的上一帧，只允许用于自包含整页替换；它不证明 REST 内容相同，更不允许「跳过比较后按补丁合并」。本协议所有 delta 都是整页替换，没有 patch 模式。
- `source` / `history_id` 与当前 REST 页不匹配时回 REST；可选字段缺省表示本页没有该值，不能继承上一帧。最新页的 `cursor` 可随页首移动，随整页替换；若已加载历史且 cursor 改变，不能据此证明历史衔接，丢弃 delta 并交回现有 REST 分页/缺口处理。历史翻页仍只走 REST。详细规则见接口文档「完整性、顺序与回退」。

## monitor 与 conversation reader

`ConversationMonitor` 只定位 transcript 并做 stat，产出 pane 与 opaque signature，不读取或解析 turns。signature 变化后，由服务端调用现有 conversation reader 读取最新完整一页，不从 PTY 字节推导 turn。

同一 pane 的读页与发布串行化；读取前后重新核对该次观察对应的 transcript 定位和 stat 身份，并确认期间没有更新的 monitor 观察。读失败、读到缺段、观察变化、结果乱序或无法确认整页时，丢弃该次页结果，只保留 `conversation-changed`，不能把旧读取结果贴上新 signature。stat 核对是服务端读取一致性门，不把 opaque signature 变成内容摘要或 REST ETag。

完整性门通过后，序列化整个 `conversation-delta` 消息并计算 UTF-8 字节数，最大 256 KiB（262144 字节，等于上限可发）。超过上限只发 `conversation-changed`，不截断、不拆分 turns、不发送中间页。发送与客户端接受规则统一见接口文档。

## 保留 BACKSTOP_MS

`src/lib/conversationRefresh.ts` 里 `BACKSTOP_MS = 10000`。有 push 时它是丢失推送后的全量 REST 对账，不是可以删掉的轮询。新 feature 只去掉「每次变化都被 `INVALIDATION_MS`（2000）挡住」这一条。丢帧、半开连接、隐藏页恢复，仍靠这 10 秒全量读取把最新页拉回 REST。

无 `conversation-delta` 时行为不变：backstop 就是现在的 2 秒读取（`setPushes` 为 false 时 `backstop()` 返回 `INVALIDATION_MS`）。`invalidate()` 本身也不会快过 2 秒。要立刻并入最新页，只能走新的 delta 路径，不能把 `invalidate()` 改成 0。

## 新 feature 可选

`conversation-delta` 与 `prompt-push` 是新的 `ServerFeature` 字面量，只出现在实现了对应发送路径的 snapshot 里。类型存在不等于广告。

- snapshot 的 `features` 没有 `conversation-delta`：服务端不发 `conversation-delta`。客户端仍把 `conversation-changed` 变成 `invalidationKey`，`ChatView` 仍 `invalidate()`，节奏仍是 `INVALIDATION_MS`。
- snapshot 没有 `prompt-push`：不发 `prompt-push`。可见聊天继续 `PROMPT_POLL_MS`（`ChatView.tsx`，2000）读 `GET /api/pane/prompt`。
- 旧 bridge 不列这两个字面量。已有 `conversation-watch` 门不变：未 attach 或 `conversationInterests` 不含该 pane 的连接，收不到 conversation 帧。

## 失败回退

| 情况 | 服务端 | 客户端 |
| --- | --- | --- |
| 未声明 feature | 不发新帧 | REST，2 秒节奏不变 |
| 缺段、乱序、读不出一整页，或完整消息超过 256 KiB | 不发 delta，只发 `conversation-changed` | 现有 `invalidate()`，再 REST；不应用部分页 |
| 非 null base 与已接受的 monitor signature 不符 | 不发送已知乱序结果；客户端仍防御检查 | 丢弃整帧，清空推送基线并 `invalidate()` |
| 页面 hidden、REST 读取中，或不是当前最新页 | 不要求服务端知道可见性 | 丢弃 delta，不缓存；恢复后先 REST |
| prompt 无 feature、断线、或隐藏后恢复 | 无帧或不完整 | 读一次 REST prompt，不恢复 2 秒空转除非仍无 feature |
| 丢失的 delta | 不补历史帧 | `BACKSTOP_MS` 全量 REST |

delta 只来自 monitor 通知后调用的现有 conversation reader 的完整最新页；monitor 本身没有解析好的 turns。prompt 状态只来自现有 `GET /api/pane/prompt` 那次读取的结果，不另做一套菜单解析。

不改：Electron、Tauri、WebGL，以及 5 秒 session roster、设备、usage、worktree 轮询。

## 任务切分

T-01 先钉协议（feature 字面量、`ServerMessage`、未声明 snapshot 不发新帧、`conversation-changed` 语义不变）。T-01 未完成时，下面三条都不领取。

T-01 之后三条并行，互不写对方的文件所有权：

- T-02 服务端：已声明 `conversation-delta` 且该连接已 conversation-watch 时，monitor signature 变化后调用现有 reader，核对观察一致性，在现有 signature 推送之外发完整最新页替换。缺段、乱序、读不全或超过 256 KiB，只留 `conversation-changed`。
- T-03 客户端：本 pane 的 `conversation-delta` 立即整页替换当前最新页，不按 role 追加或按末项覆盖，不等 `INVALIDATION_MS`。两套 signature 独立；重连、隐藏恢复、REST 对账清空 monitor 基线，读 REST 期间丢帧，之后只接受自包含整页。对不上就 `invalidate()`。`BACKSTOP_MS` 保留。无 feature 仍 2 秒 REST。与 T-02 并行。
- T-04 prompt：已声明 `prompt-push` 时，出现、变化、消失走 WebSocket，可见聊天停掉 `PROMPT_POLL_MS`。无 feature、断线或隐藏恢复后仍读一次 REST。与 T-02、T-03 并行。

T-05 合流，依赖 T-02、T-03、T-04 都落地之后：旧 bridge 仍只有 `conversation-changed` 加 REST；新 feature 下一次 transcript 变化不被 2 秒冷却挡住；prompt 不再 2 秒空转；重连后 REST 页与推送页一致。只跑受影响测试。

S2 不实现上述任务，不签 S2-H / S5-H，不开始 S2-R。
