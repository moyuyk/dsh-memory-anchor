'use strict';
/**
 * 一次性审计脚本：列出全部记忆条目 + 找疑似重复 + 统计标签与状态。
 * 不改任何数据，只读。
 */
const store = require('./lib/store.js');

const scopes = store.listScopes();
const all = [];
for (const s of scopes) {
  for (const n of store.listNodes(s, { limit: 2000, status: null })) all.push(n);
}

all.sort((a, b) => a.scope.localeCompare(b.scope) || a.id - b.id);

console.log(`总条目: ${all.length}  库: ${scopes.length}`);
console.log('='.repeat(78));

let cur = '';
for (const n of all) {
  if (n.scope !== cur) {
    cur = n.scope;
    console.log(`\n### ${cur}`);
  }
  const st = n.status && n.status !== 'open' ? ` [${n.status}]` : '';
  console.log(`${n.scope}#${n.id}\t${n.kind}\tw${n.weight}${st}\t${String(n.created_at).slice(0, 10)}\t${n.title}`);
}

// ---- 疑似重复：标题归一化后按 bigram 相似度 ----
function norm(s) {
  return String(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
function bigrams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const items = all.map((n) => ({ n, key: norm(n.title), bg: bigrams(norm(n.title)) }));
const pairs = [];
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    if (items[i].n.scope !== items[j].n.scope) continue;   // 只看同一库内
    const sim = jaccard(items[i].bg, items[j].bg);
    if (sim >= 0.45) pairs.push({ sim, a: items[i].n, b: items[j].n });
  }
}
pairs.sort((x, y) => y.sim - x.sim);

console.log('\n\n' + '='.repeat(78));
console.log(`疑似重复标题（同库内相似度 >= 0.45）: ${pairs.length} 对`);
for (const p of pairs) {
  console.log(`\n  ${p.sim.toFixed(2)}  ${p.a.scope}#${p.a.id}「${p.a.title}」`);
  console.log(`        ${p.b.scope}#${p.b.id}「${p.b.title}」`);
}

// ---- 标签分布 ----
const tagCount = new Map();
for (const n of all) {
  for (const t of String(n.tags || '').split(',')) {
    const k = t.trim();
    if (k) tagCount.set(k, (tagCount.get(k) || 0) + 1);
  }
}
console.log('\n' + '='.repeat(78));
console.log('标签分布（出现 >= 2 次）:');
[...tagCount.entries()].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

// ---- 状态分布 ----
const stCount = new Map();
for (const n of all) stCount.set(n.status, (stCount.get(n.status) || 0) + 1);
console.log('\n状态分布:');
[...stCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

// ---- 最早的与最新的 ----
const sorted = [...all].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
console.log('\n时间跨度:', sorted[0].created_at, '→', sorted[sorted.length - 1].created_at);
