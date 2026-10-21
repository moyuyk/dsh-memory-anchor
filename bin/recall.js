#!/usr/bin/env node
'use strict';
/**
 * 联合检索：一条命令同时查「记忆库（仅有效）+ 知识库」。
 * ================================================
 *
 * 为什么需要它：遇到项目问题时，答案可能分布在两边——
 *   记忆库：我们当时怎么决定的、踩了什么坑
 *   知识库：这个坑/机制的通用规律
 * 分两次跑容易漏，所以合成一个入口。
 *
 * 用法:
 *   recall "关键词" [--limit 3] [--scope global,proj:XX] [--json]
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('./lib/store.js');

// 知识库路径（2026-10-19 改为可配置）：优先环境变量 DSH_KB_ROOT，否则用默认同级目录。
// 之前是写死的相对路径，知识库一旦搬位置，existsSync 会静默返回空数组、不报错。
const KB_ROOT = process.env.DSH_KB_ROOT || path.resolve(__dirname, '..', '..', 'knowledge');
const KB_DB = path.join(KB_ROOT, 'db', 'knowledge.db');

function snippet(text, query, radius = 130) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return t.length > radius * 2 ? t.slice(0, radius * 2) + '…' : t;
  const s = Math.max(0, i - radius);
  const e = Math.min(t.length, i + query.length + radius);
  return (s > 0 ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : '');
}

function searchKnowledge(query, limit) {
  if (!fs.existsSync(KB_DB)) return [];
  const db = new DatabaseSync(KB_DB, { readOnly: true });
  try {
    // 默认只查有效文档（2026-10-19 加）：之前不过滤，已软删/已失效的知识也会被 recall 出来。
    const alive = "(d.status IS NULL OR d.status = 'active') AND (d.valid_until IS NULL OR d.valid_until = '')";
    if (query.length >= 3) {
      try {
        return db.prepare(`
          SELECT c.heading, c.text, d.id AS did, d.title, d.source_url
          FROM chunks_fts f
          JOIN chunks c ON c.id = f.rowid
          JOIN docs d   ON d.id = c.doc_id
          WHERE chunks_fts MATCH ? AND ${alive}
          ORDER BY bm25(chunks_fts) LIMIT ?
        `).all(`"${query.replace(/"/g, '""')}"`, limit);
      } catch { /* 退回 LIKE */ }
    }
    const esc = query.replace(/[\\%_]/g, (c) => '\\' + c);
    const like = `%${esc}%`;
    return db.prepare(`
      SELECT c.heading, c.text, d.id AS did, d.title, d.source_url
      FROM chunks c JOIN docs d ON d.id = c.doc_id
      WHERE (c.text LIKE ? ESCAPE '\\' OR c.heading LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')
        AND ${alive}
      ORDER BY d.updated_at DESC LIMIT ?
    `).all(like, like, like, limit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) flags[k] = true;
      else { flags[k] = n; i++; }
    } else rest.push(a);
  }

  const query = rest.join(' ').trim();
  if (!query) {
    console.log('用法: recall "关键词" [--limit 3] [--scope global,proj:XX] [--json]');
    process.exit(1);
  }

  const limit = flags.limit ? Number(flags.limit) : 3;
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : store.listScopes();

  const mem = store.search(scopes, query, { limit, validOnly: true });
  const kb = searchKnowledge(query, limit);

  if (flags.json) {
    console.log(JSON.stringify({ memory: mem, knowledge: kb }, null, 1));
    return;
  }

  console.log(`关键词: "${query}"   记忆 ${mem.length} 条 / 知识 ${kb.length} 条`);
  console.log('='.repeat(72));

  console.log('\n【记忆库】我们当时怎么做的');
  if (!mem.length) console.log('  (无命中)');
  for (const r of mem) {
    console.log(`  ${r.scope}#${r.id}  [${r.kind}]  ${String(r.created_at).slice(0, 10)}  ${r.title}`);
    if (r.summary && r.summary !== r.title) console.log(`    ${snippet(r.summary, query)}`);
  }

  console.log('\n【知识库】通用规律 / 外部资料');
  if (!kb.length) console.log('  (无命中)');
  for (const r of kb) {
    const sec = r.heading ? ` § ${r.heading}` : '';
    console.log(`  kb#${r.did}  ${r.title}${sec}`);
    if (r.source_url) console.log(`    出处: ${r.source_url}`);
    console.log(`    ${snippet(r.text, query)}`);
  }

  console.log('\n' + '-'.repeat(72));
  console.log('记忆库看原文: mem.js raw <scope>#<id>   ｜  知识库看全文: kb.js show <id>');
}

main();
