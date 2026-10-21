# dsh-memory-anchor

DeepSeek Harness 的「锚点式」本地长期记忆。

大多数记忆插件会把模型说过的话复制一份存起来。这套只存**摘要**，原文只留一个
**锚点**；需要原话时，`raw` 按锚点回到 DSH 会话日志里取。

- **摘要层（SQLite）**：一条记忆一行，含标题、摘要、类型、权重、标签、有效期。
  中文用 2-gram 索引 + BM25，trigram 索引保留作降级。
- **锚点层**：`node_raw` 只存 `(session_id, seq_start, seq_end)`，**不复制原文**。
  会话日志是唯一真源。
- **零 LLM、零网络、零第三方依赖**：不做 embedding、不调总结模型、不埋点。
  存储只用 Node 内置的 `node:sqlite`。
- **两段注入**：会话摘要（`order 10150`）+ 长期要点（`order 10160`），都放在
  系统提示尾部，避免破坏提供方前缀缓存。
- **工具化写入**：`memory_add` / `memory_search` 是普通 DSH 工具，写不写由模型
  判断，不在后台偷偷生成。

## 安装

从 DSH 插件市场安装，或本地 link：

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-memory-anchor
```

然后把包加进 profile 的 bundle 列表（`~/.dsh/profiles/desktop/package.json`）：

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-anchor"]
  }
}
```

重启 DSH。作为 **bundle** 加载后，插件页的开关能真正启停它：关掉 → 新会话没有
`memory_add` / `memory_search`、也没有记忆注入；再打开恢复。切换开关要重启 DSH
（`requiresRestart: true`）。

## 在哪看和管

**插件 → dsh-memory-anchor → 记忆库**：

| 位置 | 能做什么 |
| --- | --- |
| 「导出 ▾」 | 仅结论 JSON / 记忆库备份（不含日志）/ 完整备份（含会话日志） |
| 「导入」 | 选一个 JSON 数组；宽松格式（`text/tags/pinned`、`title/content`、本包格式） |
| 统计 | 按 scope 的条数和类型分布、最近条目；是只读的，没有搜索框 |

检索走 `memory_search` 工具或 CLI，不占页面。

## 配置

默认数据目录是 `<DSH_HOME>/memory`。要改就在 patch 里**覆盖同一条目**（`id` 必须
和 bundle 里的一致），不要用 `insert`：

```yaml
- id: memory-anchor
  name: dsh-memory-anchor
  config:
    memRoot: D:/dsdata/memory
```

也可以设环境变量 `$DSH_MEM_ROOT`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `memory_add` | 写一条跨会话仍成立的记忆（标题必填；摘要/类型/标签/权重/scope 可选） |
| `memory_search` | 检索摘要，拿到 `ref` 后用 CLI `raw` 取原文 |

CLI（同一份库）：

```powershell
node bin/mem.js add --title "..." --summary "..." --kind fact
node bin/mem.js search "关键词"
node bin/mem.js list --scope global
node bin/mem.js raw global#1
node bin/mem.js update global#1 --corrected 1
```

## 安全

- **写守卫**：`memory_add` 和 CLI 会拒绝疑似密钥/令牌（`sk-…`、`ghp_…`、`AKIA…`、
  私钥块）。确实要存才加 `--allow-secret`。
- **版本保护**：update 支持 `--rev N`，版本号过期会被拒绝，避免覆盖另一个会话的修改。
- **已纠正教训**：`--corrected 1` 标记后，该条不再参与注入。

## 导出 / 导入

```powershell
node bin/mem.js export --scope global --format json > memory.json
node bin/mem.js export --scope global --format md   > memory.md
node bin/mem.js import memory.json --scope global
```

导出包含摘要和元数据；原文仍在会话日志里。导入不查重，同一个文件不要导两次。

## 升级 DeepSeek Harness 前

升级安装目录不会动 `~/.dsh/sessions` 和 `~/.dsh/memory`，但仍建议先备份。

GUI：**插件 → dsh-memory-anchor → 记忆库 →「导出 ▾」**，三种：

| 选项 | 内容 | 用途 |
|---|---|---|
| 摘要 JSON | 结论和元数据 | 最小备份、迁移摘要 |
| 备份包（记忆库） | `db/` + `config.json` | 日常备份 |
| 完整包（含会话日志） | 再加 `sessions/` | 换机、重装、保原文 |

也可以手动复制 `~/.dsh/memory` 和 `~/.dsh/sessions`。

## 从其他记忆插件迁移

先禁用旧插件再导入——两套注入会重复、工具会重名。

| 旧插件 | 导出 | 本包映射 |
|---|---|---|
| `dsh-memory` / `dsh-ltm` | `SELECT text, tags, pinned FROM memories` → JSON 数组 | `text` → 摘要，`pinned` → weight 5 |
| `meow-memory` | 七层表导出 `title/content/level/importance` | `lesson`→坑、`project`→决策、`user`→画像、`rules`→偏好 |
| Markdown 类 | 每条 `{title, content}` | `content` → 摘要 |

```powershell
node bin/mem.js import legacy.json --scope global
```

导入的条目不携带会话锚点，`raw` 无法回源；全文会进 `body`，检索和 `show` 仍可看。
导入不查重，同一个文件不要导两次。

## 让模型帮你整理一次（可选）

本包不会在后台调模型做总结。如果你有一批旧记忆要整理，把 [PROMPTS.md](./PROMPTS.md) 里的提示词复制给 DeepSeek Harness 跑一次即可，之后不需要再跑。

最常用的一段：

> 你是记忆库整理员。先运行 `mem.js list --scope global` 看现状，找出重复、过时、一条多结论、标题太泛的条目；重复的保留最全、其余软删；一条多结论的拆成多条；不要新增没有依据的条；结束后报告整理前/合并/拆分/删除的数量。

更多提示词见 [PROMPTS.md](./PROMPTS.md)。

## 数据位置

```
<memRoot>/db/global.db
<memRoot>/db/chat.db
<memRoot>/db/projects/<项目>.db
<memRoot>/sessions-index/          # 原文回源的帧索引
```

这些文件里**没有**对话原文。

## 隐私

- 只读本机 `$DSH_HOME/sessions` 下的会话日志；
- 只写 `memRoot` 下的 SQLite；
- 不联网、不调用任何模型；
- 卸载 = 移除插件；不再需要数据时删除 `memRoot`。

## 兼容性

- Node.js >= 22.5（`node:sqlite`）。
- DSH 0.2.1-rc.2（当前 npm latest）实测；更早的 0.1.x / 0.2.x 未逐一验证。
- 会话日志格式 `session.v4.jsonl.zstd`。
- 如果 DSH 改了日志格式，`raw` 会降级（摘要和检索仍可用）；只有锚点层依赖它。

## 开发

```powershell
node --check lib/index.js
node test/smoke.mjs
node test/unit.mjs
node test/stress.mjs     # 边界/注入/并发/损坏数据
node scripts/make-release.mjs   # 导出发布候选到 D:\dsdata\release\dsh-memory-anchor
```

## 许可

MIT。