# Changelog

## 0.1.0 — 2026-10-21

首个版本。

- 摘要层：SQLite `nodes`，CJK 2-gram + BM25 检索，trigram 降级。
- 原文层：`node_raw` 只存 `(session_id, seq_start, seq_end)` 锚点，`raw` 按需回源
  DSH 会话日志；帧索引落在 `<memRoot>/sessions-index/`。
- 注入：会话摘要（`@10150`）+ 长期要点（`@10160`），同会话冻结；
  首轮关键词命中走 `agent/pre-step`，插在用户消息前。
- 工具：`memory_add` / `memory_search`。
- 生命周期：软删除、`restore`、`supersede`、`corrected`、`revision` 乐观锁。
- 安全：写守卫拒绝疑似密钥/令牌。
- 运维：`doctor`（缺原文/原文可疑/锚点失效）、`export` / `import`、`backfill`。
- GUI：插件页「记忆库」面板（统计 / 导出 / 导入），bundle 级开关可启停。
- 零 LLM、零网络、零第三方运行时依赖。
- 测试：smoke / unit / web / hook / stress；CI 覆盖 Node 22/24。