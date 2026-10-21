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

重启 DSH。bundle patch 会自动插入插件。

## 配置

```yaml
- insert:
    - id: memory-anchor
      name: dsh-memory-anchor
      config:
        memRoot: ""   # 空 = <DSH_HOME>/memory；也可设 $DSH_MEM_ROOT
```

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
- DSH 0.2.x；会话日志格式 `session.v4.jsonl.zstd`。
- 如果 DSH 改了日志格式，`raw` 会降级（摘要和检索仍可用）；只有锚点层依赖它。

## 开发

```powershell
node --check lib/index.js
node test/smoke.mjs
node test/unit.mjs
```

## 许可

MIT。