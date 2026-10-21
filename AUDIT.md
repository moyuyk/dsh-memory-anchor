# 发布审计报告

- 审计对象：`dsh-memory-anchor` v0.1.0
- 审计日期：2026-10-21
- 审计范围：代码、包元数据、测试、依赖、路径、隐私、文档、发布形态
- 审计方式：静态检查 + 集成加载（假 ctx）+ 单元/冒烟测试 + 真实库只读体检

## 结论

**Conditional GO（有条件通过）。** 可以作为发布候选，但发布前必须补齐 4 项 P1；P2 项不阻塞发布，建议首个补丁版本处理。

## 通过项

| 项 | 结果 | 证据 |
|---|---|---|
| 语法 | 通过 | `lib/*.js`、`bin/*.js` 全部 `node --check` exit 0 |
| 插件加载 | 通过 | 假 ctx 加载：sections=`memory-anchor:sessions`/`memory-anchor:memory`，tools=`memory_add`/`memory_search`，routes=4 条 |
| 冒烟测试 | 通过 | `test/smoke.mjs`（写入/检索/corrected/注入过滤） |
| 单元测试 | 通过 | `test/unit.mjs`（中文检索/密钥守卫/revision/导入导出） |
| 硬编码路径 | 通过 | `lib/` 下 `D:\dsdata`、`C:\Users` 命中 0 |
| 外部调用 | 通过 | host 半无 `fetch`/`http`/`llm`/`embedding`；client 的 `fetch` 只请求本机路由 |
| 默认数据目录 | 通过 | 配置 > `DSH_MEM_ROOT` > `<DSH_HOME>/memory`；老布局（包根有 `db/`）自动兼容 |
| 包元数据 | 通过 | `name`、`version`、`license: MIT`、`engines.node >=22.5`、`dsh.bundle/client/marketplace`、peer 依赖 |
| 文件清单 | 通过 | `files` 声明全部存在，无缺项 |
| 文档 | 通过 | 中文 `README.md`（默认）、英文 `README.en.md`、`LICENSE`、`icon.svg` |
| CI | 通过 | GitHub Actions：Node 22/24，语法 + smoke + unit |
| 隐私 | 通过 | 不联网、不调模型、原文不复制进库 |
| 真实库体检 | 通过 | `doctor`：72 条 / 66 条有锚点 / 锚点失效 0 |

## 发现项

### P1（发布前必须处理）

1. **没有 git 仓库**。`hasGit=false`，无法打 tag、回滚、生成变更记录。发布前 `git init` 并提交首个版本。
2. **缺发布元数据**：`repository`、`author`、`homepage`、`CHANGELOG.md`、`SECURITY.md` 均无。npm 页面和市场审核会看这些。
3. **测试缺口**：`/memory-anchor/stats`、`/search`、`/export`、`/manage` 四条路由没有单测；client 渲染没有测试；`agent/pre-step` 首轮命中没有测试。当前只有 smoke + unit 两个文件。
4. **`npm pack` 未验证**。环境里没有 npm，只校验了 `files` 清单，没有实际打包。发布机上必须跑一次 `npm pack --dry-run`。

### P2（不阻塞，后续处理）

5. **首轮关键词命中未在真实运行时验证**。探针确认 `agent/pre-step` 会触发，但注入消息的实际效果还没在重启后的会话里观察。
6. **`sidebar.panellist` 的渲染位置未验证**。slot 名取自 `dsh-context` 源码，最终出现在侧栏哪个区域由宿主决定，离线无法确认。
7. **两套代码未收敛**。运行版（`memory/bin` + 两个旧插件）与发布包逻辑一致但仍是两份；切换后应删掉旧代码，避免双维护。
8. **错误信息仍为中文**。主市场为中国用户，可接受；英文用户会看到中文报错。

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| DeepSeek Harness 改会话日志格式 | `raw` 无法回源，核心卖点受损 | 日志读取已隔离在 `bin/lib/session-log.js`；README 声明「格式变化时 raw 降级」 |
| 客户端 slot API 变动 | 侧栏面板失效，host 不受影响 | client 半独立，失败不影响注入和工具 |
| peer 版本范围不当 | 宿主升级后插件被跳过 | 范围 `>=0.1.0-rc.6 <0.3.0`；发布前用当前 runtime 验证一次 |
| 双份代码漂移 | 修一处漏一处 | 切换完成后删除旧代码，只留发布包 |

## 发布前检查清单

- [ ] `git init` + 首次提交 + tag `v0.1.0`
- [ ] 补 `repository` / `author` / `homepage`
- [ ] 写 `CHANGELOG.md`（0.1.0 初始版本）
- [ ] 写 `SECURITY.md`（本地数据、无网络、漏洞上报方式）
- [ ] 补 4 条 HTTP 路由的单测
- [ ] 补 `agent/pre-step` 命中测试（可用假 decision）
- [ ] 发布机跑 `npm pack --dry-run`，核对包内容
- [ ] 切换 profile 后重启，验证侧栏面板/设置卡片/导出
- [ ] 切换后删除旧插件代码，确认无双份注入

## 审计员备注

这套的差异点是「摘要 + 锚点回源」，不是「功能更多」。市场上 `dsh-ltm` 功能更全、`meow-memory` 分层更细；本包的竞争力在于**不调模型、不联网、原文永远可追**。发布文案应围绕这一点，不要和它们拼功能清单。