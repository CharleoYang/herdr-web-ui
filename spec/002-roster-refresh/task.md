# Roster refresh delivery

Reuse the existing machine SSE channel. Keep five-second health/auth and degraded-stream roster fallback, with a visible healthy-stream REST backstop no later than thirty seconds. No chat transport, server discovery, WebGL or desktop packaging changes.

| 任务ID | 描述 | 前置依赖 | 预计写入范围 | 状态 | 门禁进度 | 计划开始 | 计划完成 | 预计工作量 | 实际开始 | 实际完成 | ONES任务ID | ONES同步 | 产出/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | 使用当前 SSE 完整快照判断 roster 推送健康，停止冗余五秒 roster GET，保留降级轮询、可见恢复和有界 REST 对账；补真实浏览器回归 | - | src/App.tsx;scripts/roster-refresh-browser-qa.ts | 待执行 | 实施授权后领取 | - | - | - | - | - | - | - | 仅改浏览器 roster 调度；沿用 SnapshotRequests 防旧响应覆盖；真实 App/Bun bridge/Chromium 测试健康、错误、重连、隐藏、恢复与请求计数。开发和代码评审 tokens/gpt-6.1-sol，QA mcli/deepseek-v4.1-flash；Main不运行验证。 |
