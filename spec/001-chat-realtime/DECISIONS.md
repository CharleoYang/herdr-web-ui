# Decisions — Chat conversation and prompt updates push over the existing WebSocket; REST stays authoritative for history and reconnect

| ID | Decision | Evidence | Owner | Date |
| --- | --- | --- | --- | --- |
| P-01 | T-04 修复必须跨 machine relay 保留下游只读计划视图；不以 terminal observe 角色代替权限判定，不只清空路径而泄露文件正文 | R1 全量源码评审 `/tmp/chat-realtime-t04-source-review.md:26-33`；独立 QA `/tmp/chat-realtime-qa-prompt-mcli/report.md` 的权限运行面仍 NOT RUN | Main，依据用户全权授权 | 2026-10-16 |
| P-02 | 原 T-04 领取者先合法释放租约，再 rollback T-04 新周期并更新 scope；保留 T-02/T-03 与 R1 证据；逻辑任务评审上限仍三轮，不因周期重建清零 | native release receipt `lease-release:eb7d9c0bd871cdc53ca1e3f18f700b1c66e566ac494778c48d73cc5d5d6771c4`；R1 patch SHA256 `fae43e2d8a920459446ea42f49269a976f108fbd076cf087fcfc3493753744c2` | Main | 2026-10-16 |
| P-03 | 逻辑 R3 后停止普通修复循环；先完整复盘，再按同一状态/来源判据显式授权 R4/R5，不以新 Todo 或 native cycle 重置轮次 | `retrospective-r1-r3.md`；`review-history.md`；R3/R4 全量源码报告 | Main，依据用户全权授权 | 2026-10-16 |
| P-04 | 每个实际 bridge 的 owner HTTP reader 先证明文件富化就绪；随后八种权限结果必须验证唯一文件 marker 的保留/排除，并保持同策略 REST/推送相等 | R3 首帧竞态源码证据；R4 真实原生诊断；R4 marker-oracle finding `:29-35` | Main | 2026-10-16 |
| P-05 | Goal 最终验收在已真实交付的注册主树执行；feature 的 `--project` 不转交 Goal criterion 的执行根；先完成独立分支验收和 canonical 切换，再由 QA 完成 native Goal，Main 不跑验证 | `loopx/control_plane/goals/acceptance.py:334-358`；`completion_validation.py:227,328`；roster pre-cutover 失败回执保留 | Main | 2026-10-16 |
