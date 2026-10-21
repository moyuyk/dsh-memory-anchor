# dsh-memory-anchor

**摘要进库，原文回源。**

跨会话长期记忆：只存摘要和一行锚点（会话 id + 序号区间），需要原话时回 DSH 会话日志取。
大多数记忆插件会把对话原文再复制一份存起来——这套不复制，所以没有两份数据能漂移。

> 你：上次导出菜单为什么把搜索去掉了？
> 它：你说搜索走工具更省上下文，UI 只留统计和导出。要原话我可以回源给你。

## 和「再存一份」的区别

| | 常见做法 | 这套 | 你能验证的 |
|---|---|---|---|
| 存储 | 全文复制进库 | 摘要进库，原文只留 `(session_id, seq_start, seq_end)` | `mem.js raw <ref>` 从会话日志取回原文，实测 12,771 字 / 19ms |
| 一致性 | 库和日志各存一份，可能漂移 | 原文只有会话日志一个真源 | 库里没有对话全文 |
| 增长 | 随对话线性膨胀 | 只随「值得记的事」增长 | 一条记忆一行，百来字节 |

## 三个可验证的点

1. **不调模型、不联网、零运行时依赖**：`package.json` 没有 `dependencies`，存储检索只用 `node:sqlite`；不会后台偷偷总结，也不拖慢每一轮。
2. **不抢前缀缓存**：两段注入固定在 system prompt 尾部（会话摘要 `@10150` + 长期要点 `@10160`），同会话冻结。
3. **写入由模型判断**：`memory_add` / `memory_search` 是普通工具；插件只负责查重、截断、存锚点。

## 不做什么

- 不自动整理、不做 dream/反思轮、不后台调模型；
- 不做 embedding、不联网、不上传；
- UI 没有搜索框（检索走工具或 CLI）；
- 不复制原文进库（设计，不是省事）。

## 限制与不保证

- DSH 改会话日志格式 → `raw` 降级（摘要和检索仍可用）。
- 导入的条目没有锚点 → `raw` 取不到原文，全文进 `body`，检索和 `show` 仍可看。
- 只验证了 DSH 0.2.1-rc.2（当前 npm latest）；DSH 升版后本包可能需要跟着改。
- 并发写入是单写者：WAL + `busy_timeout` 排队，极端并发下等待而不是丢数据。
- 和 `dsh-memory` / `meow-memory` / `dsh-ltm` 工具名冲突，迁移时先禁用旧插件。

## 安装

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-memory-anchor
```

把包加进 profile 的 bundle 列表（`~/.dsh/profiles/desktop/package.json`）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-anchor"] } }
```

重启 DSH。作为 bundle 加载后，插件页开关能真正启停：关掉 → 新会话没有工具和注入，再打开恢复。

<details>
<summary>配置</summary>

默认数据目录 `<DSH_HOME>/memory`。要改就在 patch 里覆盖同一条目（`id` 必须一致），不要用 `insert`：

```yaml
- id: memory-anchor
  name: dsh-memory-anchor
  config:
    memRoot: D:/dsdata/memory
```

也可以设 `$DSH_MEM_ROOT`。

</details>

<details>
<summary>在哪看和管（插件页「记忆库」）</summary>

**插件 → dsh-memory-anchor → 记忆库**：

| 位置 | 能做什么 |
| --- | --- |
| 「导出 ▾」 | 仅结论 JSON / Markdown 摘要 / 记忆库备份（不含日志）/ 完整备份（含会话日志） |
| 「导入」 | 选一个 JSON 数组；宽松格式（`text/tags/pinned`、`title/content`、本包格式） |
| 统计 | 按 scope 的条数和类型分布、最近条目；只读，没有搜索框 |

</details>

<details>
<summary>工具与 CLI</summary>

| 工具 | 作用 |
| --- | --- |
| `memory_add` | 写一条跨会话仍成立的记忆（标题必填；摘要/类型/标签/权重/scope 可选） |
| `memory_search` | 检索摘要，拿到 `ref` 后用 CLI `raw` 取原文 |

```powershell
node bin/mem.js add --title "..." --summary "..." --kind fact
node bin/mem.js search "关键词"
node bin/mem.js list --scope global
node bin/mem.js raw global#1
node bin/mem.js update global#1 --corrected 1
```

</details>

<details>
<summary>安全</summary>

- **写守卫**：拒绝疑似密钥/令牌（`sk-…`、`ghp_…`、`AKIA…`、私钥块）；确实要存加 `--allow-secret`。
- **版本保护**：`update --rev N`，版本号过期会被拒绝，避免覆盖另一个会话的修改。
- **已纠正教训**：`--corrected 1` 标记后不再参与注入。

</details>

<details>
<summary>导出 / 导入</summary>

```powershell
node bin/mem.js export --scope global --format json > memory.json
node bin/mem.js export --scope global --format md   > memory.md
node bin/mem.js import memory.json --scope global
```

导出包含摘要和元数据；原文仍在会话日志里。导入不查重，同一个文件不要导两次。

</details>

<details>
<summary>从其他记忆插件迁移</summary>

先禁用旧插件再导入——两套注入会重复、工具会重名。

| 旧插件 | 导出 | 本包映射 |
|---|---|---|
| `dsh-memory` / `dsh-ltm` | `SELECT text, tags, pinned FROM memories` → JSON 数组 | `text` → 摘要，`pinned` → weight 5 |
| `meow-memory` | 七层表导出 `title/content/level/importance` | `lesson`→坑、`project`→决策、`user`→画像、`rules`→偏好 |
| Markdown 类 | 每条 `{title, content}` | `content` → 摘要 |

```powershell
node bin/mem.js import legacy.json --scope global
```

</details>

<details>
<summary>让模型帮你整理一次（可选）</summary>

本包不会在后台调模型。旧记忆要整理时，把 [PROMPTS.md](./PROMPTS.md) 的提示词跑一次即可。

</details>

<details>
<summary>数据位置、隐私</summary>

```
<memRoot>/db/global.db
<memRoot>/db/chat.db
<memRoot>/db/projects/<项目>.db
<memRoot>/sessions-index/          # 原文回源的帧索引
```

这些文件里没有对话原文。只读本机 `$DSH_HOME/sessions`，只写 `memRoot`，不联网。卸载 = 移除插件；不要数据时删 `memRoot`。

</details>

<details>
<summary>兼容性</summary>

- Node.js >= 22.5（`node:sqlite`）。
- DSH 0.2.1-rc.2（当前 npm latest）实测；更早的 0.1.x / 0.2.x 未逐一验证。
- 会话日志格式 `session.v4.jsonl.zstd`；格式变了 `raw` 降级，摘要和检索不受影响。

</details>

<details>
<summary>开发</summary>

```powershell
node --check lib/index.js
node test/smoke.mjs
node test/unit.mjs
node test/client.mjs    # 面板渲染（最小 React stub，无额外依赖）
node test/stress.mjs     # 边界/注入/并发/损坏数据
node scripts/make-release.mjs   # 导出发布候选到 D:\dsdata\release\dsh-memory-anchor
```

</details>

## 许可

MIT。