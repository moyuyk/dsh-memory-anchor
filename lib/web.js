/**
 * web.js —— 记忆库的 HTTP 接口（统计 / 搜索 / 导出 / 简单管理）
 * 路由前缀：/memory-anchor/*
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { cp } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'

function listDbs(memRoot) {
  const out = []
  const dbDir = path.join(memRoot, 'db')
  try {
    for (const f of fs.readdirSync(dbDir)) {
      if (!f.endsWith('.db')) continue
      const scope = f === 'global.db' ? 'global' : f === 'chat.db' ? 'chat' : null
      if (scope) out.push({ scope, file: path.join(dbDir, f) })
    }
  } catch { /* no dir */ }
  try {
    const projDir = path.join(dbDir, 'projects')
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.db')) continue
      out.push({ scope: 'proj:' + f.replace(/\.db$/i, ''), file: path.join(projDir, f) })
    }
  } catch { /* no projects */ }
  return out
}

function dbFor(memRoot, scope) {
  return listDbs(memRoot).find((x) => x.scope === scope) || null
}

function openDb(file, { write = false } = {}) {
  const db = new DatabaseSync(file, write ? {} : { readOnly: true })
  try { db.exec('PRAGMA busy_timeout = 5000') } catch { /* old sqlite */ }
  return db
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export function collectStats(memRoot) {
  const scopes = []
  for (const { scope, file } of listDbs(memRoot)) {
    try {
      const db = openDb(file)
      try {
        const total = db.prepare("SELECT COUNT(*) c FROM nodes WHERE status IS NULL OR status <> 'deleted'").get().c
        const byKind = db.prepare("SELECT kind, COUNT(*) c FROM nodes WHERE status IS NULL OR status <> 'deleted' GROUP BY kind ORDER BY c DESC").all()
        const recent = db.prepare("SELECT id, kind, title, updated_at FROM nodes WHERE status IS NULL OR status <> 'deleted' ORDER BY updated_at DESC LIMIT 5").all()
        scopes.push({ scope, total, byKind, recent })
      } finally {
        db.close()
      }
    } catch { /* skip broken db */ }
  }
  return { scopes, total: scopes.reduce((n, s) => n + s.total, 0) }
}

/** 单条详情：ref = "scope#id"；查不到返回 null */
export function getNode(memRoot, ref) {
  const s = String(ref || '')
  const i = s.lastIndexOf('#')
  if (i < 0) return null
  const scope = s.slice(0, i)
  const id = Number(s.slice(i + 1))
  if (!Number.isFinite(id)) return null
  const target = dbFor(memRoot, scope)
  if (!target) return null
  const db = openDb(target.file)
  try {
    const n = db.prepare(`
      SELECT id, kind, title, summary, body, tags, weight,
             created_at, updated_at, session_id, raw_ref, corrected, revision, status
      FROM nodes WHERE id = ?
    `).get(id)
    if (!n) return null
    return { ...n, scope, has_raw: Boolean(n.session_id || n.raw_ref) }
  } finally {
    db.close()
  }
}

export function exportAll(memRoot) {
  const scopes = []
  for (const { scope, file } of listDbs(memRoot)) {
    try {
      const db = openDb(file)
      try {
        const nodes = db.prepare("SELECT * FROM nodes WHERE status IS NULL OR status <> 'deleted' ORDER BY id").all()
        scopes.push({ scope, nodes })
      } finally {
        db.close()
      }
    } catch { /* skip */ }
  }
  return { version: 1, exportedAt: new Date().toISOString(), scopes }
}

/** 导出为可读 Markdown（一次性快照，不维护派生文件） */
export function exportMarkdown(memRoot) {
  const KIND = { pref: '画像', pitfall: '坑', decision: '决策', fact: '事实', state: '状态', todo: '待办', note: '笔记', session: '会话' }
  const data = exportAll(memRoot)
  let out = '# 记忆库导出\n\n'
  out += `> 导出时间：${data.exportedAt}\n\n`
  for (const s of data.scopes) {
    if (!s.nodes.length) continue
    out += `## ${s.scope}（${s.nodes.length} 条）\n\n`
    for (const n of s.nodes) {
      out += `### ${n.title}\n\n`
      out += `- 类型：${KIND[n.kind] || n.kind}　权重：${n.weight}　更新：${n.updated_at}\n`
      if (n.tags) out += `- 标签：${n.tags}\n`
      if (n.summary) out += `\n${n.summary}\n\n`
    }
  }
  return out
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function dirSize(dir) {
  let bytes = 0
  let files = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const sub = dirSize(p)
        bytes += sub.bytes
        files += sub.files
      } else {
        try { bytes += fs.statSync(p).size; files++ } catch { /* skip */ }
      }
    }
  } catch { /* missing */ }
  return { bytes, files }
}

