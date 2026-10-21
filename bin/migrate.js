#!/usr/bin/env node
'use strict';
/**
 * migrate.js —— 把旧 mem.py 的 memory.db 迁移进新记忆总库
 * =====================================================
 *
 * 迁移策略（逐条判断，不是一刀切）：
 *
 *   global          跨领域通用：环境事实、机制、通用坑、用户偏好、规则类决策
 *   proj:桌宠        桌宠（whale-pet）专属
 *   proj:生图        生图链路（ComfyUI / Animagine）专属
 *   proj:DSH插件     DSH 插件体系相关
 *   proj:记忆库      记忆库自身
 *
 * 分类依据是每条记录的 tags 与内容，映射表写在下面，可复核可修改。
 *
 * 用法：
 *   node migrate.js --dry-run     只看分类结果，不写库
 *   node migrate.js               真正迁移
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

const LEGACY_DB = process.env.DSH_LEGACY_DB || path.join(store.MEM_ROOT, 'memory.db');
const DRY = process.argv.includes('--dry-run');

/**
 * 逐条归属映射：旧 id → 新 scope。
 * 未列出的 id 默认进 global。
 */
const SCOPE_BY_ID = {
  // —— 桌宠项目 ——
  7: 'proj:桌宠', 30: 'proj:桌宠', 31: 'proj:桌宠', 32: 'proj:桌宠',
  33: 'proj:桌宠', 36: 'proj:桌宠', 37: 'proj:桌宠',
  // —— 生图项目 ——
  3: 'proj:生图', 16: 'proj:生图', 19: 'proj:生图', 23: 'proj:生图',
  24: 'proj:生图', 27: 'proj:生图', 46: 'proj:生图',
  // —— DSH 插件项目 ——
  12: 'proj:DSH插件', 13: 'proj:DSH插件', 14: 'proj:DSH插件',
  17: 'proj:DSH插件', 22: 'proj:DSH插件', 47: 'proj:DSH插件',
  // —— 记忆库自身 ——
  15: 'proj:记忆库', 29: 'proj:记忆库',

  // —— 未归类缓冲区 ——
  // 文档要求 global「只存长期不变的设定，保持精简」，
  // 因此 todo / session / state 这类临时性、过程性记录不进 global。
  21: 'chat',   // todo: 视频生成方向待用户决定（跨项目，尚无归属）
  28: 'chat',   // session: 插件清理与生图落地（跨两个项目）
};

/** 明确丢弃的记录（自检数据，无长期价值） */
const SKIP_IDS = new Set([1]);

/**
 * 兜底规则：未显式映射时，按 kind 决定去向。
 * 临时性记录（todo/session/state）不进 global，避免污染「长期设定」层。
 */
const TRANSIENT_KINDS = new Set(['todo', 'session', 'state']);

function classify(row) {
  if (SKIP_IDS.has(row.id)) return null;
  if (SCOPE_BY_ID[row.id]) return SCOPE_BY_ID[row.id];
  if (TRANSIENT_KINDS.has(row.kind)) return 'chat';
  return 'global';
}

function main() {
  if (!fs.existsSync(LEGACY_DB)) {
    console.error(`[错误] 找不到旧库: ${LEGACY_DB}`);
    process.exit(1);
  }

  const db = new DatabaseSync(LEGACY_DB, { readOnly: true });
  let rows;
  try {
    rows = db.prepare('SELECT * FROM entries ORDER BY id').all();
  } finally {
    db.close();
  }

  console.log(`旧库: ${LEGACY_DB}`);
  console.log(`记录: ${rows.length} 条   模式: ${DRY ? '试运行（不写库）' : '正式迁移'}`);
  console.log('='.repeat(74));

  const plan = [];
  for (const r of rows) {
    const scope = classify(r);
    if (!scope) { plan.push({ row: r, scope: null, action: '跳过（自检数据）' }); continue; }
    plan.push({ row: r, scope, action: '迁移' });
  }

  // 按 scope 分组显示，便于人工复核分类是否合理
  const byScope = {};
  for (const p of plan) {
    const key = p.scope || '(跳过)';
    (byScope[key] = byScope[key] || []).push(p);
  }

  for (const [scope, items] of Object.entries(byScope)) {
    console.log(`\n【${scope}】 ${items.length} 条`);
    for (const it of items) {
      const r = it.row;
      console.log(`   #${String(r.id).padStart(2)} [${r.kind}] ${String(r.title).slice(0, 52)}`);
    }
  }

  if (DRY) {
    console.log('\n' + '='.repeat(74));
    console.log('试运行结束，未写入任何数据。确认分类无误后去掉 --dry-run 正式迁移。');
    return;
  }

  // 正式迁移
  console.log('\n' + '='.repeat(74));
  let migrated = 0, skipped = 0;
  const idMap = {};   // 旧id → {scope, newId}

  for (const p of plan) {
    if (!p.scope) { skipped++; continue; }
    const r = p.row;
    const res = store.addNode(p.scope, {
      kind: r.kind,
      title: r.title,
      // 旧库没有独立摘要字段，title 本身即摘要性质；body 是详细内容
      summary: r.body ? String(r.body).split('\n')[0].slice(0, 200) : r.title,
      body: r.body || '',
      tags: r.tags ? String(r.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
      weight: r.importance || 3,
      status: r.status || 'open',
      sessionId: r.session_id || '',
      source: 'legacy-mem.py',
    });
    idMap[r.id] = { scope: p.scope, newId: res.id };
    migrated++;
  }

  // 保留旧库原始时间戳（addNode 用的是当前时间，这里回填）
  for (const [oldId, info] of Object.entries(idMap)) {
    const oldRow = rows.find((r) => r.id === Number(oldId));
    if (!oldRow?.ts) continue;
    const { db: ndb } = store.openScope(info.scope);
    try {
      ndb.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(oldRow.ts, info.newId);
    } finally {
      ndb.close();
    }
  }

  // 记一份映射表，便于追溯
  const mapFile = path.join(store.MEM_ROOT, 'legacy', 'migration-map.json');
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, JSON.stringify({
    migratedAt: store.nowIso(),
    source: LEGACY_DB,
    total: rows.length,
    migrated,
    skipped,
    map: idMap,
  }, null, 2), 'utf8');

  console.log(`迁移完成: ${migrated} 条已迁入, ${skipped} 条跳过`);
  console.log(`映射表: ${mapFile}`);
  console.log('\n各库现状:');
  for (const s of store.stats()) {
    console.log(`  ${s.scope.padEnd(18)} ${String(s.total).padStart(3)} 条`);
  }
}

main();
