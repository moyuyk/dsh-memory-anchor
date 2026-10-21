#!/usr/bin/env node
'use strict';
/**
 * rename-project-dbs.js —— 把项目库文件从哈希名改成中文名
 *
 * 早期版本 slugify 把中文名转成哈希（p_i0s262.db），不易辨认。
 * 现在 slugify 保留中文，此脚本把已有文件重命名对齐。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('./lib/store');

const dir = store.PROJECT_DIR;
if (!fs.existsSync(dir)) { console.log('(没有项目目录)'); process.exit(0); }

let renamed = 0, skipped = 0;

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.db')) continue;
  const full = path.join(dir, f);

  // 读出该库登记的项目显示名
  let displayName = null;
  try {
    const db = new DatabaseSync(full, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key='display_name'").get();
    db.close();
    displayName = row?.value || null;
  } catch (e) {
    console.log(`  [跳过] ${f} 读取失败: ${e.message}`);
    skipped++;
    continue;
  }

  if (!displayName) { console.log(`  [跳过] ${f} 没有登记 display_name`); skipped++; continue; }

  const target = path.join(dir, `${store.slugify(displayName)}.db`);
  if (path.resolve(target) === path.resolve(full)) { console.log(`  [已是目标名] ${f}`); skipped++; continue; }

  if (fs.existsSync(target)) { console.log(`  [冲突] 目标已存在，跳过: ${path.basename(target)}`); skipped++; continue; }

  fs.renameSync(full, target);
  console.log(`  [重命名] ${f}  ->  ${path.basename(target)}   (项目「${displayName}」)`);
  renamed++;
}

console.log(`\n完成: ${renamed} 个重命名, ${skipped} 个跳过`);
console.log('\n当前项目库:');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.db'))) {
  const p = path.join(dir, f);
  const db = new DatabaseSync(p, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
  db.close();
  console.log(`  ${f.padEnd(24)} ${String(n).padStart(3)} 条`);
}
