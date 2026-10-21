# dsh-memory-anchor

**Summaries in the database. Original text on demand.**

Long-term memory for DeepSeek Harness: each memory stores a summary plus one
anchor (session id + sequence range); `raw` fetches the exact words from the DSH
session log. Most memory plugins keep a second copy of the conversation — this
one does not, so there are no two datasets that can drift apart.

> You: why did we drop search from the export menu?
> It: you said search belongs in the tool, not the UI. I can pull the original
> exchange if you want it.

## Why an anchor instead of another copy

| | Copy-the-text plugins | This one | What you can verify |
|---|---|---|---|
| Storage | full text duplicated into a DB | summary + anchor only | `mem.js raw <ref>` restores the original — 12,771 chars in 19 ms in our test |
| Consistency | two copies that can drift | the session log is the single source of truth | the DB contains no conversation text |
| Growth | grows with every message | grows only with what is worth remembering | one memory = one row, ~100 bytes |

## Three claims you can check

1. **No model calls, no network, zero runtime dependencies.** No `dependencies`
   in `package.json`; storage and search use built-in `node:sqlite`. Nothing
   summarises in the background, nothing slows down a turn.
2. **Prefix-cache friendly.** Two sections sit at the tail of the system prompt
   (session digest `@10150` + long-term facts `@10160`) and are frozen for the
   session.
3. **Writing is a model decision.** `memory_add` / `memory_search` are ordinary
   tools; the plugin only handles dedupe, truncation and anchors.

## What it does not do

- no auto-consolidation, no dream/reflection rounds, no background model calls;
- no embeddings, no network, no uploads;
- no search box in the UI — search lives in the tool / CLI;
- no copy of the original text in the database (by design).

## Limits and non-guarantees

- DSH session-log format changes → `raw` degrades (summaries and search keep working).
- Imported entries have no anchor → `raw` cannot restore them; full text stays in `body`.
- Verified only against DSH 0.2.1-rc.2 (current npm latest); a DSH upgrade may require a plugin update.
- Single writer: WAL + `busy_timeout` queues writes instead of losing them.
- Tool names collide with `dsh-memory` / `meow-memory` / `dsh-ltm`; disable the old plugin first.

## Install

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-memory-anchor
```

Add the package to the profile's bundle list (`~/.dsh/profiles/desktop/package.json`):

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-anchor"] } }
```

Restart DSH. As a bundle, the plugin-page switch really enables/disables it:
off → no tools and no injection in new sessions; on → restored.

<details>
<summary>Configuration</summary>

Default data directory is `<DSH_HOME>/memory`. Override the same entry in the
patch (`id` must match); do not use `insert`:

```yaml
- id: memory-anchor
  name: dsh-memory-anchor
  config:
    memRoot: D:/dsdata/memory
```

Or set `$DSH_MEM_ROOT`.

</details>

<details>
<summary>Where to look (plugin page → Memory)</summary>

| Where | What |
| --- | --- |
| 「导出 ▾」 | summary JSON / Markdown digest / memory backup (no logs) / full backup (with session logs) |
| 「导入」 | pick a JSON array; lenient shapes (`text/tags/pinned`, `title/content`, this format) |
| Stats | per-scope counts, kind breakdown, recent entries; read-only, no search box |

</details>

<details>
<summary>Tools and CLI</summary>

| Tool | Purpose |
| --- | --- |
| `memory_add` | write one durable memory (title required; summary/kind/tags/weight/scope optional) |
| `memory_search` | search summaries; use `ref` with the CLI `raw` command for exact text |

```powershell
node bin/mem.js add --title "..." --summary "..." --kind fact
node bin/mem.js search "keyword"
node bin/mem.js list --scope global
node bin/mem.js raw global#1
node bin/mem.js update global#1 --corrected 1
```

</details>

<details>
<summary>Safety</summary>

- **Write guard**: rejects likely secrets/tokens (`sk-…`, `ghp_…`, `AKIA…`, private-key blocks); `--allow-secret` to override.
- **Version guard**: `update --rev N` rejects stale writes instead of overwriting another session's change.
- **Corrected lessons**: `--corrected 1` excludes the entry from injection.

</details>

<details>
<summary>Export / import</summary>

```powershell
node bin/mem.js export --scope global --format json > memory.json
node bin/mem.js export --scope global --format md   > memory.md
node bin/mem.js import memory.json --scope global
```

Export contains summaries and metadata; original text stays in the session log.
Import does not dedupe — do not import the same file twice.

</details>

<details>
<summary>Migrating from another memory plugin</summary>

Disable the old plugin first — two injectors duplicate context and tool names collide.

| Old plugin | Export | Mapping |
|---|---|---|
| `dsh-memory` / `dsh-ltm` | `SELECT text, tags, pinned FROM memories` → JSON array | `text` → summary, `pinned` → weight 5 |
| `meow-memory` | seven-layer export `title/content/level/importance` | `lesson`→pitfall, `project`→decision, `user`→profile, `rules`→preference |
| Markdown-based | one `{title, content}` per entry | `content` → summary |

```powershell
node bin/mem.js import legacy.json --scope global
```

</details>

<details>
<summary>Let the model tidy once (optional)</summary>

This package never summarises in the background. To clean up old memories, paste
the prompt from [PROMPTS.md](./PROMPTS.md) into DeepSeek Harness once.

</details>

<details>
<summary>Data layout and privacy</summary>

```
<memRoot>/db/global.db
<memRoot>/db/chat.db
<memRoot>/db/projects/<project>.db
<memRoot>/sessions-index/          # frame index used by raw
```

No conversation text in these files. Reads only `<DSH_HOME>/sessions`, writes
only `memRoot`, no network. Uninstall = remove the plugin; delete `memRoot` when
you no longer need the data.

</details>

<details>
<summary>Compatibility</summary>

- Node.js >= 22.5 (`node:sqlite`).
- DSH 0.2.1-rc.2 (current npm latest); earlier 0.1.x / 0.2.x not individually verified.
- Session log format `session.v4.jsonl.zstd`; if it changes, `raw` degrades and summaries/search keep working.

</details>

<details>
<summary>Development</summary>

```powershell
node --check lib/index.js
node test/smoke.mjs
node test/unit.mjs
node test/client.mjs    # panel rendering (minimal React stub, no extra deps)
node test/stress.mjs     # boundaries, injection, concurrency, corrupted data
node scripts/make-release.mjs   # export a release candidate to D:\dsdata\release\dsh-memory-anchor
```

</details>

## License

MIT.