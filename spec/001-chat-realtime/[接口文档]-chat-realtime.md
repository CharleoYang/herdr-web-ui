# 接口文档 — chat realtime

范围是 T-01 可冻结的类型与发送/接受合同。发送条件的实现归 T-02 / T-04，最新页替换归 T-03。不改 `shared/protocol.ts` 的现有成员语义。

## ServerFeature

在 `shared/protocol.ts` 的 `ServerFeature` 联合上追加两个字面量，不替换现有字面量：

```ts
export type ServerFeature =
  | "submit"
  | "pending-input"
  | "pending-hold"
  | "secret-input"
  | "input-ready"
  | "take-over"
  | "watch"
  | "conversation-watch"
  | "ping"
  | "conversation-delta"
  | "prompt-push";
```

广告仍只在首帧 `snapshot.features`。未把 `conversation-delta` 放进该数组的 snapshot，连接上不得出现 `type: "conversation-delta"`。未把 `prompt-push` 放进该数组的 snapshot，不得出现 `type: "prompt-push"`。旧 bridge 的 snapshot 不列这两项，行为与现在相同。

`server/index.ts` 的 `SERVER_FEATURES` 只有在对应发送路径已经存在时才加入字面量。T-01 的红灯用一份未声明这两项的 snapshot，断言没有新帧。

## 不变的 conversation-changed

```ts
| { type: "conversation-changed"; pane_id: string; signature: string }
```

字段只有这两个。`signature` 仍是 opaque，不是 REST ETag，也不是 `history_id`。收到它仍表示：感兴趣且已 attach 的连接应重拉现有 conversation REST。扇出条件不变：`!closing`、socket `OPEN`、`attached` 含该 pane、`conversationInterests` 含该 pane。

## conversation-delta

仅当该连接的 snapshot 含 `"conversation-delta"`，且同一扇出条件成立时才发送。它是 `conversation-changed` 之外的第二帧，不取代那一帧。`delta.turns` 唯一语义为当前最新一页的完整替换，不是 turn 补丁。缺段、乱序、读不出一整页或完整消息超过 256 KiB 时，不发本帧，只发原来的 `conversation-changed`；没有截断、拆包或部分更新的中间态。

```ts
| {
    type: "conversation-delta";
    pane_id: string;
    signature: string;
    delta: ConversationPageDelta;
  }

/** Complete newest-page replacement from the existing conversation reader; never a turn patch. */
interface ConversationPageDelta {
  /** Previous delta signature on this connection/pane; null means no comparable previous frame. */
  base_signature: string | null;
  history_id?: string;
  source: ConversationResponse["source"];
  cursor?: string | null;
  /** All turns in the newest page, in reader order; replace that page atomically. */
  turns: ConversationTurn[];
}
```

- `pane_id`：与 `conversation-changed` 相同。
- `signature`：这次观察的 opaque monitor signature，与同时发出的 `conversation-changed.signature` 相同。不是内容摘要或 REST ETag。通知帧不能代替已接受的 delta 基线。
- `delta`：现有 conversation reader 返回的完整最新页。`turns` 必须保留 reader 给出的全部 turns 及顺序，客户端原子替换当前最新页；不得按 role 追加、按最后一项覆盖、拼接片段或改写历史页。reader 确认的空页可用 `turns: []` 替换；读失败不能伪装成空页。
- `base_signature`：该连接、该 pane 上一帧已发送 delta 的 signature；连接初始或服务端没有可核对的前帧时为 null。null 只表示没有可核对的上一帧，且只允许在自包含整页替换上出现；不能解释成跳过比较后按补丁合并。所有 delta 都是完整替换，不存在另一种 patch 合同。
- `source`：必须等于本次完整 reader 页的 source，不能继承或猜测。与当前 REST 页的 source 不同，客户端丢弃整帧并 invalidate，先由 REST 确认数据源切换。
- `history_id`：原样取自本次 reader 页；缺省表示无 history_id，不继承旧值。与当前页比较时，缺省仅与缺省相等，字符串必须相等；变化（包括有值/无值切换）丢弃整帧并 invalidate，由 REST 处理 history_changed 与历史缓存。
- `cursor`：本次完整页的页首 cursor，不是 turn 修改位置；缺省或 null 均表示无 cursor，不继承旧值。只有最新页时，随完整页一起替换，允许页首滑动。已有历史页时，cursor 变化意味着不能证明衔接，丢弃 delta 并 invalidate，继续使用现有 REST 的分页/缺口处理，不能用 delta 覆盖或拼接历史页。

### REST、基线与客户端接受顺序

REST 页没有 monitor signature。客户端已有的 `signature.current`（`JSON.stringify` 内容摘要）保留原用途；另存本连接、本 pane 最后接受的 delta 的 opaque signature。两套状态互不转换、不能互相证明；缓存 `conversation-changed.signature` 也不能证明 REST 返回页对应哪个 monitor 观察。

