'use strict';
/**
 * library.js —— 「dsh聊天记录」文本库构建器
 * ==========================================
 *
 * 把记忆库里所有条目（摘要 + 库内原文）拼成分卷的纯文本 txt，供人直接翻阅、Ctrl+F 找原话。
 *
 * 设计要点：
 * 1. 只读记忆库、只写 txt；不改任何记忆数据。txt 是**只读快照**，手改会在下次重建时被覆盖。
 * 2. 分卷按字节数切（默认 1.5 MB/卷），避免出现记事本打不开的巨型文件。
 * 3. 每卷开头有本卷目录；另出一份「总目录」写清每条在第几卷。
 * 4. 输出目录默认 <记忆库根>/../dsh聊天记录（即 D:\ds\dsh聊天记录），可用参数覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MEM_ROOT = process.env.DSH_MEM_ROOT || path.resolve(__dirname, '..', '..');
const DEFAULT_DIR = path.join(path.dirname(MEM_ROOT), 'dsh聊天记录');
const DEFAULT_BASENAME = 'dsh聊天记录';
const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
const EOL = '\r\n';   // Windows 记事本友好

const SCOPE_RANK = (s) => (s === 'global' ? 0 : s === 'chat' ? 1 : 2);

/** 读取所有库的全部条目（含库内原文） */
function collectEntries() {
  const files = [];
  const dbDir = path.join(MEM_ROOT, 'db');
  if (fs.existsSync(dbDir)) for (const f of fs.readdirSync(dbDir)) if (f.endsWith('.db')) files.push(path.join(dbDir, f));
  const projDir = path.join(dbDir, 'projects');
  if (fs.existsSync(projDir)) for (const f of fs.readdirSync(projDir)) if (f.endsWith('.db')) files.push(path.join(projDir, f));

  const out = [];
  for (const file of files) {
    let db;
    try { db = new DatabaseSync(file, { readOnly: true }); } catch { continue; }
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT n.id, n.scope, n.kind, n.title, n.summary, n.weight, n.created_at,
               r.text, r.source, r.session_id, r.seq_start, r.seq_end, r.chars, r.created_at AS raw_at
        FROM nodes n LEFT JOIN node_raw r ON r.node_id = n.id
        ORDER BY n.id
      `).all();
    } catch {
      try { rows = db.prepare('SELECT * FROM nodes ORDER BY id').all(); } catch { rows = []; }
    }
    db.close();
    for (const r of rows) out.push(r);
  }
  out.sort((a, b) => {
    const ra = SCOPE_RANK(a.scope), rb = SCOPE_RANK(b.scope);
    if (ra !== rb) return ra - rb;
    if (a.scope !== b.scope) return String(a.scope).localeCompare(String(b.scope), 'zh');
    return a.id - b.id;
  });
  return out;
}

/**
 * 一条记忆在正文里的完整块（头 + 摘要 + 原文全文）。
 * dedupRef 非空时表示这段原文与某条已输出的完全相同，正文只留引用、不重复占卷。
 */
function entryBlock(r, { dedupRef = null } = {}) {
  const L = [];
  L.push('='.repeat(78));
  L.push(`【${r.scope}#${r.id}】${r.title}`);
  L.push('-'.repeat(78));
  L.push(`类型: ${r.kind}    权重: ${r.weight}    创建: ${r.created_at}`);
  if (r.text) {
    const src = `来源: ${r.source || 'dsh-session'}${r.session_id ? ' / ' + r.session_id : ''}${r.seq_start != null ? `   seq ${r.seq_start}-${r.seq_end}` : ''}   入库: ${r.raw_at || '-'}`;
    L.push(`原文: ${r.chars} 字    ${src}`);
    if (dedupRef) L.push(`（原文与 ${dedupRef} 完全相同，此处省略，去重用）`);
  } else {
    L.push('原文: 无（该条还没入库原文，可用 mem.js raw-fetch 补）');
  }
  L.push(`摘要: ${r.summary || '(同标题)'}`);
  L.push('-'.repeat(78));
  L.push('');
  L.push(dedupRef ? `(原文与 ${dedupRef} 相同，已省略)` : (r.text || '(无原文)'));
  L.push('');
  return L.join(EOL) + EOL;
}

/** 一行目录项 */
function tocLine(r, width = 46) {
  const id = `${r.scope}#${r.id}`;
  const title = String(r.title || '').replace(/[\r\n]+/g, ' ');
  const shown = title.length > width ? title.slice(0, width - 1) + '…' : title;
  const n = r.text ? `${r.chars} 字` : '无原文';
  return `  ${id.padEnd(26)}${shown.padEnd(width + 2)}${n}`;
}

/**
 * 构建文本库。
 * @returns {{dir:string, baseName:string, volumes:string[], entries:number, chars:number, withRaw:number, bytes:number}}
 */
function build({ outDir = DEFAULT_DIR, baseName = DEFAULT_BASENAME, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entries = collectEntries();
  const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  // 原文去重：同一段原文可能被多条记忆共用（回填按轮次定位），只完整输出一次。
  const seenRaw = new Map();
  let dedupSaved = 0;
  const blocks = entries.map((e) => {
    let dedupRef = null;
    if (e.text) {
      const h = crypto.createHash('sha1').update(String(e.text)).digest('hex');
      const prev = seenRaw.get(h);
      if (prev) { dedupRef = prev; dedupSaved += e.chars || 0; }
      else seenRaw.set(h, `${e.scope}#${e.id}`);
    }
    return { e, text: entryBlock(e, { dedupRef }) };
  });

  // 分卷
  const volumes = [];
  let cur = { items: [], bytes: 0 };
  for (const b of blocks) {
    const size = Buffer.byteLength(b.text, 'utf8');
    if (cur.items.length && cur.bytes + size > maxBytes) { volumes.push(cur); cur = { items: [], bytes: 0 }; }
    cur.items.push(b);
    cur.bytes += size;
  }
  if (cur.items.length) volumes.push(cur);
  if (!volumes.length) volumes.push({ items: [], bytes: 0 });

  fs.mkdirSync(outDir, { recursive: true });
  const pad = String(volumes.length).length;
  const names = volumes.map((v, i) => `${baseName}-${String(i + 1).padStart(Math.max(2, pad), '0')}.txt`);
  const totalChars = entries.reduce((s, r) => s + (r.text ? r.chars : 0), 0);
  const totalBytes = blocks.reduce((s, b) => s + Buffer.byteLength(b.text, 'utf8'), 0);

  // 写各卷
  volumes.forEach((v, i) => {
    const head = [];
    head.push(`${baseName} · 第 ${i + 1}/${volumes.length} 卷`);
    head.push(`生成时间: ${stamp}`);
    head.push(`本卷: ${v.items.length} 条 / ${v.items.reduce((s, b) => s + (b.e.text ? b.e.chars : 0), 0)} 字原文    全文: ${entries.length} 条 / ${totalChars} 字 / 共 ${volumes.length} 卷`);
    head.push(`说明: 这是记忆库所有条目「摘要 + 完整原文」的只读快照，每次写入记忆后自动重建；手工修改会在下次重建时被覆盖。相同原文只完整输出一次，其余条目注明出处。`);
    head.push(`总目录见「${baseName}-总目录.txt」。`);
    head.push('='.repeat(78));
    head.push('【本卷目录】');
    for (const b of v.items) head.push(tocLine(b.e));
    head.push('='.repeat(78));
    head.push('');
    const body = head.join(EOL) + EOL + v.items.map((b) => b.text).join('');
    fs.writeFileSync(path.join(outDir, names[i]), body, 'utf8');
  });

  // 写总目录
  const toc = [];
  toc.push(`${baseName} · 总目录`);
  toc.push(`生成时间: ${stamp}`);
  toc.push(`共 ${entries.length} 条记忆 / ${totalChars} 字原文 / ${volumes.length} 卷`);
  toc.push('');
  toc.push('用法: 在某个卷里用 Ctrl+F 搜关键词或标题；下面标出每条在第几卷。');
  toc.push('='.repeat(78));
  volumes.forEach((v, i) => {
    toc.push('');
    toc.push(`【第 ${i + 1} 卷】${names[i]}    (${v.items.length} 条 / ${v.items.reduce((s, b) => s + (b.e.text ? b.e.chars : 0), 0)} 字)`);
    toc.push('-'.repeat(78));
    for (const b of v.items) toc.push(tocLine(b.e));
  });
  toc.push('');
  fs.writeFileSync(path.join(outDir, `${baseName}-总目录.txt`), toc.join(EOL) + EOL, 'utf8');

  // 清理上一次生成、这次不再需要的卷（卷数变少时）
  const keep = new Set([...names, `${baseName}-总目录.txt`]);
  const staleRe = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.txt$`);
  const removed = [];
  for (const f of fs.readdirSync(outDir)) {
    if (staleRe.test(f) && !keep.has(f)) { try { fs.unlinkSync(path.join(outDir, f)); removed.push(f); } catch {} }
  }

  return {
    dir: outDir, baseName, volumes: names.concat(`${baseName}-总目录.txt`),
    entries: entries.length, withRaw: entries.filter((r) => r.text).length,
    chars: totalChars, bytes: totalBytes, removed, dedupSaved,
  };
}

module.exports = { build, collectEntries, entryBlock, DEFAULT_DIR, DEFAULT_BASENAME, DEFAULT_MAX_BYTES, MEM_ROOT };
