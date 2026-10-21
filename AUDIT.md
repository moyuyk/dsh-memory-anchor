# 发布审计报告

- 审计对象：`dsh-memory-anchor` v0.1.0
- 审计日期：2026-10-21
- 审计范围：代码、包元数据、测试、依赖、路径、隐私、文档、发布形态
- 审计方式：静态检查 + 集成加载（假 ctx）+ 四个测试文件 + 真实库只读体检

## 结论

**GO（通过），附两项发布机动作。**

P1 中能在本地完成的已全部补齐；剩下两项必须在发布机/真实运行环境完成：
`npm pack --dry-run` 与切换后的侧栏面板验证。

## 通过项

| 项 | 结果 | 证据 |
|---|---|---|
| 语法 | 通过 | `lib/*.js`、`bin/*.js` 全部 `node --check` exit 0 |
| 插件加载 | 通过 | 假 ctx：sections=`memory-anchor:sessions`/`memory-anchor:memory`，tools=`memory_add`/`memory_search`，routes=4 |
| 冒烟测试 | 通过 | 写入/检索/corrected/注入过滤 |
| 单元测试 | 通过 | 中文检索/密钥守卫/revision/导入导出 |
| Web API 测试 | 通过 | stats/search/export/manage（软删、标记纠正） |
| 首轮命中测试 | 通过 | 假 decision：命中条目插入消息前，原消息保留 |
| 硬编码路径 | 通过 | `lib/` 下 `D:\dsdata`、`C:\Users` 命中 0 |
| 外部调用 | 通过 | host 半无网络/LLM 调用；client 的 fetch 只请求本机路由 |
| 默认数据目录 | 通过 | 配置 > `DSH_MEM_ROOT` > `<DSH_HOME>/memory`；兼容老布局 |
| 包元数据 | 通过 | MIT、`engines.node >=22.5`、`dsh.bundle/client/marketplace`、peer、author |
| 发布文件 | 通过 | `files` 含 lib/bin/cordis/README/LICENSE/icon/CHANGELOG/SECURITY，全部存在 |
| 文档 | 通过 | 中文 `README.md`（默认）、英文 `README.en.md`、`CHANGELOG.md`、`SECURITY.md` |
| CI | 通过 | Node 22/24：语法 + smoke + unit + web + hook |
| 版本管理 | 通过 | git 仓库、提交 `5028b0a`、tag `v0.1.0` |
| 隐私 | 通过 | 不联网、不调模型、原文不复制进库 |
| 真实库体检 | 通过 | `doctor`：72 条 / 66 条有锚点 / 锚点失效 0 |

## 已关闭的 P1

1. **git 仓库**：已 `git init`、首次提交、tag `v0.1.0`。
2. **发布元数据**：`author`、`CHANGELOG.md`、`SECURITY.md` 已补；`repository`/`homepage` 需等远程仓库创建后填写。
3. **测试缺口**：`test/web.mjs`（4 条路由）和 `test/hook.mjs`（首轮命中）已补，CI 已覆盖。

## 仍待处理

### P1（发布机执行）

4. **`npm pack --dry-run` 未验证**：本机无 npm。发布机上跑一次，核对包内容不含测试/审计/开发文件。

### P2（不阻塞发布）

5. **侧栏面板渲染位置未验证**：`sidebar.panellist` 取自 `dsh-context` 源码，最终位置由宿主决定，需装上后看。
6. **两套代码未收敛**：运行版与发布包仍并存；切换后删除旧代码。
7. **client 渲染无自动化测试**：React 组件只做了语法检查和函数测试，没有 DOM 测试。
8. **错误信息仍中文**：主市场为中国用户，可接受。

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| DeepSeek Harness 改会话日志格式 | `raw` 无法回源 | 日志读取隔离在 `bin/lib/session-log.js`；README 声明降级 |
| 客户端 slot API 变动 | 侧栏面板失效 | client 半独立，host 注入/工具不受影响 |
| peer 版本范围不当 | 宿主升级后插件被跳过 | 范围 `>=0.1.0-rc.6 <0.3.0`，发布前用当前 runtime 验证 |
| 双份代码漂移 | 修一处漏一处 | 切换后删除旧代码 |

## 发布前清单

- [x] `git init` + 首次提交 + tag `v0.1.0`
- [x] 补 `author`、`CHANGELOG.md`、`SECURITY.md`
- [x] 补 Web API 测试与首轮命中测试
- [ ] 发布机跑 `npm pack --dry-run`
- [ ] 创建远程仓库，补 `repository` / `homepage`
- [ ] 切换 profile 并重启，验证侧栏面板/设置卡片/导出
- [ ] 切换后删除旧插件代码，确认无双份注入

## 市场痛点对照（2026-10-21 抓取）

同类插件周下载量：`meow-memory` 1985、`@fooxe/dsh-memory` 1871、`dsh-memory` 312、
`dsh-memory-eternal` 251、`@tr1v3r/dsh-ltm` 188、`@jipika/dsh-memory` 135。

从各仓库 issue 归纳出的真实痛点：

| 痛点 | 来源 | 本包 |
|---|---|---|
| 版本兼容脆弱（0.2.x 注入/折叠失效） | meow、eternal issues | **同类风险**，依赖 systemPrompt / pre-step / 会话日志 |
| 自动整理不可靠（dream 重复、delegate 劫持、工具集被锁） | meow issues | 无后台整理，不碰模型 |
| 注入数低于上限（先截断后过滤） | meow issue | 固定预算 + 画像优先，不走 hitTopK |
| 配置持久化 bug（homeDir 只写不读） | meow issue | 只有一个 `memRoot`，无运行期改写 |
| 更新静默改错条目（8 位 id 前缀） | meow issue | 整 id + `revision` CAS |
| 多项目/多工作区隔离不足 | meow、eternal issues | `proj:` 物理分库 |
| Windows 路径错位（HOME 为空） | jipika issue | `DSH_HOME` + `path.join`，但仍需 Windows 实测 |
| 后台进程堆积 | eternal issue | 无常驻后台进程 |
| 用户要「对话原文检索（L0）」 | meow issue | `grep` + `raw` 锚点回源 |
| 用户要「关闭记忆」开关 | meow issue | 暂无 GUI 开关（P2） |

结论：痛点集中在「自动整理不可靠、版本兼容、项目隔离、原文检索」。
本包天然覆盖后两项，主动避开前两项的复杂度；版本兼容是最大共同风险。

## 审计员备注

差异点是「摘要 + 锚点回源」，不是功能数量。市场同类里 `dsh-ltm` 功能更全、
`meow-memory` 分层更细；本包的竞争力在于**不调模型、不联网、原文永远可追**。
发布文案应围绕这一点，不要拼功能清单。