1. 断线重连、隐藏恢复、REST 对账开始时清空已接受 delta 的 opaque 基线。REST 读取期间丢弃 delta，不缓冲或回放；REST 完成仍不设置 monitor 基线。旧连接、旧 pane 或已失效读取周期的回调不得写入新周期。
2. 只在本 pane 可见、当前是最新页、无 REST 读取进行中且 feature 已声明时处理帧。历史翻页不使用 delta。其他状态下丢帧；恢复可见或重连先 REST。
3. 检查整页字段、source/history/cursor 规则、完整性和大小；不通过则整帧丢弃、清空推送基线并走现有 `invalidate()` / REST。不得先应用一部分 turns 再回退。
4. `signature` 与最后接受的 opaque signature 相同是重复帧，不重复应用。已有基线且非 null `base_signature` 与它不等，视为缺帧或乱序，整帧丢弃并 invalidate；不能通过 role 或末项补合。null 只允许整页替换，不给任何 patch 豁免。
5. 没有 monitor 基线时（包括 REST 完成后的下一帧），只能接受自包含完整页。即使它带非 null 的前帧 signature，也没有本地上一帧可核对；依靠完整替换建立新基线，而不是宣称 REST 与该 signature 已绑定。接受 null 帧同理，绝不以 null 证明 REST 内容一致。通过检查后原子替换最新页，并将本帧 signature 记为已接受基线。

REST 与 monitor 没有共同的内容版本，不能由两种签名推断彼此的新旧或相等。REST 后不回放读取中收到的帧，下一帧自包含替换，不做跨 REST 的 patch 合并；`BACKSTOP_MS` 全量对账继续保留。

### 完整性、顺序与回退

- `ConversationMonitor` 只负责 transcript 定位与 stat，回调只有 pane 和 opaque signature，不产出 turns。signature 变化后，服务端才调用现有 conversation reader 取最新完整一页；禁止从 PTY 字节推导 turn。
- 每个 pane 串行读页、核对、发布。读前与读后核对该观察的 transcript 定位和 stat 身份，并检查期间没有更新的 monitor 观察；读失败、结果已过时、读前后身份变化或无法确认完整页，都只保留 `conversation-changed`，不发 delta，不把旧页绑定到新 signature。相同连接的已发送帧按 WebSocket 顺序处理，不并发应用；不能拿 opaque 字符串作大小或时间排序。
- 完整页指一次现有 reader 成功返回的最新页全部 turns，保留其原顺序、页首 cursor 和 history/source。缺段包括截去部分 reader 结果、分页片段冒充最新页、或 reader 不能确认该页完整；乱序包括异步旧结果晚于新观察发布、或改变 reader 的 turn 顺序。这些在发送前拒绝。线上没有 turn ID、位置或分片完成标记，客户端不能独立证明任意 turns 数组完整；不能声称仅凭 signature/cursor 就可检测服务端漏读。任何不确定都回 REST，不新增半页格式。
- payload 上限按整个 `conversation-delta` 消息的 JSON 序列化结果计算 UTF-8 字节数，含 type、pane_id、signature 与 delta 全部字段。上限 256 KiB = 262144 字节，等于可发，大于不发 delta，只发 `conversation-changed`。客户端同样拒绝超限帧并 invalidate。不能靠截断 turns 降到上限以内。
- 同一观察发送 `conversation-changed` 后，仅当上述门全部通过才发送 delta；任一门失败，客户端只收到原有通知并按现有 invalidate 节奏读 REST，没有其他中间态。

未声明 `"conversation-delta"` 的 snapshot 不发本帧。

## prompt-push

仅当 snapshot 含 `"prompt-push"` 时发送。正文与 `GET /api/pane/prompt` 相同，加上路由用的 `pane_id`。没有 signature。

```ts
| {
    type: "prompt-push";
    pane_id: string;
    prompt: InteractivePrompt | null;
    suggestion: string | null;
    restored: string | null;
  }
```

- `prompt: null` 表示菜单消失。
- `suggestion` / `restored` 与今天的 REST 字段相同，可同时为 null。
- 状态来自现有 prompt 读取，不从 PTY 字节推导 turn。
- 未声明 `"prompt-push"`、断线、或隐藏后恢复：不依赖本帧，客户端读一次 REST。无 feature 时 `PROMPT_POLL_MS` 轮询保持。

未声明 `"prompt-push"` 的 snapshot 不发本帧。

## 客户端不新增请求帧

不新增 ClientMessage。订阅仍用现有 `conversation-watch`。prompt 不另开 watch 类型；无 `"prompt-push"` 时继续 REST。
