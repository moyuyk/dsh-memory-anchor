#!/usr/bin/env node
'use strict';
/**
 * move-memroot.js —— 把记忆库搬到新位置（复制 → 校验 → 删原件）
 * =============================================================
 *
 * 用法：
 *   node move-memroot.js <目标目录> --dry-run    只看计划
 *   node move-memroot.js <目标目录>              执行搬迁
 *
 * 安全设计：
 *   1. 先完整复制，再逐文件校验大小
 *   2. 校验通过后，把原目录改名成 .moved-<时间戳>（不直接删）
 *   3. 用新位置跑一次自检，确认可用
 *   4. 全绿才提示用户手动删除旧目录
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry-run');

if (!target) {
  console.error('用法: node move-memroot.js <目标目录> [--dry-run]');
  process.exit(1);
}

const SRC = path.resolve(__dirname, '..');           // 当前记忆库根
const DST = path.resolve(target);

console.log('记忆库搬迁');
console.log('='.repeat(70));
console.log('  源目录: ' + SRC);
console.log('  目标:   ' + DST);
console.log('  模式:   ' + (DRY ? '试运行（不实际复制）' : '正式搬迁'));
console.log('');

// ---------------------------------------------------------------- 前置检查

if (!fs.existsSync(SRC)) { console.error('[错误] 源目录不存在'); process.exit(1); }
if (SRC === DST) { console.error('[错误] 源和目标是同一个目录'); process.exit(1); }
if (DST.startsWith(SRC + path.sep)) { console.error('[错误] 目标不能是源的子目录'); process.exit(1); }
if (fs.existsSync(DST)) {
  const entries = fs.readdirSync(DST);
  if (entries.length > 0) {
    console.error('[错误] 目标目录已存在且非空: ' + DST);
    console.error('       请换一个位置，或先清空它。');
    process.exit(1);
  }
}

// 统计源目录
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push({ path: p, size: fs.statSync(p).size });
  }
  return out;
}

const srcFiles = walk(SRC);
const srcBytes = srcFiles.reduce((s, f) => s + f.size, 0);
console.log('源目录内容:');
console.log('  文件数: ' + srcFiles.length);
console.log('  总大小: ' + (srcBytes / 1024).toFixed(1) + ' KB');
console.log('');

// 检查是否在 DSH 会话日志范围内（日志不随本库搬移）
console.log('注意: DSH 会话日志仍在 ~/.dsh/sessions，不随本库搬移（由 DSH 内核管理）。');
console.log('      raw_ref 原文调取功能仍然可用。');
console.log('');

if (DRY) {
  console.log('试运行结束。去掉 --dry-run 执行正式搬迁。');
  process.exit(0);
}

// ---------------------------------------------------------------- 复制

console.log('步骤 1/4: 复制文件...');
fs.mkdirSync(DST, { recursive: true });
let copied = 0;
for (const f of srcFiles) {
  const rel = path.relative(SRC, f.path);
  const dest = path.join(DST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f.path, dest);
  copied++;
}
console.log('  已复制 ' + copied + ' 个文件');

// ---------------------------------------------------------------- 校验

console.log('');
console.log('步骤 2/4: 校验完整性...');
const dstFiles = walk(DST);
const dstBytes = dstFiles.reduce((s, f) => s + f.size, 0);

let mismatch = 0;
for (const f of srcFiles) {
  const rel = path.relative(SRC, f.path);
  const dest = path.join(DST, rel);
  if (!fs.existsSync(dest)) { console.error('  [缺失] ' + rel); mismatch++; continue; }
  const ds = fs.statSync(dest).size;
  if (ds !== f.size) { console.error('  [大小不符] ' + rel + ' ' + f.size + ' vs ' + ds); mismatch++; }
}

console.log('  源: ' + srcFiles.length + ' 文件 / ' + (srcBytes / 1024).toFixed(1) + ' KB');
console.log('  新: ' + dstFiles.length + ' 文件 / ' + (dstBytes / 1024).toFixed(1) + ' KB');
if (mismatch > 0) {
  console.error('\n[失败] ' + mismatch + ' 个文件校验不通过，未改动原目录。');
  console.error('       请检查后重试，或手动删除 ' + DST);
  process.exit(1);
}
console.log('  ✅ 全部一致');

// ---------------------------------------------------------------- 功能自检

console.log('');
console.log('步骤 3/4: 在新位置自检...');
const nodeExe = process.execPath;
const newMemJs = path.join(DST, 'bin', 'mem.js');
try {
  const out = execFileSync(nodeExe, [newMemJs, 'scopes'], { encoding: 'utf8', timeout: 30000 });
  const lines = out.split('\n').filter((l) => l.includes('条'));
  console.log('  ✅ 新位置可正常读取：');
  for (const l of lines) console.log('     ' + l.trim());
} catch (e) {
  console.error('  ❌ 新位置自检失败: ' + e.message);
  console.error('     原目录未改动，可安全放弃。');
  process.exit(1);
}

// ---------------------------------------------------------------- 旧目录改名

console.log('');
console.log('步骤 4/4: 处理原目录...');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = SRC + '.moved-' + stamp;
try {
  fs.renameSync(SRC, backup);
  console.log('  原目录已改名为: ' + backup);
} catch (e) {
  console.error('  [警告] 原目录改名失败（可能被占用）: ' + e.message);
  console.error('         新位置已就绪，请手动删除: ' + SRC);
  console.log('');
  console.log('搬迁已完成，但原目录仍在。');
  process.exit(0);
}

console.log('');
console.log('='.repeat(70));
console.log('✅ 搬迁完成');
console.log('  新位置: ' + DST);
console.log('  旧目录: ' + backup + '  （确认无误后可手动删除）');
console.log('');
console.log('下一步：更新 AGENTS.md 与技能文档里的路径。');