/**
 * 备份到 <memRoot>/backups/<时间戳>/：
 *   db/ + config.json（总是）
 *   sessions/（可选，复制 DSH_HOME/sessions）
 */
async function makeBackup(memRoot, includeSessions, dshHome) {
  const base = path.join(memRoot, 'backups', backupStamp())
  fs.mkdirSync(base, { recursive: true })

  const dbSrc = path.join(memRoot, 'db')
  if (fs.existsSync(dbSrc)) await cp(dbSrc, path.join(base, 'db'), { recursive: true })

  const cfg = path.join(memRoot, 'config.json')
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(base, 'config.json'))

  let sessionsBytes = 0
  if (includeSessions) {
    const sess = path.join(dshHome, 'sessions')
    if (fs.existsSync(sess)) {
      await cp(sess, path.join(base, 'sessions'), { recursive: true })
      sessionsBytes = dirSize(path.join(base, 'sessions')).bytes
    }
  }

  const total = dirSize(base)
  return { ok: true, path: base, bytes: total.bytes, files: total.files, sessionsBytes }
}

function tarHeader(name, size, mtimeSec) {
  const buf = Buffer.alloc(512, 0)
  const safeName = Buffer.byteLength(name) > 100 ? name.slice(-100) : name
  buf.write(safeName, 0, 'utf8')
  buf.write('0000644\0', 100, 'ascii')
  buf.write('0000000\0', 108, 'ascii')
  buf.write('0000000\0', 116, 'ascii')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  buf.write(mtimeSec.toString(8).padStart(11, '0') + '\0', 136, 'ascii')
  buf.write('        ', 148, 'ascii')
  buf.write('0', 156, 'ascii')
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return buf
}

async function* walkEntries(root, prefix) {
  const stack = [{ dir: root, rel: prefix }]
  while (stack.length) {
    const cur = stack.pop()
    let items = []
    try { items = fs.readdirSync(cur.dir, { withFileTypes: true }) } catch { continue }
    for (const e of items) {
      const abs = path.join(cur.dir, e.name)
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push({ dir: abs, rel: rel + '/' })
      else if (e.isFile()) {
        let st
        try { st = fs.statSync(abs) } catch { continue }
        yield { name: rel.replace(/\/+/g, '/'), path: abs, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }
      }
    }
  }
}

/** 把若干目录/文件打成 tar.gz 流（零依赖，ustar + gzip） */
function tarGzStream(sources) {
  return Readable.from((async function* () {
    for (const src of sources) {
      if (src.file) {
        let st
        try { st = fs.statSync(src.file) } catch { continue }
        yield tarHeader(`${src.prefix}/${path.basename(src.file)}`, st.size, Math.floor(st.mtimeMs / 1000))
        const rs = fs.createReadStream(src.file)
        for await (const chunk of rs) yield chunk
        const pad = (512 - (st.size % 512)) % 512
        if (pad) yield Buffer.alloc(pad)
        continue
      }
      for await (const e of walkEntries(src.dir, src.prefix)) {
        yield tarHeader(e.name, e.size, e.mtime)
        if (e.size > 0) {
          const rs = fs.createReadStream(e.path)
          for await (const chunk of rs) yield chunk
        }
        const pad = (512 - (e.size % 512)) % 512
        if (pad) yield Buffer.alloc(pad)
      }
    }
    yield Buffer.alloc(1024)   // tar 结束块
  })()).pipe(zlib.createGzip())
}

