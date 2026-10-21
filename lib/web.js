/**
 * web.js —— 记忆库的 HTTP 接口（统计 / 搜索 / 导出 / 简单管理）
 * 路由前缀：/memory-anchor/*
 */
import fs from 'node:fs'
import path from 'node:path'
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

export function searchNodes(memRoot, query, limit = 30) {
  const q = String(query || '').trim()
  if (!q) return []
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`
  const out = []
  for (const { scope, file } of listDbs(memRoot)) {
    try {
      const db = openDb(file)
      try {
        const rows = db.prepare(`
          SELECT id, kind, title, summary, weight, updated_at
          FROM nodes
          WHERE (status IS NULL OR status <> 'deleted')
            AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT ?
        `).all(like, like, limit)
        for (const r of rows) out.push({ ...r, scope })
      } finally {
        db.close()
      }
    } catch { /* skip */ }
  }
  return out.slice(0, limit)
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

export function setNode(memRoot, scope, id, patch) {
  const target = dbFor(memRoot, scope)
  if (!target) return { ok: false, error: 'unknown scope' }
  const db = openDb(target.file, { write: true })
  try {
    if (patch.deleted) {
      db.prepare("UPDATE nodes SET status = 'deleted', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id)
      return { ok: true }
    }
    if (patch.corrected !== undefined) {
      db.prepare('UPDATE nodes SET corrected = ?, updated_at = ? WHERE id = ?').run(patch.corrected ? 1 : 0, new Date().toISOString(), id)
      return { ok: true }
    }
    return { ok: false, error: 'no supported patch' }
  } finally {
    db.close()
  }
}

export function setupWeb(ctx, { memRoot }) {
  const ws = ctx.get?.('webServer')
  if (!ws || typeof ws.register !== 'function') return false

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
      path: '/memory-anchor/search',
      handler: (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          json(res, 200, { items: searchNodes(memRoot, url.searchParams.get('q'), Number(url.searchParams.get('limit')) || 30) })
        } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
      },
    },
    {
      kind: 'exact',
      path: '/memory-anchor/export',
      handler: (_req, res) => {
        try {
          const data = exportAll(memRoot)
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
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
      path: '/memory-anchor/manage',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        void readBody(req).then((body) => {
          try {
            const { scope, id, deleted, corrected } = body || {}
            if (!scope || !id) return json(res, 400, { error: 'scope and id required' })
            json(res, 200, setNode(memRoot, scope, Number(id), { deleted: deleted === true, corrected }))
          } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
        }).catch((e) => json(res, 400, { error: String(e && e.message || e) }))
      },
    },
  ]

  try {
    const registerAll = () => {
      const disposers = []
      for (const r of routes) {
        try { disposers.push(ws.register(r)) } catch { /* route conflict */ }
      }
      return () => {
        for (const d of disposers) { try { d && d() } catch { /* ignore */ } }
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(registerAll)
    else registerAll()
    return true
  } catch {
    return false
  }
}