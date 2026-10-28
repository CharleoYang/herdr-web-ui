# 设计评审 — chat realtime

评审身份：`rev-s2`；Goal：`spec-001-chat-realtime`；步骤：S2-R，当前周期 c2。

范围：只读审查 `FEATURE.md`、`[设计文档]-chat-realtime.md`、`[接口文档]-chat-realtime.md`、`[类图]-chat-realtime.md`、`context-report.md`，并对照下列源码。路径未写目录时均相对 `spec/001-chat-realtime/`。这是设计可实现性结论，不是实现验收；没有修改产品代码、需求、任务或验证器，也没有代签 S2-H。

## 六项独立结论

| # | 结论 | 证据与判断 |
| --- | --- | --- |
| 1 | PASS | 未声明 `conversation-delta` / `prompt-push` 的旧 bridge，在本次 conversation 更新范围内仍只使用 `conversation-changed` 加 REST，不新增这两种帧。`[设计文档]-chat-realtime.md:23-27`、`[接口文档]-chat-realtime.md:24-34,38,64,85` 明确广告和发送门。源码 `shared/protocol.ts:1178-1182,1208-1209`、`server/index.ts:227,541-547,2858` 与现状一致；`src/components/PaneTerminal.tsx:1129-1132` 仍只增加 invalidation。这里“只收到”不排除本来已有的其他 WebSocket 帧。 |
| 2 | PASS | 增量数据源明确为现有 conversation 读取，禁止从 PTY 字节推导 turn：`FEATURE.md:12,21`、`[设计文档]-chat-realtime.md:40`、`[接口文档]-chat-realtime.md:48-61`。源码 `server/conversation-monitor.ts:26-35,77-90` 只观察 transcript 文件身份，`server/index.ts:541-547` 回调也只有 pane 与 signature；T-02 必须另调用现有 conversation 读取，不能假设回调已带 turns。设计第 40 行对 monitor 的描述有事实错误，见 R3。 |
| 3 | FAIL | REST 回退和保留 `BACKSTOP_MS` 的意图明确：`[设计文档]-chat-realtime.md:13-19,31-38`；现有源码确为 10 秒 backstop / 2 秒 invalidate：`src/lib/conversationRefresh.ts:1-6,83-84,102-118`。但 `[接口文档]-chat-realtime.md:49-62` 没有定义 REST 后的可验证基线、缺段判据或超限阈值，无法保证这些失败都能被识别并回退。`BACKSTOP_MS` 保留本身 PASS，组合要求因 R1、R2 为 FAIL，不能拿事后对账替代即时安全合并。 |
| 4 | PASS | 历史翻页仍只走 REST：`[设计文档]-chat-realtime.md:7-12`、`[接口文档]-chat-realtime.md:61-62`、`[类图]-chat-realtime.md:46`。对照 `src/lib/conversationRefresh.ts:61-72` 和 `src/components/ChatView.tsx:1090-1107`，历史页使用 `fetchPaneConversation(paneId, { before })`，没有设计成历史 WS 帧。 |
| 5 | PASS | Electron、Tauri、WebGL、替换 5 秒 session roster / 设备 / usage / worktree 轮询均明确排除：`FEATURE.md:16-21`、`[设计文档]-chat-realtime.md:42`、`context-report.md:50-52`。没有把其他轮询改造夹带进本次设计。 |
| 6 | FAIL | 新 feature 和帧的 TypeScript 外形可供 T-01 编写类型，且 `[接口文档]-chat-realtime.md:28-38,59-61` 正确保留 `conversation-changed` 的 pane_id、opaque signature、REST invalidation 和扇出语义，与 `shared/protocol.ts:1208-1209` 不冲突。但 `ConversationPageDelta` 的基线和应用语义不闭合，T-01 不能冻结一个供 T-02/T-03 独立实现并互通的契约：见 R1、R2。类型能编译不等于新帧字段足以实施。 |

## 阻断发现

### R1 — P1：REST 页与 opaque signature 没有可验证的绑定