function archiveSources(memRoot, includeSessions) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sources = []
  const dbDir = path.join(memRoot, 'db')
  if (fs.existsSync(dbDir)) sources.push({ dir: dbDir, prefix: 'memory/db' })
  const cfg = path.join(memRoot, 'config.json')
  if (fs.existsSync(cfg)) sources.push({ file: cfg, prefix: 'memory' })
  if (includeSessions) {
    const sess = path.join(dshHome, 'sessions')
    if (fs.existsSync(sess)) sources.push({ dir: sess, prefix: 'sessions' })
  }
  return sources
}

/** 导出到文件（测试 / CLI 复用） */
export async function archiveToFile(memRoot, includeSessions, dest) {
  const { pipeline } = await import('node:stream/promises')
  await pipeline(tarGzStream(archiveSources(memRoot, includeSessions)), fs.createWriteStream(dest))
  return dest
}

function sendArchive(req, res, memRoot, includeSessions) {
  const stamp = backupStamp()
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="memory-anchor-${stamp}.tar.gz"`,
    'cache-control': 'no-store',
  })
  const stream = tarGzStream(archiveSources(memRoot, includeSessions))
  stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
  stream.pipe(res)
}

export function setupWeb(ctx, { memRoot }) {
  const routes = [
    {
      kind: 'exact',
      path: '/memory-anchor/stats',
      handler: (_req, res) => {
        try { json(res, 200, collectStats(memRoot)) } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
      },
    },
    {
      kind: 'exact',
      path: '/memory-anchor/node',
      handler: (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const n = getNode(memRoot, url.searchParams.get('ref'))
          if (!n) return json(res, 404, { error: 'not found' })
          json(res, 200, n)
        } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
      },
    },
    {
      kind: 'exact',
      path: '/memory-anchor/export',
      handler: (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
          if (url.searchParams.get('format') === 'md') {
            res.writeHead(200, {
              'content-type': 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="memory-snapshot-${stamp}.md"`,
              'cache-control': 'no-store',
            })
            res.end(exportMarkdown(memRoot))
            return
          }
          const data = exportAll(memRoot)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="memory-snapshot-${stamp}.json"`,
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(data, null, 2))
        } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
      },
    },
    {
      kind: 'exact',
      path: '/memory-anchor/archive',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        void readBody(req).then((body) => {
          try {
            sendArchive(req, res, memRoot, body?.includeSessions === true)
          } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
        }).catch((e) => json(res, 400, { error: String(e && e.message || e) }))
      },
    },
    {
      kind: 'exact',
      path: '/memory-anchor/import',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        void readBody(req).then((body) => {
          try {
            const items = Array.isArray(body?.items) ? body.items : null
            if (!items) return json(res, 400, { error: 'items array required' })
            const scope = String(body?.scope || 'global')
            const tmp = path.join(os.tmpdir(), 'memory-anchor-import-' + Date.now() + '.json')
            fs.writeFileSync(tmp, JSON.stringify(items))
            const memjs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem.js')
            const out = execFileSync(process.execPath, [memjs, 'import', tmp, '--scope', scope], {
              encoding: 'utf8',
              env: { ...process.env, DSH_MEM_ROOT: memRoot },
            })
            try { fs.unlinkSync(tmp) } catch { /* ignore */ }
            json(res, 200, { ok: true, output: out.trim() })
          } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
        }).catch((e) => json(res, 400, { error: String(e && e.message || e) }))
      },
    },
  ]

  let disposed = false
  let timer = null
  let disposers = []

  const registerAll = (ws) => {
    disposers = []
    for (const r of routes) {
      try { disposers.push(ws.register(r)) } catch { /* route conflict */ }
    }
  }
  const trySetup = (attempt) => {
    if (disposed) return
    const ws = ctx.get?.('webServer')
    if (ws && typeof ws.register === 'function') { registerAll(ws); return }
    if (attempt < 20) timer = setTimeout(() => trySetup(attempt + 1), 1000)
  }
  trySetup(0)

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    for (const d of disposers) { try { d && d() } catch { /* ignore */ } }
  }
}