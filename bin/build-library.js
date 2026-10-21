#!/usr/bin/env node
'use strict';
/**
 * build-library.js —— 重建「dsh聊天记录」文本库（分卷 txt，摘要 + 原文 + 目录）
 *
 * 平时**不需要手动跑**：每次用 mem.js 写完记忆（add / update / rm / raw-fetch / backfill / newproject …）
 * 都会在命令结束时自动重建一次。这个 CLI 只用于：换目录/换分卷大小、或想立刻重跑一遍。
 *
 * 用法：
 *   node build-library.js [--out <目录>] [--name <文件名前缀>] [--max-bytes <每卷字节数>]
 * 默认：D:\ds\dsh聊天记录\  前缀 dsh聊天记录  每卷 1.5 MB
 */

const path = require('node:path');
const library = require('./lib/library');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const r = library.build({
  outDir: flag('out', library.DEFAULT_DIR),
  baseName: flag('name', library.DEFAULT_BASENAME),
  maxBytes: Number(flag('max-bytes', library.DEFAULT_MAX_BYTES)) || library.DEFAULT_MAX_BYTES,
});

console.log(`[文本库] ${r.entries} 条记忆（有原文 ${r.withRaw}）/ 原文 ${r.chars} 字 / 正文 ${r.volumes.length - 1} 卷${r.dedupSaved ? ` / 去重省略 ${r.dedupSaved} 字` : ''}`);
console.log(`  输出目录: ${r.dir}`);
for (const f of r.volumes) console.log('  - ' + path.join(r.dir, f));
if (r.removed.length) console.log(`  已清理多余旧卷: ${r.removed.join(', ')}`);
