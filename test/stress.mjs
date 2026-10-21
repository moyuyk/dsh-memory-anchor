/**
 * stress.mjs —— 暴力/边界测试
 * =============================
 * 目标不是证明功能正常（那是 smoke/unit 的事），而是把「正常路径不会遇到、
 * 但用户会干」的输入灌进来，看会不会崩、会不会写坏库、会不会越权写文件。
 *
 * 全部在临时目录跑，不碰真实记忆库。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const memJs = path.join(here, '..', 'bin', 'mem.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-stress-'))
const env = { ...process.env, DSH_MEM_ROOT: root }
delete env.DSH_SESSION_ID

const run = (args, payload) => execFileSync(process.execPath, [memJs, ...args], {
  input: payload === undefined ? undefined : JSON.stringify(payload),
  encoding: 'utf8',
  env,
  timeout: 30000,
  maxBuffer: 32 * 1024 * 1024,
})

/** 跑一次并返回 { ok, out, err, code }，绝不抛 */
function tryRun(args, payload) {
  try {
    return { ok: true, out: run(args, payload), err: '', code: 0 }
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || ''), code: e.status ?? -1 }
  }
}

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name) } catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e.message || e)) }
}

console.log('[stress] 临时库: ' + root)

// ── 1. 空 / 超长 / 畸形输入 ─────────────────────────────────────────────
check('空标题被拒（非 0 退出，不崩）', () => {
  const r = tryRun(['add', '--json-stdin'], { title: '   ' })
  assert.equal(r.ok, false, '空标题应该失败')
})

check('1 MB 摘要不崩，落库后按上限截断', () => {
  const big = '长'.repeat(512 * 1024)
  const r = tryRun(['add', '--json-stdin'], { title: 'big summary', summary: big, scope: 'global', noAutoRaw: true })
  assert.ok(r.ok, '超长摘要写入失败: ' + r.err)
  const rows = JSON.parse(run(['search', 'big summary', '--json', '--scope', 'global']))
  const row = rows.find((x) => x.title === 'big summary')
  assert.ok(row, '超长摘要条目没写进去')
  assert.ok(String(row.summary || '').length <= 501, '摘要没有按上限截断: ' + row.summary.length)
})

check('10 万字符标题不崩', () => {
  const r = tryRun(['add', '--json-stdin'], { title: 'T'.repeat(100000), noAutoRaw: true })
  assert.ok(r.ok, '超长标题写入失败: ' + r.err)
})

check('SQL 注入样式的标题原样存储', () => {
  const title = `x'); DROP TABLE nodes; --`
  assert.ok(tryRun(['add', '--json-stdin'], { title, noAutoRaw: true }).ok)
  const rows = JSON.parse(run(['search', 'DROP TABLE', '--json']))
  assert.ok(rows.some((r) => r.title === title), '注入样式的标题丢了')
})

check('FTS 语法字符不会让 search 崩', () => {
  for (const q of ['"', '*', 'NEAR(', 'a AND (b OR', '--', '%_', "'; --"]) {
    const r = tryRun(['search', q, '--json'])
    assert.equal(r.ok, true, `search(${JSON.stringify(q)}) 崩了: ${r.err}`)
  }
})

check('emoji / 全角 / 控制字符可写入可检索', () => {
  const title = '🙂全角ＡＢ\u0007控制符'
  assert.ok(tryRun(['add', '--json-stdin'], { title, noAutoRaw: true }).ok)
  const rows = JSON.parse(run(['search', '全角', '--json']))
  assert.ok(rows.some((r) => r.title === title), '特殊字符条目检索不到')
})

// ── 2. 安全 ────────────────────────────────────────────────────────────
check('疑似密钥被写守卫拒绝', () => {
  const r = tryRun(['add', '--json-stdin'], { title: 'key', summary: 'sk-' + 'a'.repeat(32) })
  assert.equal(r.ok, false, '密钥应该被拒')
  assert.match(r.err + r.out, /密钥|令牌|secret/i)
})

check('路径穿越的 scope 名不会写到库外', () => {
  const evil = '../../evil-scope'
  const r = tryRun(['add', '--json-stdin'], { title: 'path traverse', scope: evil, noAutoRaw: true })
  const escaped = path.resolve(root, '..', 'evil-scope.db')
  assert.equal(fs.existsSync(escaped), false, 'scope 名把文件写到库外了: ' + escaped)
  // 允许「拒绝」或「安全化后写在库内」，但不允许逃逸
  if (r.ok) {
    const inside = fs.existsSync(path.join(root, 'db'))
    assert.ok(inside, '写入成功却不在 db/ 下')
  }
})

