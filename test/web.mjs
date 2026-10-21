/**
 * web.mjs —— HTTP 接口函数测试
 * 覆盖：stats / search / export / manage（软删、标记纠正）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { collectStats, searchNodes, exportAll, setNode } from '../lib/web.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-web-'))
const memJs = path.join(here, '..', 'bin', 'mem.js')
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

const add = (payload) => execFileSync(process.execPath, [memJs, 'add', '--json-stdin'], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  env,
})

add({ title: 'Web 测试条目', summary: '验证 stats/search/export/manage', kind: 'fact', scope: 'global', noAutoRaw: true })
add({ title: '第二条', summary: '用于导出', kind: 'pitfall', scope: 'global', noAutoRaw: true })

const stats = collectStats(root)
assert.equal(stats.total, 2, 'stats counts both')
assert.equal(stats.scopes[0].scope, 'global')

const hits = searchNodes(root, 'Web')
assert.equal(hits.length, 1, 'search finds one')
assert.equal(hits[0].title, 'Web 测试条目')

const dump = exportAll(root)
assert.equal(dump.scopes[0].nodes.length, 2, 'export includes both')

assert.ok(setNode(root, 'global', 1, { deleted: true }).ok, 'soft delete works')
assert.equal(collectStats(root).total, 1, 'deleted node excluded')

assert.ok(setNode(root, 'global', 2, { corrected: true }).ok, 'corrected works')

console.log('web ok')
fs.rmSync(root, { recursive: true, force: true })