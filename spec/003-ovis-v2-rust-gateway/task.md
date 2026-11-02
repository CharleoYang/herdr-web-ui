# Ovis v2 — Rust 网关交付任务（第 2 稿，按第 1 轮评审重排）

设计与契约：`docs/v2-rust-gateway.md`。清单：[`docs/v2-route-inventory.md`](../docs/v2-route-inventory.md)（`scripts/v2-inventory.ts` 生成）。

硬约束：

- **连接级全有或全无**：v2 不按帧类型混流；T-08 之前 `/ws` 整条留在 v1。
- **公开端口不早切**：T-10（访问层对等）+ T-08 + T-09 全绿才进 T-11；`OVIS_V2=0` 立即回滚。
- **validator 三个条件**：HEAD 上红、实现错也红、v1 顶替时不通过（provenance）。
- 构建 `cargo +1.96.1`（本机 `stable` manifest 损坏）。

| 任务ID | 描述 | 前置依赖 | 预计写入范围 | 状态 | 门禁进度 | 计划开始 | 计划完成 | 预计工作量 | 实际开始 | 实际完成 | ONES任务ID | ONES同步 | 产出/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | 骨架（**仅 loopback**）：`crates/ovis-v2`、`dist/` 静态（200/206/304、编码协商）、`--selftest`、优雅退出 | - | crates/ovis-v2/**;scripts/v2-selftest.ts | 待执行 | - | - | - | 2d | - | - | - | - | 先写 selftest：v2 不在时必红；断言 Range/ETag/gzip，不只首页 |
| T-02 | 全量 HTTP 代理（含 SSE 与取消）+ **运行时路由对账** | T-01 | crates/ovis-v2/src/proxy.rs;scripts/v2-diff-http.ts | 待执行 | - | - | - | 4d | - | - | - | - | 对账：v1 记录真实浏览器全路径，清单双向差集；SSE 断言增量与取消；v1 停掉时代理必失败 |
| T-03 | herdr RPC 客户端：行 JSON、超时、错误码、`ping` 版本探测与拒绝 | T-01 | crates/ovis-v2/src/herdr.rs;scripts/v2-diff-herdr.ts | 待执行 | - | - | - | 2d | - | - | - | - | 注入截断/半帧/超时/daemon 替换/坏版本：必须拒绝接管而不是降级 |
| T-04 | `/api/session` 原生（快照、`finish_*`、背景字段） | T-03 | crates/ovis-v2/src/session.rs;scripts/v2-diff-session.ts | 待执行 | - | - | - | 3d | - | - | - | - | provenance：停 v1 仍答；不比对自增 id，比对结构与关系 |
| T-05 | 输出窗口 + PTY 归属：ACK 水位（256K/64K、1MiB 硬顶）、停滞预算、4008、sidecar 生命周期 | T-03 | crates/ovis-v2/src/pty.rs;crates/ovis-v2/src/output_window.rs;scripts/v2-soak.ts | 待执行 | - | - | - | 5d | - | - | - | - | 30 min 浸泡：有序字节零丢失、慢消费者被关而不是涨内存、无重复 sidecar |
| T-06 | 输入与按键顺序：40 ms / 尾随 ESC 300 ms、角色代次复核、镜像与 Windows 走 RPC、`insert`/`secret` | T-05 | crates/ovis-v2/src/input.rs;scripts/v2-diff-input.ts | 待执行 | - | - | - | 4d | - | - | - | - | 与 v1 逐字节时序对拍；Stop 与队列交叠、镜像 pane 各一组 |
| T-07 | 提交与排队：`submit`/`pending-*`/租约/草稿/`agent_blocked`/重连恢复 | T-06 | crates/ovis-v2/src/pending.rs;crates/ovis-v2/src/composer.rs;scripts/v2-diff-pending.ts | 待执行 | - | - | - | 5d | - | - | - | - | 四类状态机对拍：排队、草稿、阻塞、断线恢复 |
| T-08 | WS 连接归属切换：每连接一次性判定，v2 承载全帧 | T-04;T-07 | crates/ovis-v2/src/ws.rs;scripts/v2-diff-ws.ts | 待执行 | - | - | - | 3d | - | - | - | - | 同连接帧序列与 v1 等价；证明混流不可能（同 pane 两归属必须被拒） |
| T-09 | conversation 原生：clear/fork/ancestry 掩码、工具/通知身份、子 agent 元数据 | T-04 | crates/ovis-v2/src/conversation/**;scripts/v2-diff-conversation.ts | 待执行 | - | - | - | 6d | - | - | - | - | fixture：25 轮+rewind（评审给出）、44 MB 冷/热/追加/回退五种；turns 逐字段相等 |
| T-10 | 访问层对等：peer/转发头/token/device/Portal 判定与优先级 | T-01 | crates/ovis-v2/src/access.rs;scripts/v2-diff-access.ts | 待执行 | - | - | - | 3d | - | - | - | - | 直接复用 `server/access.test.ts` 用例集合在 v2 上跑 |
| T-11 | 公开端口切换 + 回退演练（v1 退 loopback、`OVIS_V2=0`） | T-02;T-08;T-09;T-10 | scripts/v2-cutover.ts;scripts/plugin.ts;herdr-plugin.toml | 待执行 | - | - | - | 2d | - | - | - | - | 端口归属、无重复 sidecar、pending 安全、≤5 s 回滚、真 Chromium 冒烟；全部 fixture 自有，不碰用户实例 |
| T-12 | 浸泡 + 影子差分 + 指标（30 min / 11 pane / 1 万帧每分） | T-11 | scripts/v2-soak.ts;docs/v2-metrics.md | 待执行 | - | - | - | 2d | - | - | - | - | 进程树 RSS（v2+v1+sidecar）、p95、丢帧；语义规范化后零差异；只看 Rust PID 视为不通过 |
| T-13 | 发布与安装：单二进制 + sidecar 资产、`install.sh`/plugin 幂等、回滚文档 | T-12 | scripts/build-v2.ts;scripts/v2-install-check.ts;install.sh;INSTALL.md;docs/v2-rollback.md | 待执行 | - | - | - | 2d | - | - | - | - | 干净前缀：安装/启停/重装/回滚各一遍，资产 SHA 与 manifest 校验 |

**v2.0 不原生化的面**（原样代理，留待 v2.2 单独 feature）：`omo-tasks` 及其四类数据源、`machines/**`（含 SSH/bridge 升级）、push/devices/usage/updates/telemetry/portal-relay。
