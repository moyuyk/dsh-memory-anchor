# Changelog

## 0.1.1 — 2026-10-21

- 修：`memory_add` 写入时不带原文锚点。主进程环境里没有 `DSH_SESSION_ID`，
  改为从 `exec.agent.session.header.id` 取当前会话 id 传给 `mem.js`；
  现在写入即带锚点，`raw` 可以回源（原来只有摘要）。
- 文档：README 补 bundle 加载方式、插件页「记忆库」位置与开关说明；
  导出/导入入口描述统一为「插件 → dsh-memory-anchor → 记忆库」。
- 验证：bundle 开关两态实测通过（关：工具/路由/注入全无；开：全部恢复）。

## 0.1.0 — 2026-10-21

首个版本。

- 摘要层：SQLite `nodes`，CJK 2-gram + BM25 检索，trigram 降级。
- 原文层：`node_raw` 只存 `(session_id, seq_start, seq_end)` 锚点，`raw` 按需回源会话日志。
- 注入：会话摘要（`@10150`）+ 长期要点（`@10160`），同会话冻结；首轮关键词命中（`agent/pre-step`）。
- 工具：`memory_add` / `memory_search`。
- 生命周期：软删除、`restore`、`supersede`、`corrected`、`revision` 乐观锁。
- 安全：写守卫拒绝疑似密钥/令牌。
- 运维：`doctor`（缺锚点/可疑原文/锚点失效）、`export`/`import`。
- GUI：侧栏「记忆库」面板（统计、搜索、软删、标记纠正、导出快照）+ 设置页统计卡片。
- 测试：smoke / unit / web / hook；CI 覆盖 Node 22/24。