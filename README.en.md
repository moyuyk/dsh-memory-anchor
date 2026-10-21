# dsh-memory-anchor

**Summaries in the database. Original text on demand.**

Long-term memory for DeepSeek Harness that does not keep a second copy of your
conversations. Each memory stores a summary plus one anchor — `(session_id,
seq_start, seq_end)` — and `raw` goes back to the DSH session log to fetch the
exact words.

No need to re-explain yourself every session:

> You: why did we drop search from the export menu?
> It: because you said search belongs in the tool, not the UI. I can pull the
> original exchange if you want it.

## Why an anchor instead of another copy

| | Copy-the-text plugins | This one | What you can verify |
|---|---|---|---|
| Storage | full text duplicated into a DB | summary in the DB, anchor only | `mem.js raw <ref>` restores the original from the session log — 12,771 chars in 19 ms in our test |
| Consistency | two copies that can drift | the session log is the only source of truth | the DB contains no conversation text |
| Growth | grows with every message | grows only with what is worth remembering | one memory = one row, ~100 bytes |

## Three claims you can check

1. **No model calls, no network, zero runtime dependencies.**
   `package.json` has no `dependencies`. Storage and search use Node's built-in
   `node:sqlite`. Nothing summarises in the background, nothing slows down a turn.

2. **Prefix-cache friendly.**
   Two sections are appended at the tail of the system prompt (session digest
   `@10150` + long-term facts `@10160`) and frozen for the session, so provider
   KV caching is not disturbed.

3. **Writing is a model decision, not a background guess.**
   `memory_add` / `memory_search` are ordinary tools. The plugin only handles
   dedupe, truncation, and storing the anchor.

## What it does not do

- no auto-consolidation, no dream/reflection rounds, no background model calls;
- no embeddings, no network, no uploads;
- no search box in the UI — search lives in `memory_search` / the CLI;
- no copy of the original text in the database (by design, not by accident).

## Limits and non-guarantees

- **If DSH changes its session-log format, `raw` degrades**: summaries and search
  keep working; only anchor resolution depends on the log format.
- **Imported entries have no anchor**: `raw` cannot restore them; the full text
  goes into `body`, so search and `show` still work.
- **Verified only against DSH 0.2.1-rc.2** (current npm latest); earlier versions
  were not tested one by one, and a DSH upgrade may require a plugin update.
- **Single writer**: concurrency is handled by WAL + `busy_timeout`; writes queue
  under extreme load rather than being lost.
- **Tool names collide with other memory plugins**: disable `dsh-memory` /
  `meow-memory` / `dsh-ltm` before enabling this one (see the migration section).

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

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_add` | Write one durable memory (title required; summary, kind, tags, weight, scope optional) |
| `memory_search` | Search summaries; use the returned `ref` with the CLI `raw` command for exact text |

CLI (same database):

```powershell
node bin/mem.js add --title "..." --summary "..." --kind fact
node bin/mem.js search "keyword"
node bin/mem.js list --scope global
node bin/mem.js raw global#1
node bin/mem.js update global#1 --corrected 1
```

## Safety

- **Write guard**: `memory_add` and the CLI reject likely secrets/tokens
  (`sk-…`, `ghp_…`, `AKIA…`, private-key blocks). Use `--allow-secret` only when
  you really mean it.
- **Version guard**: `update --rev N` rejects stale writes instead of overwriting
  another session's change.
- **Corrected lessons**: entries marked `--corrected 1` are excluded from injection.

## Export / import

```powershell
node bin/mem.js export --scope global --format json > memory.json
node bin/mem.js export --scope global --format md   > memory.md
node bin/mem.js import memory.json --scope global
```

Export contains summaries and metadata; the original text stays in the session
log. Import does not dedupe — do not import the same file twice.

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

Disable the old plugin first — two injectors duplicate context and the tool
names collide.

| Old plugin | Export | Mapping |
|---|---|---|
| `dsh-memory` / `dsh-ltm` | `SELECT text, tags, pinned FROM memories` → JSON array | `text` → summary, `pinned` → weight 5 |
| `meow-memory` | seven-layer export `title/content/level/importance` | `lesson`→pitfall, `project`→decision, `user`→profile, `rules`→preference |
| Markdown-based | one `{title, content}` per entry | `content` → summary |

```powershell
node bin/mem.js import legacy.json --scope global
```

Imported entries carry no session anchor, so `raw` cannot restore them; the full
text goes into `body`. Import does not dedupe.

## Let the model tidy once (optional)

This package never summarises in the background. If you have a pile of old
memories to clean up, paste the prompt from [PROMPTS.md](./PROMPTS.md) into
DeepSeek Harness once.

The most-used one:

> You are a memory librarian. Run `mem.js list --scope global`, find duplicates,
> stale entries, multi-conclusion entries and vague titles; keep the fullest
> duplicate, soft-delete the rest; split multi-conclusion entries; never add
> anything without evidence; report how many were merged/split/deleted.

More prompts in [PROMPTS.md](./PROMPTS.md).

## Data layout

```
<memRoot>/db/global.db
<memRoot>/db/chat.db
<memRoot>/db/projects/<project>.db
<memRoot>/sessions-index/          # frame index used by raw
```

These files contain **no** conversation text.

## Privacy

- reads only `<DSH_HOME>/sessions` on this machine;
- writes only SQLite under `memRoot`;
- no network, no model calls;
- uninstall = remove the plugin; delete `memRoot` when you no longer need the data.

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
node test/stress.mjs     # boundaries, injection, concurrency, corrupted data
node scripts/make-release.mjs   # export a release candidate to D:\dsdata\release\dsh-memory-anchor
```

## License

MIT.