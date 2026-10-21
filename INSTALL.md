# 安装与验证（npm 发布前）

当前版本（0.1.0）还没有发到 npm，所以有下面三种装法。装完都请按文末「验证清单」走一遍。

## 方式 A：从 GitHub Release 附件安装（推荐）

1. 打开 Releases 页面，下载 `dsh-memory-anchor-0.1.0.tgz`；
2. 解压到任意目录，例如：

   ```text
   C:\dsh-plugins\dsh-memory-anchor\
   ```

   解压后目录里应该能看到 `package.json`、`lib\`、`bin\`；
3. 编辑 `C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json`：

   ```json
   {
     "dependencies": {
       "dsh-memory-anchor": "link:C:/dsh-plugins/dsh-memory-anchor"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-anchor"]
       }
     }
   }
   ```

   - `dependencies` 里加一行，路径用**正斜杠**；
   - `bundles` 末尾加 `dsh-memory-anchor`。
4. 重启 DSH（bundle 级加载必须重启）；
5. 打开 **插件 → dsh-memory-anchor**，应该看到「记忆库」。

## 方式 B：直接 link 源码目录（开发者）

如果你拿到的是完整的 git 仓库：

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-memory-anchor
```

然后把 `dsh-memory-anchor` 加进 profile 的 `bundles` 列表，重启。

## 方式 C：npm（发布后）

等 npm 包上线后，一条命令即可：

```powershell
dsh plugin --profile desktop add dsh-memory-anchor
```

## 验证清单

装好后逐条确认：

| 检查项 | 怎么看 |
|---|---|
| 插件页 | 插件 → dsh-memory-anchor → **记忆库**，能看到条数统计 |
| 工具注册 | 新会话里问一句「你能用 memory_search 吗」，或工具列表里能看到 `memory_add` / `memory_search` |
| 写入 | 让模型记一条，返回里应带 `锚点 seq ...` 或提示「无锚点」 |
| 原文回源 | `node bin/mem.js raw <scope>#<id>` 能从会话日志取回原文 |
| 开关 | 插件页关掉开关 → 重启 → 新会话没有工具和注入；再开 → 恢复 |
| 导出 | 记忆库 →「导出 ▾」→ 四项都能下载（JSON / Markdown / 备份 / 完整备份） |

## 数据在哪

默认 `~/.dsh/memory`（Windows：`C:\Users\<你>\.dsh\memory`）。
要改就在 `cordis.patch.yml` 里覆盖同一条目：

```yaml
- id: memory-anchor
  name: dsh-memory-anchor
  config:
    memRoot: D:/your/path/memory
```

## 回滚

1. 从 profile 的 `bundles` 和 `dependencies` 里删掉 `dsh-memory-anchor`；
2. 重启 DSH；
3. 数据还在 `memRoot`，删不删随你。

## 常见问题

**装完插件页没有「记忆库」**
- 确认 `bundles` 里加上了；
- 确认重启过（不是只刷新窗口）；
- 检查 `~/.dsh/memory-anchor-debug.log` 里有没有 `[apply] start`。

**工具搜不到 `memory_add`**
- 插件被关了开关；或 profile 的 bundles 没加；
- 重启一次再试。

**`raw` 报「找不到锚点」**
- 这条记忆是从别处导入的（导入条目没有锚点）；
- 或会话日志已被清理，锚点失效（`doctor` 会列出来）。