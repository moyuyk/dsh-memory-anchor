/**
 * smoke.mjs —— 最小可用性测试
 * ===========================
 * 覆盖：写入、检索、corrected 标记、插件两段注册、长期段注入、已纠正教训排除。
 * 全部在临时目录跑，不碰真实记忆库。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-smoke-'))
const memJs = path.join(here, '..', 'bin', 'mem.js')
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

const run = (args) => execFileSync(process.execPath, [memJs, ...args], { encoding: 'utf8', env })
const runJson = (args, payload) => execFileSync(process.execPath, [memJs, ...args], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  env,
})

// 1. 写入两条（fact + pitfall）
runJson(['add', '--json-stdin'], {
  title: 'smoke fact', summary: 'a durable fact for the smoke test',
  kind: 'fact', scope: 'global', noAutoRaw: true,
})
runJson(['add', '--json-stdin'], {
  title: 'smoke pitfall', summary: 'a lesson that was later corrected',
  kind: 'pitfall', scope: 'global', noAutoRaw: true,
})

// 2. 标记第二条为已纠正
run(['update', 'global#2', '--corrected', '1'])

// 3. 检索两条都在
const rows = JSON.parse(run(['search', 'smoke', '--json', '--scope', 'global']))
assert.equal(rows.length, 2, 'both memories are searchable')
assert.ok(rows.some((r) => r.title === 'smoke fact'), 'fact found')

// 4. list 显示 corrected 标记
const list = run(['list', '--scope', 'global'])
assert.ok(list.includes('✎已纠正'), 'corrected marker shown in list')

// 5. 插件入口注册两段
const { apply } = await import('../lib/index.js')
const sections = []
const ctx = {
  systemPrompt: { section: (s) => sections.push(s) },
  tools: { register: () => {} },
  on: () => {},
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { memRoot: root })
assert.ok(sections.some((s) => s.name === 'memory-anchor:sessions'), 'sessions section registered')
const mem = sections.find((s) => s.name === 'memory-anchor:memory')
assert.ok(mem, 'memory section registered')

// 6. 长期段：fact 注入，已纠正的 pitfall 不注入
const text = mem.text({ agent: { session: { header: { id: 'smoke' } } } })
assert.ok(text.includes('smoke fact'), 'uncorrected fact injected')
assert.ok(!text.includes('smoke pitfall'), 'corrected pitfall excluded')

console.log('smoke ok: ' + root)
fs.rmSync(root, { recursive: true, force: true })