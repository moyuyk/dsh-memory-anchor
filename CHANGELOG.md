# Changelog

## 0.1.0 — 2026-10-21

首个版本。

- 摘要层：SQLite `nodes`，CJK 2-gram + BM25 检索（单套索引，老库残留的 trigram 表自动清理）。
- 原文层：`node_raw` 只存 `(session_id, seq_start, seq_end)` 锚点，`raw` 按需回源
  DSH 会话日志；帧索引落在 `<memRoot>/sessions-index/`。
- 注入：会话摘要（`@10150`）+ 长期要点（`@10160`）两段，同会话冻结；
  会话前 3 轮的用户消息走 `agent/pre-step` 做关键词命中，已插过的不重复。
- 会话摘要缓存落盘到 `<memRoot>/cache/`，重启后首轮不用全量重算。
- 工具：`memory_add` / `memory_search`。
- 生命周期：软删除、`restore`、`supersede`、`corrected`；`update --rev` 是原子 CAS。
- 安全：写守卫拒绝疑似密钥/令牌。
- 运维：`doctor`（缺原文/原文可疑/锚点失效）、`export` / `import`、`backfill`。
- 整理：`mem.js tidy`（默认 dry-run，`--apply` 执行）合并同主题 state；
  写入 `state` 时自动把同主题旧快照软失效（`valid_until` + `superseded_by`，可 `restore`）。
- GUI：插件页「记忆库」面板——统计、最近条目可点开看详情、导入；
  导出四项（仅结论 JSON / Markdown 摘要 / 记忆库备份 / 完整备份）；bundle 级开关可启停。
- 零 LLM、零网络、零第三方运行时依赖。
- 兼容 DSH 0.2.1-rc.2（当前 npm latest）。
- 测试：smoke / unit / web / hook / client / stress（边界、注入、并发、损坏数据）；
  CI 覆盖 Node 22/24。