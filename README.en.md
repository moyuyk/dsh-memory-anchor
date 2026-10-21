# dsh-memory-anchor

Anchored long-term memory for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).

Most memory plugins store a copy of what the model said. This one stores the
**summary**, and keeps only an **anchor** to the original conversation. When the
model needs the exact words, `raw` resolves the anchor against the DSH session
log on demand.

- **Summary layer (SQLite).** One row per memory: title, summary, kind, weight,
  tags, validity window. CJK 2-gram index + BM25; a trigram index stays as a
  fallback.
- **Anchor layer.** `node_raw` stores only `(session_id, seq_start, seq_end)`.
  The raw text is never duplicated into the database. The session log is the
  single source of truth.
- **Zero LLM calls, zero network, zero third-party dependencies.** No embedding
  service, no summarizer model, no telemetry. Node's built-in `node:sqlite` is
  the only storage dependency.
- **Two prompt sections.** Session recaps (`order 10150`) and durable
  facts/preferences/pitfalls (`order 10160`), both near the end of the system
  prompt so provider prefix caches survive.
- **Tools, not magic.** `memory_add` and `memory_search` are ordinary DSH tools.
  Writing is explicit; nothing is auto-generated behind your back.

## Install

From the DSH plugin market, or by linking a checkout:

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-memory-anchor
```

Then add the package to the profile's bundle list (`~/.dsh/profiles/desktop/package.json`):

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-anchor"]
  }
}
```

Restart DSH. Loaded as a **bundle**, the switch on the plugin page really
enables/disables it: off → new sessions have no `memory_add` / `memory_search`
and no injected memory; on → restored. Toggling requires a restart
(`requiresRestart: true`).

## Where to look

**Plugins → dsh-memory-anchor → Memory**:

| Where | What |
| --- | --- |
| 「导出 ▾」 | summary JSON / memory backup (no logs) / full backup (with session logs) |
| 「导入」 | pick a JSON array; lenient shapes (`text/tags/pinned`, `title/content`, this package's format) |
| Stats | per-scope counts, kind breakdown, recent entries; read-only, no search box |

Searching stays in `memory_search` / the CLI, not on the page.

## Configuration

The default data directory is `<DSH_HOME>/memory`. To change it, override the
same entry in the patch (the `id` must match the bundle's); do not use `insert`:

```yaml
- id: memory-anchor
  name: dsh-memory-anchor
  config:
    memRoot: D:/dsdata/memory
```

Or set `$DSH_MEM_ROOT`.

| Key | Default | Meaning |
| --- | --- | --- |
| `memRoot` | `<DSH_HOME>/memory` | Where databases and the session index live |

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_add` | Write one durable memory (title required; summary, kind, tags, weight, scope optional) |
| `memory_search` | Search summaries; use the returned `ref` with the CLI `raw` command for exact text |

CLI (same store):

```powershell
node bin/mem.js add --title "..." --summary "..." --kind fact
node bin/mem.js search "keyword"
node bin/mem.js list --scope global
node bin/mem.js raw global#1
node bin/mem.js update global#1 --corrected 1
```

## Safety

- **Write guard.** `memory_add` and the CLI reject content that looks like a
  credential (`sk-…`, `ghp_…`, `AKIA…`, private-key blocks). Use
  `--allow-secret` only if you really mean to store one.
- **Revision CAS.** Updates take an optional `--rev N`. A stale revision is
  rejected instead of silently overwriting another session's edit.
- **Corrected lessons.** `--corrected 1` marks a lesson as superseded; corrected
  pitfalls are excluded from prompt injection.

## Export / import

```powershell
node bin/mem.js export --scope global --format json > memory.json
node bin/mem.js export --scope global --format md   > memory.md
node bin/mem.js import memory.json --scope global
```

Export is lossless for summaries and metadata; raw text stays in the session log.
Import skips dedupe and trusts the input, so do not import the same file twice.

## Before upgrading DeepSeek Harness

Upgrading the install directory does not touch `~/.dsh/sessions` or
`~/.dsh/memory`, but a backup is still recommended.

The **Plugins → dsh-memory-anchor → Memory → 「导出 ▾」** menu offers three options:

| Option | Contents | Use |
|---|---|---|
| Summary JSON | entries + metadata | smallest backup, summary migration |
| Memory backup | `db/` + `config.json` | routine backup |
| Full backup | adds `sessions/` | machine move, reinstall, keep raw text |

You can also copy `~/.dsh/memory` and `~/.dsh/sessions` manually.

## Migrating from another memory plugin

Disable the old plugin first — two memory plugins mean duplicate injection and
conflicting tool names.

| Old plugin | Export | Mapping |
|---|---|---|
| `dsh-memory` / `dsh-ltm` | `SELECT text, tags, pinned FROM memories` → JSON array | `text` → summary, `pinned` → weight 5 |
| `meow-memory` | export `title/content/level/importance` from the seven tables | `lesson`→pitfall, `project`→decision, `user`→preference, `rules`→preference |
| Markdown-based | one `{title, content}` per entry | `content` → summary |

```powershell
node bin/mem.js import legacy.json --scope global
```

Imported entries carry no session anchor, so `raw` cannot resolve them; the full
text goes into `body` and remains searchable and visible via `show`. Import does
not dedupe — do not import the same file twice.

## Let the model tidy up once (optional)

This package never runs a background model to summarize memory. If you have a
backlog to clean up, copy one of the prompts in [PROMPTS.md](./PROMPTS.md) into
DeepSeek Harness and run it once; no recurring job is created.

## Data layout

```
<memRoot>/db/global.db
<memRoot>/db/chat.db
<memRoot>/db/projects/<project>.db
<memRoot>/sessions-index/          # frame index for fast raw extraction
```

No raw conversation text is stored in these files.

## Privacy

- Reads local DSH session logs under `$DSH_HOME/sessions`.
- Writes local SQLite files under `memRoot`.
- Makes no network requests and calls no model.
- Uninstall = remove the plugin and delete `memRoot` if you no longer need it.

## Compatibility

- Node.js >= 22.5 (`node:sqlite`).
- DSH 0.2.1-rc.2 (current npm latest); earlier 0.1.x / 0.2.x not individually verified.
- Session log format `session.v4.jsonl.zstd`.
- If DSH changes its session log format, `raw` degrades gracefully (summaries
  and search keep working); the anchor layer is the only part that depends on it.

## Development

```powershell
node --check lib/index.js
node test/smoke.mjs
node test/unit.mjs
```

## License

MIT.