- 设计依据：`[设计文档]-chat-realtime.md:12` 要求重连先 REST，再接收其后的推送；`[接口文档]-chat-realtime.md:50-51` 允许 REST 后首帧 `base_signature: null`，第 62 行却只规定与客户端 signature 比较，没有说明 null 如何建立基线或何时失效。
- 源码事实：`shared/protocol.ts:588-605` 的 REST 页没有 monitor signature；`server/conversation-monitor.ts:70-74,77-87` 的 signature 来自 salt、pane 和文件 stat 身份，不是页内容或 ETag；`src/components/ChatView.tsx:899-908` 现有 `signature.current` 是 `JSON.stringify(next)`，不是可直接复用的 monitor signature。`conversation-watch` 请求也没有页基线：`shared/protocol.ts:1117-1119`。
- [INFERENCE] 并发反例：REST 读取进行时 transcript 从 A 更新为 B；客户端拿到 A，随后收到 `base_signature: null` 的 B 片段。若接受 null 跳过比较，就无法证明片段基于 A；若严格与现有 signature 比较，就拒绝首帧，不能建立可用增量链。仅缓存最近的 `conversation-changed.signature` 也不能证明它对应那次 REST 返回的页面。
- 必须补齐：定义 REST/首次推送如何建立一致基线、读取中的 delta 如何处理、重连/隐藏恢复/REST 对账后如何重置，并明确新 monitor signature 与现有 UI 内容比较 signature 的独立状态。可以采用明确的自包含最新页替换语义或可验证的 patch 基线，但需设计作者选择并同步接口；评审不代改方案。

### R2 — P1：turns 是替换还是补丁未定义，无法判定缺段与超限

- 设计依据：`[接口文档]-chat-realtime.md:48-62` 只给 `base_signature`、可选 `history_id`、`source`、可选 `cursor`、`turns`，称其为“最新一页片段”；没有定义替换范围、追加/覆盖规则、连续性或 payload 上限。`[设计文档]-chat-realtime.md:34,50-51` 要求缺段、超限回退，但没有给可实施判据。
- 源码事实：`shared/protocol.ts:438-444` 的 turn 只有 role、可空 ts、parts 和可选 end_ts，没有稳定 turn ID 或位置；`shared/protocol.ts:596-605` 的 cursor 表示页首，不是片段的修改位置。现有客户端还处理历史替换和页首滑动缺口：`src/components/ChatView.tsx:993-1016`。
- [INFERENCE] 反例：已有 `[user, assistant(partial)]`，下一帧 `turns: [assistant(updated)]`。按追加会重复 assistant，按整页替换会丢 user；按最后一项覆盖不能区分新 assistant turn 与原 turn 更新。相同 base_signature 不解决操作含义。页首滑动时，只有可选 cursor 也未定义什么时候算缺段、何时必须 REST gap-fill。
- 必须补齐：明确这是完整最新页替换还是带位置/操作的 patch；定义 history/source/cursor 的匹配与缺省规则、重复/乱序/缺段的判定，以及具体字节或 turn 上限和超限后的 `conversation-changed` 回退。字段不必为增加而增加，但现有字段必须有唯一应用结果。

## 其他事实校正

### R3 — P2：monitor 数据职责在设计内部矛盾

`[设计文档]-chat-realtime.md:40` 写“ConversationMonitor 已经解析出的 transcript”，容易被当成已有 conversation 内容读取。`[类图]-chat-realtime.md:43` 和 `context-report.md:24-26` 则正确说明它不是 turn 解析器。源码 `server/conversation-monitor.ts:77-90,102-114` 只解析 native transcript 的定位并做 stat，不产出 `ConversationResponse` 或 turns；`server/index.ts:541-547` 的回调没有 page。请统一描述为 monitor 触发后复用现有 conversation reader，并明确读取与对应 signature 的一致性。数据源禁止 PTY 的方向仍然正确，因此第 2 项单独 PASS。

## 验证与边界

- 审查是源码与设计契约对照；上面的并发与合并反例是标注的推导，不冒充已运行的产品测试。
- 产物验证命令：`python3 spec/001-chat-realtime/check-s2r.py`。该验证器 `check-s2r.py:5-17` 只检查文件、必要字面量和最小长度；`s2r-review-ok` 不是设计 PASS 的证明。
- 不开始实现、不改设计、不签 S2-H。R1、R2 修订后需重新评审；本轮不得以产物 validator 通过覆盖设计 FAIL。

结论: FAIL

## 第 2 轮修订

本节由本轮修改者追加，仅记录 R1/R2/R3 的设计修订位置，不是独立复审。上面的原始评审与 `结论: FAIL` 保留；当前状态：**未复审**。未代签 S2-H，未 claim 新 todo，未开始实现。

