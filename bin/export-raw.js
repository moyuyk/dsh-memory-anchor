#!/usr/bin/env node
'use strict';
/**
 * export-raw.js —— 把各记忆库的「库内原文」（node_raw 表）导出成可读的 Markdown
 *
 * 用途：不想开 SQLite 工具、也不想敲 raw 命令时，直接把原文摊成文件用编辑器翻。
 *
 * 用法：
 *   node export-raw.js [--out <目录>] [--scope <库名>]
 *   默认输出到 <记忆库根>/raw-export/，每个库一个 <库名>.md
 *
 * 注意：导出的是一次性快照；之后新增/修改的记忆要重新跑一次才会出现在文件里。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const OUT = flag('out', path.join(ROOT, 'raw-export'));
const ONLY = flag('scope', null);

fs.mkdirSync(OUT, { recursive: true });

const files = [];
for (const f of fs.readdirSync(path.join(ROOT, 'db'))) if (f.endsWith('.db')) files.push(path.join(ROOT, 'db', f));
const projDir = path.join(ROOT, 'db', 'projects');
for (const f of fs.readdirSync(projDir)) if (f.endsWith('.db')) files.push(path.join(projDir, f));

const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
let totalEntries = 0, totalChars = 0;

for (const file of files) {
  const base = path.basename(file, '.db');
  if (ONLY && base !== ONLY && !(`proj:${base}` === ONLY)) continue;
  const db = new DatabaseSync(file, { readOnly: true });
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT n.id, n.scope, n.kind, n.title, n.summary, n.weight, n.created_at,
             r.text, r.source, r.session_id, r.seq_start, r.seq_end, r.chars, r.created_at AS raw_at
      FROM nodes n LEFT JOIN node_raw r ON r.node_id = n.id
      ORDER BY n.id
    `).all();
  } catch (e) { console.log(base + ': ' + e.message); db.close(); continue; }
  db.close();

  const withRaw = rows.filter((r) => r.text);
  const lines = [
    `# 记忆库「${base}」原文导出`,
    '',
    `> 导出时间：${stamp}`,
    `> 来源：${file}`,
    `> 条目 ${rows.length} 条，其中有库内原文 ${withRaw.length} 条`,
    `> 说明：原文是回填时从 DSH 会话日志按「相关轮次」定位提取的，粒度是那一段对话，不是逐字出处。`,
    '',
    '---',
    '',
  ];
  let chars = 0;
  for (const r of rows) {
    lines.push(`## ${r.scope}#${r.id}　${r.title}`);
    lines.push('');
    lines.push(`- 类型/权重：${r.kind} / ${r.weight}　创建：${r.created_at}`);
    if (r.text) {
      lines.push(`- 原文：${r.chars} 字　来源 ${r.source}${r.session_id ? ' / ' + r.session_id : ''}${r.seq_start != null ? `　seq ${r.seq_start}-${r.seq_end}` : ''}　入库 ${r.raw_at}`);
    } else {
      lines.push('- 原文：**无**');
    }
    lines.push('');
    lines.push(`**摘要**：${r.summary || '(同标题)'}`);
    lines.push('');
    if (r.text) {
      lines.push('**原文全文**');
      lines.push('');
      lines.push('```text');
      lines.push(r.text.replace(/```/g, '``\u200b`'));
      lines.push('```');
      lines.push('');
      chars += r.chars;
    }
    lines.push('---');
    lines.push('');
  }
  const out = path.join(OUT, `${base}.md`);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  totalEntries += rows.length;
  totalChars += chars;
  console.log(`${base.padEnd(14)} ${String(rows.length).padStart(4)} 条 / 有原文 ${String(withRaw.length).padStart(4)} / 原文 ${String(chars).padStart(8)} 字 -> ${out}`);
}
console.log(`\n合计 ${totalEntries} 条，原文 ${totalChars} 字；导出目录 ${OUT}`);
