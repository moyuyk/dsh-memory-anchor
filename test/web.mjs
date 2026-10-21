/**
 * web.mjs —— HTTP 接口函数测试
 * 覆盖：stats / node（单条详情）/ export（JSON + Markdown）/ archive
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { collectStats, getNode, exportAll, exportMarkdown, archiveToFile } from '../lib/web.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-web-'))
const memJs = path.join(here, '..', 'bin', 'mem.js')
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

const run = (args) => execFileSync(process.execPath, [memJs, ...args], { encoding: 'utf8', env })
const add = (payload) => execFileSync(process.execPath, [memJs, 'add', '--json-stdin'], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  env,
})

add({ title: 'Web 测试条目', summary: '验证 stats/node/export', kind: 'fact', scope: 'global', noAutoRaw: true })
add({ title: '第二条', summary: '用于导出', kind: 'pitfall', scope: 'global', noAutoRaw: true })

const stats = collectStats(root)
assert.equal(stats.total, 2, 'stats counts both')
assert.equal(stats.scopes[0].scope, 'global')

const node = getNode(root, 'global#1')
assert.equal(node.title, 'Web 测试条目', 'getNode returns the entry')
assert.equal(node.scope, 'global')
assert.equal(node.has_raw, false, 'no anchor here')
assert.equal(getNode(root, 'global#999'), null, 'missing id returns null')
assert.equal(getNode(root, 'no-such#1'), null, 'unknown scope returns null')

const dump = exportAll(root)
assert.equal(dump.scopes[0].nodes.length, 2, 'export includes both')

const md = exportMarkdown(root)
assert.ok(md.includes('# 记忆库导出'), 'markdown header')
assert.ok(md.includes('### Web 测试条目'), 'markdown includes entry')
assert.ok(md.includes('类型：事实'), 'markdown includes kind')

// 软删（CLI）后 stats 排除、getNode 仍能看到 status
run(['rm', 'global#1'])
assert.equal(collectStats(root).total, 1, 'deleted node excluded from stats')
assert.equal(getNode(root, 'global#1').status, 'deleted', 'getNode exposes status')

// 归档导出（tar.gz）
const gz = path.join(root, 'backup.tar.gz')
await archiveToFile(root, false, gz)
assert.ok(fs.existsSync(gz) && fs.statSync(gz).size > 0, 'archive written')
const list = execFileSync('tar', ['-tzf', gz], { encoding: 'utf8' })
assert.ok(list.includes('memory/db/global.db'), 'archive contains db')

console.log('web ok')
fs.rmSync(root, { recursive: true, force: true })