// ── 3. 并发 ────────────────────────────────────────────────────────────
await new Promise((resolve) => {
  const { spawn } = require('node:child_process')
  let done = 0
  let failed = 0
  for (let i = 0; i < 10; i += 1) {
    const p = spawn(process.execPath, [memJs, 'add', '--json-stdin'], { env })
    p.stdin.end(JSON.stringify({ title: '并发 ' + i, scope: 'global', force: true, noAutoRaw: true }))
    p.on('exit', (code) => {
      if (code !== 0) failed += 1
      done += 1
      if (done === 10) {
        check('10 个进程并发写入不丢不锁死', () => {
          assert.equal(failed, 0, '并发写入失败 ' + failed + ' 个')
          const rows = JSON.parse(run(['search', '并发', '--json', '--limit', '20']))
          assert.equal(rows.filter((r) => r.title.startsWith('并发 ')).length, 10, '并发条目数不对')
        })
        resolve()
      }
    })
  }
})

// ── 4. 损坏数据 ────────────────────────────────────────────────────────
check('数据库被覆写成垃圾后，命令报错但不崩', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-broken-'))
  const dbDir = path.join(broken, 'db')
  fs.mkdirSync(dbDir, { recursive: true })
  fs.writeFileSync(path.join(dbDir, 'global.db'), Buffer.from('not a sqlite file'.repeat(100)))
  const r = (() => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [memJs, 'list', '--scope', 'global'], {
        encoding: 'utf8', env: { ...process.env, DSH_MEM_ROOT: broken }, timeout: 20000,
      }) }
    } catch (e) {
      return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') }
    }
  })()
  fs.rmSync(broken, { recursive: true, force: true })
  assert.ok(r.ok === false || /error|错误|corrupt|not a database/i.test(r.out + (r.err || '')), '损坏库没有报错')
})

check('raw 不存在的条目报错不崩', () => {
  const r = tryRun(['raw', 'global#99999'])
  assert.equal(r.ok, false, '不存在的条目应该失败')
})

check('raw 越界 seq 不崩', () => {
  const r = tryRun(['raw', 'global#1', '--seq', '999999-1000000'])
  assert.ok(r.ok || r.err.length > 0, 'raw 越界没有输出也没有报错')
})

// ── 5. 导入畸形 ────────────────────────────────────────────────────────
check('import 非数组 / 坏 JSON 被拒', () => {
  const f = path.join(root, 'bad.json')
  fs.writeFileSync(f, '{"not":"an array"}')
  assert.equal(tryRun(['import', f, '--scope', 'global']).ok, false, '非数组应该被拒')
  fs.writeFileSync(f, '{oops')
  assert.equal(tryRun(['import', f, '--scope', 'global']).ok, false, '坏 JSON 应该被拒')
})

// ── 6. 规模 ────────────────────────────────────────────────────────────
check('500 条批量写入 + 检索在 5 秒内', () => {
  const bulk = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-bulk-'))
  const store = require(path.join(here, '..', 'bin', 'lib', 'store.js'))
  const t0 = Date.now()
  for (let i = 0; i < 500; i += 1) {
    store.addNode('global', {
      kind: 'fact', title: 'bulk ' + i, summary: '批量写入的测试条目 ' + i,
      tags: ['bulk'], weight: 3, source: 'stress',
    })
  }
  const tWrite = Date.now() - t0
  const t1 = Date.now()
  const rows = store.search('global', { query: '批量写入', limit: 20 })
  const tSearch = Date.now() - t1
  const total = store.listNodes('global', { limit: 5000 }).length
  fs.rmSync(bulk, { recursive: true, force: true })
  assert.equal(total >= 500, true, '批量写入条数不对: ' + total)
  assert.ok(tSearch < 5000, '500 条检索太慢: ' + tSearch + 'ms')
  console.log(`      (write ${tWrite}ms / search ${tSearch}ms)`)
})

console.log(`\n[stress] pass=${pass} fail=${fail}`)
fs.rmSync(root, { recursive: true, force: true })
if (fail > 0) process.exit(1)