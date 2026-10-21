/**
 * unit.mjs —— 存储与命令层测试
 * ===========================
 * 覆盖：中文检索、写守卫、revision CAS、export/import。
 * 全部在临时目录跑，不碰真实记忆库。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-unit-'))
const memJs = path.join(here, '..', 'bin', 'mem.js')
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

const run = (args) => execFileSync(process.execPath, [memJs, ...args], { encoding: 'utf8', env })
const runJson = (args, payload) => execFileSync(process.execPath, [memJs, ...args], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  env,
})
const tryRun = (args, payload) => {
  try {
    return { ok: true, out: payload === undefined ? run(args) : runJson(args, payload) }
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), code: e.status }
  }
}

// 1. 中文 2-gram 检索
runJson(['add', '--json-stdin'], {
  title: '数据库迁移', summary: '从 SQLite 迁移到 Postgres 的方案',
  kind: 'decision', scope: 'global', noAutoRaw: true,
})
const rows = JSON.parse(run(['search', '迁移', '--json', '--scope', 'global']))
assert.ok(rows.some((r) => r.title === '数据库迁移'), 'CJK 2-gram search works')

// 2. 写守卫：疑似密钥拒绝
const secret = tryRun(['add', '--json-stdin'], {
  title: '泄漏测试', summary: 'key sk-abcdefghijklmnopqrstuvwxyz123456',
  scope: 'global', noAutoRaw: true,
})
assert.equal(secret.ok, false, 'secret is rejected')
assert.ok(secret.out.includes('密钥') || secret.out.includes('secret'), 'secret error message')

// 3. revision CAS
runJson(['add', '--json-stdin'], {
  title: '版本测试', summary: '第一次', scope: 'global', noAutoRaw: true,
})
const before = JSON.parse(run(['search', '版本测试', '--json', '--scope', 'global']))[0]
assert.equal(Number(before.revision), 1, 'new node starts at revision 1')
const conflict = tryRun(['update', 'global#2', '--summary', '第二次', '--rev', '9'])
assert.equal(conflict.ok, false, 'wrong revision is rejected')
run(['update', 'global#2', '--summary', '第二次', '--rev', '1'])
const after = JSON.parse(run(['search', '版本测试', '--json', '--scope', 'global']))[0]
assert.equal(Number(after.revision), 2, 'revision increments after update')

// 4. export -> import（--scope 覆盖原 scope）
const exported = run(['export', '--scope', 'global', '--format', 'json'])
const items = JSON.parse(exported)
assert.ok(items.length >= 2, 'export returns all nodes')
fs.writeFileSync(path.join(root, 'export.json'), exported)
run(['import', path.join(root, 'export.json'), '--scope', 'chat'])
const chatRows = JSON.parse(run(['search', '数据库迁移', '--json', '--scope', 'chat']))
assert.ok(chatRows.length >= 1, 'import into a different scope works')

// 5. 宽松导入：兼容其他插件的 {text, tags, pinned} / {title, content}
fs.writeFileSync(path.join(root, 'legacy.json'), JSON.stringify([
  { text: '旧插件的一条记忆，只有 text 字段', tags: ['legacy'], pinned: true },
  { title: '旧插件带标题', content: '内容正文' },
]))
run(['import', path.join(root, 'legacy.json'), '--scope', 'chat'])
const legacyRows = JSON.parse(run(['search', '旧插件', '--json', '--scope', 'chat']))
assert.ok(legacyRows.length >= 2, 'legacy text/content import works')

console.log('unit ok')
fs.rmSync(root, { recursive: true, force: true })