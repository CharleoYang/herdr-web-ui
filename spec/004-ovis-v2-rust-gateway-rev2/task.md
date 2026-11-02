# Ovis v2 — Rust 网关交付任务（第 3 稿）

设计与契约：`docs/v2-rust-gateway.md`（第 3 稿）。清单：`docs/v2-route-inventory.md` + `scripts/v2-route-allowlist.json`。

硬约束：归属单元 = 一个 pane 的 WS + 其相关 HTTP（§1）；公开端口在 T-11 前不动，T-10 是 T-08 前置；validator 三条件（HEAD 红 / 错实现红 / v1 顶替不通过，provenance 按面定义）；T-05..T-07 经 `--test-listen` 自证，生产构建不含该入口；构建用 `cargo +1.96.1`。

| 任务ID | 描述 | 前置依赖 | 预计写入范围 | 状态 | 门禁进度 | 计划开始 | 计划完成 | 预计工作量 | 实际开始 | 实际完成 | ONES任务ID | ONES同步 | 产出/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | 骨架（**仅 loopback**）：`crates/ovis-v2`、`dist/` 静态（200/206/304、编码协商）、`--selftest`、优雅退出、非 loopback 拒绝启动 | - | crates/ovis-v2/**;scripts/v2-selftest.ts | 待执行 | - | - | - | 2d | - | - | - | - | 先写 selftest：v2 不在时必红；断言 Range/ETag/编码 + 绑定地址 |
| T-02 | 全量 HTTP 代理（含 SSE 与取消）+ **运行时路由对账**（trace ⊇ 静态清单） | T-01 | crates/ovis-v2/src/proxy.rs;scripts/v2-diff-http.ts;scripts/v2-trace.ts | 待执行 | - | - | - | 4d | - | - | - | - | v1 fixture 记录 method+path+target；跑遍页面/对话框/错误分支；v1 停时代理必失败 |
| T-03 | herdr RPC 客户端：行 JSON、超时、错误码、`ping` 版本探测（**正常路径必须成功**） | T-01 | crates/ovis-v2/src/herdr.rs;scripts/v2-diff-herdr.ts | 待执行 | - | - | - | 2d | - | - | - | - | 四类：正常/半帧/超时/坏版本；只做拒绝的实现会被正常用例挂掉 |
| T-04 | `/api/session` 原生（快照、`finish_*`、背景字段） | T-03 | crates/ovis-v2/src/session.rs;scripts/v2-diff-session.ts | 待执行 | - | - | - | 3d | - | - | - | - | 结构与关系相等 + v1 停仍答 |
| T-04b | pane HTTP 原生：`read`(GET)、`scroll`(GET/POST)、`find`(POST)、`selection`(GET)、`plan`(GET) | T-04 | crates/ovis-v2/src/pane_http.rs;scripts/v2-diff-pane.ts | 待执行 | - | - | - | 3d | - | - | - | - | 每方法：成功 + 参数错误 + `format=ansi` 变体 + v1 停仍答 |
| T-05 | 输出窗口 + PTY 归属：ACK 水位、1 MiB 硬顶、暂停预算、4008、sidecar 生命周期 | T-03 | crates/ovis-v2/src/pty.rs;crates/ovis-v2/src/output_window.rs;scripts/v2-soak.ts | 待执行 | - | - | - | 5d | - | - | - | - | test-only 传输下 30 min：有序字节零丢失、慢消费者被关、无重复 sidecar |
| T-06 | 输入与按键顺序：40/300 ms、代次复核、镜像/Windows RPC、insert/secret | T-05 | crates/ovis-v2/src/input.rs;scripts/v2-diff-input.ts | 待执行 | - | - | - | 4d | - | - | - | - | 受控时钟下与 v1 逐字节时序对拍；Stop 与队列交叠、镜像各一组 |
| T-07 | 提交与排队：submit/pending/租约/草稿/`agent_blocked`/断线恢复 | T-06 | crates/ovis-v2/src/pending.rs;crates/ovis-v2/src/composer.rs;scripts/v2-diff-pending.ts | 待执行 | - | - | - | 5d | - | - | - | - | 四态状态机 + HTTP create 首消息边界对拍 |
| T-08 | 归属切换：同一 pane 的 WS + 相关 HTTP 一次交给 v2；拒绝同 pane 双归属（前置 T-10） | T-04;T-04b;T-07;T-10 | crates/ovis-v2/src/ws.rs;scripts/v2-diff-ws.ts | 待执行 | - | - | - | 3d | - | - | - | - | 帧序等价；双归属被拒；访问判定只出现一次（`x-ovis-served-by`） |
| T-09 | conversation 原生：clear/fork/ancestry 掩码、工具/通知身份、子 agent 元数据 | T-04 | crates/ovis-v2/src/conversation/**;scripts/v2-diff-conversation.ts | 待执行 | - | - | - | 6d | - | - | - | - | 25 轮+rewind、clear、工具/通知、元数据变更、44 MB 五模式 |
| T-10 | 访问层对等：peer/转发头/token/device/Portal 判定 + **HTTP 与 WS ingress** + 吊销订阅 | T-01 | crates/ovis-v2/src/access.rs;scripts/v2-diff-access.ts | 待执行 | - | - | - | 4d | - | - | - | - | v1 `access.test.ts` 全用例 + 直接/经代理两条路径 + 吊销生效 |
| T-11 | 公开端口切换 + 回退协议：排空、租约、sidecar 收尾、`OVIS_V2=0` | T-02;T-08;T-09 | scripts/v2-cutover.ts;scripts/plugin.ts;herdr-plugin.toml | 待执行 | - | - | - | 3d | - | - | - | - | queued/held/sending/uncertain 各一条切换与恢复；≤5 s 回滚；端口/PID 归属 |
| T-12 | 浸泡 + 影子差分 + 指标（30 min / 11 pane / 1 万帧每分） | T-11 | scripts/v2-soak.ts;docs/v2-metrics.md | 待执行 | - | - | - | 2d | - | - | - | - | 进程树 RSS、p95、丢帧；只看 Rust PID 判不通过 |
| T-13 | 发布与安装：单二进制 + sidecar 资产、幂等安装、回滚文档、**生产构建不含 `--test-listen`** | T-12 | scripts/build-v2.ts;scripts/v2-install-check.ts;install.sh;INSTALL.md;docs/v2-rollback.md | 待执行 | - | - | - | 2d | - | - | - | - | 干净前缀装/启/停/重装/回滚；二进制与资产 SHA 绑定；无测试入口 |

**v2.0 不原生化的面**（原样代理）：`omo-tasks` 及四类数据源、`machines/**`（含 SSH/bridge）、push/devices/usage/updates/telemetry/portal-relay。