| 发现 | 修订位置 | 本轮修改 |
| --- | --- | --- |
| R1 | `[设计文档]-chat-realtime.md`「保留 REST 权威」「最新页与两套签名状态」；`[接口文档]-chat-realtime.md`「conversation-delta」「REST、基线与客户端接受顺序」；`[类图]-chat-realtime.md`「插入点」的 ChatView 状态说明 | REST 不带 monitor signature；重连、隐藏恢复、REST 对账清空推送基线，REST 读取中丢帧、不回放，之后仅以自包含完整页替换建立基线。明确 null 仅表示无可核对上一帧，不是 patch 豁免；UI 的 JSON.stringify 内容摘要与 opaque monitor signature 分开，不能互相证明。 |
| R2 | `[设计文档]-chat-realtime.md`「最新页与两套签名状态」「monitor 与 conversation reader」「失败回退」「任务切分」；`[接口文档]-chat-realtime.md`「conversation-delta」「完整性、顺序与回退」；`[类图]-chat-realtime.md` 图中的 PageGate 与最新页替换路径及「插入点」 | 唯一选择为完整最新页替换，不按 role 追加、不按末项覆盖；补齐 source/history_id/cursor 缺省与匹配规则、重复/乱序/缺段规则。完整 JSON 的 UTF-8 payload 上限 256 KiB（262144 字节）；缺段、乱序、读不全或超限不发 delta，只发原有 conversation-changed，没有中间态。历史分页仍走 REST。 |
| R3 | `[设计文档]-chat-realtime.md`「monitor 与 conversation reader」「失败回退」「任务切分」；`[接口文档]-chat-realtime.md`「完整性、顺序与回退」；`[类图]-chat-realtime.md` server 读取路径与「插入点」；`context-report.md`「Server push」的 read 描述 | 删除 monitor 已解析 transcript 内容的说法。monitor 只定位与 stat，signature 变化后服务端另调用现有 reader 读取完整最新页；读前后核对观察一致性，禁止旧页贴新签名。context-report 明确定位解析不是 turn 解析。 |

未放松历史翻页、旧 bridge、Electron/Tauri/WebGL、5 秒 roster 等既有边界；未改产品代码、FEATURE.md、task.md、acceptance.json、validators.json 或 check-*.py。指定产物检查为 `python3 spec/001-chat-realtime/check-s2.py`；该检查不构成复审 PASS，不运行 complete。

## 第 2 轮复审

独立新 session 复审；只核对原 R1、R2、R3 是否闭合。上面的「第 2 轮修订」是作者修订记录，不作为复审证据。本节的 PASS 仅表示选定设计契约闭合，不表示产品已经实现或通过运行验收，也不批准 S2-H。以下文档行号均相对本目录；源码行号相对仓库根目录。

### R1 — PASS：自包含整页建立基线，不绑定 REST 与 monitor signature

- 文档证据：`[设计文档]-chat-realtime.md:7-19`、`[接口文档]-chat-realtime.md:61-78`、`[类图]-chat-realtime.md:50`。REST 明确不带 monitor signature；已有 `signature.current` 内容摘要与已接受 delta 的 opaque signature 分开保存，通知签名不能提前写入推送基线，两种签名不能互相证明。
- 接受顺序已闭合：重连、隐藏恢复和 REST 对账开始清空推送基线；REST 读取中丢帧、不缓存、不回放；旧连接、旧 pane 和失效读取周期不得写回。REST 完成不设置 monitor 基线，后续自包含完整最新页通过检查后原子替换并建立基线。`base_signature: null` 只表示没有可核对的上一帧，不证明 REST 内容相等，也不豁免补丁合并；有基线时非 null base 不匹配则整帧拒绝并 invalidate（`[接口文档]-chat-realtime.md:63,70-78`）。
- 源码对照：`shared/protocol.ts:588-605` 的 REST 页确无 monitor signature；`server/conversation-monitor.ts:70-87` 的签名来自 salt、pane 和定位/stat 观察值；`src/components/ChatView.tsx:899-908` 确用 `JSON.stringify(next)` 比较 UI 内容。修订不再把这些不同状态当成可互换的版本。
- [INFERENCE] 原并发反例不再需要「B 片段基于 REST A」这一证明：读取中到达的帧被丢弃，读取后可接受的 B 必须是完整页，而不是对 A 的补丁。文档也不声称完整替换证明了 REST/monitor 的共同版本或跨通道新旧关系（`[接口文档]-chat-realtime.md:76-78`）。

