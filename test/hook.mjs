/**
 * hook.mjs —— 首轮关键词命中测试
 * 用假 ctx 捕获 agent/pre-step，构造首条用户消息，验证命中条目被插到消息前。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-hook-'))
const memJs = path.join(here, '..', 'bin', 'mem.js')
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

execFileSync(process.execPath, [memJs, 'add', '--json-stdin'], {
  input: JSON.stringify({
    title: 'trigram 那个坑', summary: '中文检索 2 字词会 0 命中',
    kind: 'pitfall', scope: 'global', noAutoRaw: true,
  }),
  encoding: 'utf8',
  env,
})

const handlers = []
const ctx = {
  systemPrompt: { section: () => {} },
  tools: { register: () => {} },
  get: () => ({}),
  on: (ev, fn) => { if (ev === 'agent/pre-step') handlers.push(fn) },
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { memRoot: root })
assert.equal(handlers.length, 1, 'pre-step hook registered')

const decision = {
  kind: 'enter',
  messages: [{
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'trigram 那个坑怎么处理的' }],
    source: { kind: 'user' },
  }],
}
const out = await handlers[0](
  { agent: { session: { header: { id: 's1', origin: 'main' } } } },
  async () => decision
)

assert.ok(Array.isArray(out.messages), 'decision messages preserved')
assert.equal(out.messages.length, 2, 'one message injected')
assert.ok(String(out.messages[0].content[0].text).includes('trigram 那个坑'), 'hit content injected')
assert.equal(out.messages[1].id, 'u1', 'original user message kept after injection')

console.log('hook ok')
fs.rmSync(root, { recursive: true, force: true })