### R2 — PASS：替换范围、缺省、顺序及超限回退有唯一合同

- 文档证据：`[设计文档]-chat-realtime.md:13-28,46-53`、`[接口文档]-chat-realtime.md:38-66,72-86`、`[类图]-chat-realtime.md:48-52`。`delta.turns` 保留一次 reader 返回的最新页全部 turns 与顺序，原子替换该页，不按 role 追加、不按末项覆盖、不改历史页；确认的空页与读取失败区分。
- `source` 必须取本次 reader 页且与当前 REST 页匹配；`history_id` 缺省只与缺省相等，有值/无值变化均回 REST；`cursor` 缺省或 null 表示无 cursor，不继承旧值。仅最新页允许页首滑动，已有历史且 cursor 变化则拒绝 delta，由现有 REST 分页/缺口逻辑接管（`[接口文档]-chat-realtime.md:64-66`）。源码 `shared/protocol.ts:438-444,596-605` 确没有 turn 操作位置或稳定 ID，cursor 确是页首；`src/components/ChatView.tsx:993-1016,1090-1107` 确已有 history 与缺口处理，修订没有虚构 patch 合并能力。
- 重复 signature 不重应用；有基线的非 null base 不匹配视为缺帧/乱序；同连接按 WebSocket 顺序处理，不比较 opaque 字符串大小。每 pane 串行读页、核对、发布，拒绝过时结果、读取身份变化、turn 顺序改变及无法确认的完整页（`[接口文档]-chat-realtime.md:75-86`）。缺段的发送端判据已列出，且明确客户端不能凭任意 turns 数组或 signature/cursor 独立证明服务端未漏读，没有把不可验证的条件冒充客户端守卫。
- 上限是整个 `conversation-delta` JSON 的 UTF-8 字节数，包含 envelope 全部字段：262144 字节可发，超过则只发原有 `conversation-changed`；不截断、不拆分。缺段、乱序、读不全同样不发 delta，客户端拒绝非法帧后 invalidate/REST（`[接口文档]-chat-realtime.md:38,74,82-86`）。`src/lib/conversationRefresh.ts:1-6,83-84,102-118` 的 10 秒 backstop / 2 秒 invalidate 与修订保留的回退路径一致。
- [INFERENCE] 原 `[user, assistant(partial)]` 后接 `[assistant(updated)]` 的歧义已排除：若 reader 完整页仍含 user，发送时不能截成单 assistant；若单 assistant 确为完整最新页，接收者只做该页替换，不自行推断追加/覆盖操作。cursor 与历史衔接不明时走 REST，不尝试拼接。

### R3 — PASS：monitor 只定位和 stat，reader 在通知后另行读取

- 文档证据：`[设计文档]-chat-realtime.md:22-28,55,65`、`[接口文档]-chat-realtime.md:82-86`、`[类图]-chat-realtime.md:8-11,26-36,48`、`context-report.md:24-28`。四份文档一致区分 transcript 定位解析与 turn 内容解析；monitor 仅给 pane 与 opaque signature，不产出页或 turns。服务端在观察变化后另调现有 reader，读取前后核对定位/stat 身份及是否出现新观察，门失败只留通知，禁止旧页贴新签名。
- 源码对照：`server/conversation-monitor.ts:19-35,70-90,102-114` 只组装文件/WAL 等观察值并调用 `(paneId, signature)`；`server/index.ts:541-547` 回调当前只按 attach/watch 条件扇出 `conversation-changed`，没有 page。修订已删除「monitor 已解析 transcript 内容」的前提，把 reader 和一致性门明确列为待实现路径；stat 门没有被说成内容摘要或 REST ETag（`[设计文档]-chat-realtime.md:26`）。

### 验证与范围

- 已逐项对照指定四份修订文档、原评审和指定源码；本轮不新增其他审查范围，不修改设计或产品代码。
- 上述并发与数组反例是标注的契约推导，不是已运行的新帧测试。产品尚未实现，本轮没有运行产品验收；`check-s2r.py:5-17` 仅验证评审产物存在及必要字面量，不能证明设计或实现 PASS。
- 未 claim、未 complete、未代签 S2-H；原始 `结论: FAIL` 保留。R1 PASS / R2 PASS / R3 PASS，无遗留的原发现阻断。

复审结论: PASS
