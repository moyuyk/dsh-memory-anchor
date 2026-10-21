/**
 * dsh-memory-anchor —— 跨会话记忆注入
 * =====================================
 *
 * 每轮把「最近几个会话各在做什么」注入系统提示，让新会话不用等用户说
 * 「接着做」就知道之前发生过什么。更早的内容靠 mem.js search 检索。
 *
 * 注入的是**会话摘要**，不是记忆条目：
 *   - 10-19 20:00「读交接文档」→ 规则精简对比；身份设定（67轮，改27文件）
 *   - 10-19 19:47「在你的全域规则中加入以下规则」→ AGENTS.md；联网搜规则（8轮，改3文件）
 *
 * 为什么按会话而不是按条目：按条目选会让「写得多的那个会话」垄断注入
 * （实测当前会话 9 条全进、上次会话 1 条被挤掉），跨会话记忆就失效了。
 *
 * 设计约束：
 *   - 只依赖 node:fs / node:path / node:module + 记忆库自己的 lib/*.js（CommonJS）。
 *     不引入任何第三方包，不碰 @deepseek-ai/*（2026-10-19 dsh-trim 的依赖把 DSH 启动搞崩过）。
 *   - fail-open：任何异常返回空字符串，绝不让插件把会话搞挂。
 *   - 只读：不写记忆库、不写会话日志。
 *   - 进程内缓存：会话文件没变就不重新解压（2 MB 会话解压约 100ms，每轮跑会拖慢响应）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { summarizeSession, renderSummaryLine } from './summary.js'

export const name = 'memory-anchor'
export const version = '0.4.0'

// cordis：访问服务前必须声明依赖，否则 ctx.systemPrompt 会抛
// "cannot get property \"systemPrompt\" without inject"。这就是此前静默失败的原因。
export const inject = ['systemPrompt']

const DEFAULTS = {
  memRoot: '',
  maxSessions: 10,        // 最多注入几个会话
  maxScan: 20,            // 只扫最近这么多个会话文件（按 mtime），不全量解压
  maxChars: 1200,         // 注入总字符上限
  lineChars: 150,         // 每行最大字符
  titleChars: 42,         // 会话标题截断
  askCount: 2,            // 每个会话补充几条诉求
  includeEmpty: false,    // 是否包含空会话
  enabled: true,
}

const HEADER = '你之前的会话（按时间倒序；细节用 mem.js search 查）：'
const TAIL = '（更多历史用 mem.js search "关键词" 检索）'

// ---- 长期记忆段（2026-10-21 加）：画像 / 教训 / 决策 ----
// 和会话段的区别：会话段回答「上次干了什么」，这段回答「我是谁、踩过什么坑」。
// 独立 section + 独立预算，不挤会话段的 1200 字。
const MEMORY_HEADER = '你记得的长期要点（按重要性；细节用 memory_search 查）：'
const MEMORY_MAX_CHARS = 600          // 硬上限（字符），防止渲染异常时失控
const MEMORY_MAX_TOKENS = 400         // 正常预算（token 估算）
const MEMORY_MAX_ITEMS = 8
const MEMORY_KIND_WEIGHT = {
  pref: 1.0,       // 用户画像
  pitfall: 0.9,    // 教训
  decision: 0.7,
  fact: 0.5,
  state: 0.4,
  todo: 0.4,
  note: 0.3,
  session: 0.2,
}
const MEMORY_KIND_LABEL = {
  pref: '画像', pitfall: '坑', decision: '决策', fact: '事实',
  state: '状态', todo: '待办', note: '笔记', session: '会话',
}

/**
 * 粗略 token 估算：中日韩字符 ≈ 0.65 token/字，拉丁 ≈ 0.3 token/字符。
 * 不引入 tokenizer 依赖；只用于预算截断，不要求精确。
 */
function estimateTokens(text) {
  let n = 0
  for (const ch of String(text || '')) {
    n += ch.codePointAt(0) > 0x2e80 ? 0.65 : 0.3
  }
  return Math.ceil(n)
}

/** CJK 2-gram + 英文词，用于首轮关键词命中 */
function cjkBigrams(text) {
  const out = new Set()
  for (const seg of String(text || '').match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length === 1) continue
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || []) out.add(w)
  return [...out]
}

/**
 * 首轮关键词命中：拿用户第一句话去匹配 global 库里的教训/决策/事实，
 * 命中 top 3 拼成一条消息，插到首条用户消息之前。
 *
 * 和固定注入的区别：这是「用户提到才塞」，不占每轮固定预算。
 * 已纠正的教训不参与。
 */
function firstTurnHits(memRoot, text, excludeIds = new Set()) {
  try {
    const dbFile = path.join(memRoot, 'db', 'global.db')
    if (!fs.existsSync(dbFile)) return { text: '', ids: [] }
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const hasCorrected = (() => {
        try { return db.prepare('PRAGMA table_info(nodes)').all().some((c) => c.name === 'corrected') } catch { return false }
      })()
      const correctedFilter = hasCorrected ? " AND (kind <> 'pitfall' OR COALESCE(corrected, 0) = 0)" : ''
      const rows = db.prepare(`
        SELECT id, kind, title, summary, weight
        FROM nodes
        WHERE (status IS NULL OR status <> 'deleted')
          AND (valid_until IS NULL OR valid_until = '')
          AND kind IN ('pitfall','decision','fact')${correctedFilter}
      `).all()
      const q = new Set(cjkBigrams(text))
      if (!q.size || !rows.length) return { text: '', ids: [] }
      const scored = rows.map((r) => {
        const d = new Set(cjkBigrams(`${r.title} ${r.summary}`))
        let hit = 0
        for (const t of q) if (d.has(t)) hit++
        return { ...r, score: hit / q.size + (Number(r.weight) - 3) * 0.02 }
      }).filter((r) => r.score >= 0.08 && !excludeIds.has(r.id))
        .sort((a, b) => b.score - a.score).slice(0, 3)
      if (!scored.length) return { text: '', ids: [] }
      const lines = scored.map((r) => {
        const label = MEMORY_KIND_LABEL[r.kind] || r.kind
        const summary = String(r.summary || '').replace(/\s+/g, ' ').trim()
        return `- [${label}] ${r.title}${summary && summary !== r.title ? '：' + summary.slice(0, 60) : ''}`
      })
      return { text: '【本次相关记忆（来自长期记忆库）】\n' + lines.join('\n'), ids: scored.map((r) => r.id) }
    } finally {
      db.close()
    }
  } catch {
    return { text: '', ids: [] }
  }
}

const DEBUG_LOG = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-anchor-debug.log')

/** 代码自带的 bin/lib（发布包内），与数据目录解耦 */
const PKG_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin')
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch { /* 日志失败绝不影响插件 */ }
}

function resolveMemRoot(cfg) {
  if (cfg.memRoot) return path.resolve(cfg.memRoot)
  if (process.env.DSH_MEM_ROOT) return path.resolve(process.env.DSH_MEM_ROOT)
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory')
}

/** 会话摘要缓存：key = sessionId, value = { mtimeMs, size, summary } */
const cache = new Map()
/** 缓存落盘：重启后首轮不用把最近会话全部重算一遍 */
let cacheDirty = false
let cacheFile = ''

function loadSummaryCache(memRoot) {
  cacheFile = path.join(memRoot, 'cache', 'session-summaries.json')
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && typeof v === 'object') cache.set(k, v)
    }
  } catch { /* 没有缓存或坏了，重算即可 */ }
}

function saveSummaryCache() {
  if (!cacheDirty || !cacheFile) return
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    const out = {}
    let n = 0
    for (const [k, v] of cache) {
      if (n++ >= 200) break
      out[k] = v
    }
    fs.writeFileSync(cacheFile, JSON.stringify(out))
    cacheDirty = false
  } catch { /* 写失败不影响注入 */ }
}

/**
 * 冻结的注入文本：key = sessionId, value = 已渲染好的文本。
 * 同一会话内逐字节相同，保证系统提示词不变 → 提供方前缀缓存可复用。
 * 见 apply() 里的「冻结策略」注释。
 */
const frozenBySession = new Map()

/** 长期记忆段的冻结文本（与会话段分开，互不影响） */
const frozenMemoryBySession = new Map()

/** 长期记忆段缓存：60 秒内不重复读库（每轮都调） */
let memorySectionCache = { at: 0, text: '' }

function getLibs(memRoot) {
  // 优先发布包自带的 bin/lib；老布局（代码与数据同根）再回退到 memRoot/bin/lib
  const candidates = [path.join(PKG_BIN, 'lib'), path.join(memRoot, 'bin', 'lib')]
  const binDir = candidates.find((d) => {
    try { return fs.existsSync(path.join(d, 'session-log.js')) && fs.existsSync(path.join(d, 'messages.js')) } catch { return false }
  })
  if (!binDir) return null
  const sl = path.join(binDir, 'session-log.js')
  const ms = path.join(binDir, 'messages.js')
  const req = createRequire(import.meta.url)
  return {
    ...req(sl),
    ...req(ms),
  }
}

/**
 * 读记忆库：按「该会话产出了多少条记忆」给会话打分。
 *
 * 2026-10-20 改数据源：原来读 node_raw.session_id，现在读 nodes.session_id。
 * 原因：node_raw 的原文副本已瘦身（原文真源改为 DSH 会话日志），
 * 而 nodes.session_id 早在 2026-10-19 就已回填，实测 21/21 非空，
 * 且与 node_raw.session_id 完全一致，价值分排序结果不变。
 */
function loadSessionValue(memRoot) {
  const map = new Map()
  try {
    const dbDir = path.join(memRoot, 'db')
    const files = []
    if (fs.existsSync(dbDir)) {
      for (const f of fs.readdirSync(dbDir)) if (f.endsWith('.db')) files.push(path.join(dbDir, f))
    }
    const projDir = path.join(dbDir, 'projects')
    if (fs.existsSync(projDir)) {
      for (const f of fs.readdirSync(projDir)) if (f.endsWith('.db')) files.push(path.join(projDir, f))
    }
    for (const file of files) {
      let db
      try { db = new DatabaseSync(file, { readOnly: true }) } catch { continue }
      try {
        // 条数用 COUNT(*)，体量用摘要总长度（原文副本已不再写入）
        const rows = db.prepare(
          `SELECT session_id, COUNT(*) c, COALESCE(SUM(LENGTH(summary)),0) s
           FROM nodes
           WHERE session_id IS NOT NULL AND session_id <> ''
             AND (status IS NULL OR status <> 'deleted')
           GROUP BY session_id`
        ).all()
        for (const r of rows) {
          if (!r.session_id) continue
          const cur = map.get(r.session_id) || { count: 0, chars: 0 }
          cur.count += r.c
          cur.chars += r.s
          map.set(r.session_id, cur)
        }
      } catch { /* 老库结构异常时跳过 */ } finally { db.close() }
    }
  } catch { /* fail-open：读不到就当没有价值信号 */ }
  return map
}

/** 价值信号缓存 60 秒：注入每轮都调，但记忆条数不会秒级变化 */
let valueCache = { at: 0, map: new Map() }
function getSessionValue(memRoot) {
  if (Date.now() - valueCache.at < 60_000) return valueCache.map
  valueCache = { at: Date.now(), map: loadSessionValue(memRoot) }
  return valueCache.map
}

/** 生成注入文本；任何异常返回空串 */
function renderSection(cfg, excludeSessionId) {
  const memRoot = resolveMemRoot(cfg)
  if (!cacheFile) loadSummaryCache(memRoot)
  const libs = getLibs(memRoot)
  if (!libs) return ''

  let sessions
  try {
    sessions = libs.listSessions()
  } catch {
    return ''
  }
  if (!sessions.length) return ''

  // 只扫最新的 maxScan 个会话文件：listSessions 已按 mtime 倒序。
  // 会话多了以后全量解压+摘要会线性变慢，没必要为「可能有用」付这个成本。
  const candidates = sessions.slice(0, Math.max(1, cfg.maxScan))

  // 价值信号：该会话在记忆库里产出了多少条记忆。
  // 产出多的会话更可能是「正事」，测试性/闲聊性会话得分低。
  const valueMap = getSessionValue(memRoot)

  const items = []
  for (const s of candidates) {
    if (excludeSessionId && s.sessionId === excludeSessionId) continue
    if (!cfg.includeEmpty && (!s.bytes || s.bytes < 1024)) continue

    const cached = cache.get(s.sessionId)
    let summary
    if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.bytes) {
      summary = cached.summary
    } else {
      try {
        summary = summarizeSession(s.filePath, libs, {
          titleChars: cfg.titleChars,
          maxUserMsgs: 1 + cfg.askCount,
        })
      } catch {
        summary = null
      }
      cache.set(s.sessionId, { mtimeMs: s.mtimeMs, size: s.bytes, summary })
      cacheDirty = true
    }

    if (!summary) continue
    const lastTime = summary.lastTime || summary.firstTime || 0
    const mem = valueMap.get(s.sessionId) || { count: 0, chars: 0 }
    // 价值分：1 起步；产出 1 条记忆 → +2；10 条 → +6.9；再按原文体量、改文件数给加分
    const value = 1 + 2 * Math.log2(1 + mem.count) + 0.5 * Math.log2(1 + mem.chars / 1000)
      + 0.3 * Math.log2(1 + (summary.fileCount || 0))
    // 时间衰减：14 天半衰期，温和加权，不让它把「产出多」完全抹掉
    const ageDays = lastTime ? (Date.now() - lastTime) / 86400000 : 365
    const recency = Math.pow(0.5, Math.max(0, ageDays) / 14)
    items.push({ summary, lastTime, value, score: value * recency })
  }

  items.sort((a, b) => b.score - a.score)
  dbg(`[value] candidates=${candidates.length}; top=${items.slice(0, 3).map((i) => `${i.summary.title.slice(0, 12)}:${i.score.toFixed(1)}`).join(' | ')}`)

  const lines = []
  let used = HEADER.length + TAIL.length + 2
  for (const it of items) {
    if (lines.length >= cfg.maxSessions) break
    const line = renderSummaryLine(it.summary, { maxChars: cfg.lineChars })
    if (used + line.length + 1 > cfg.maxChars) break
    lines.push(line)
    used += line.length + 1
  }

  if (!lines.length) { saveSummaryCache(); return '' }
  saveSummaryCache()
  return HEADER + '\n' + lines.join('\n') + '\n' + TAIL
}

/**
 * 生成「长期记忆」段：从 global 库取画像 / 教训 / 决策，按权重排序。
 *
 * 和会话段的区别：这段回答「我是谁、踩过什么坑」，会话段回答「上次干了什么」。
 * 排序 = kind 权重 × 条目权重 × 时间衰减（30 天半衰），pinned 直接置顶。
 * 只读 global；项目细节需要时用 memory_search --scope proj:xxx 查。
 */
function renderMemorySection(memRoot) {
  if (Date.now() - memorySectionCache.at < 60_000) return memorySectionCache.text

  let text = ''
  try {
    const dbFile = path.join(memRoot, 'db', 'global.db')
    if (fs.existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile, { readOnly: true })
      try {
        // corrected=1 的教训不再注入（它已经被纠正过）；老库没有该列时自动跳过过滤
        const hasCorrected = (() => {
          try { return db.prepare('PRAGMA table_info(nodes)').all().some((c) => c.name === 'corrected') } catch { return false }
        })()
        const correctedFilter = hasCorrected ? " AND (kind <> 'pitfall' OR COALESCE(corrected, 0) = 0)" : ''

        const rows = db.prepare(`
          SELECT id, kind, title, summary, weight, pinned, created_at
          FROM nodes
          WHERE (status IS NULL OR status <> 'deleted')
            AND (valid_until IS NULL OR valid_until = '')
            AND kind IN ('pref','pitfall','decision','fact')${correctedFilter}
        `).all()

        const now = Date.now()
        const scored = rows.map((r) => {
          const ts = new Date(String(r.created_at || '').replace(' ', 'T')).getTime()
          const ageDays = Number.isFinite(ts) ? Math.max(0, (now - ts) / 86400000) : 0
          const recency = Math.pow(0.5, ageDays / 30)
          const kw = MEMORY_KIND_WEIGHT[r.kind] ?? 0.5
          const w = Math.max(0.1, 1 + (Number(r.weight) - 3) * 0.15)
          return { ...r, score: kw * w * recency + (r.pinned ? 2 : 0) }
        }).sort((a, b) => b.score - a.score)

        // 画像优先：先把 pref 全放进去，再按分数补坑/决策，避免画像被高权重坑挤掉
        const ordered = [
          ...scored.filter((r) => r.kind === 'pref').slice(0, 4),
          ...scored.filter((r) => r.kind !== 'pref'),
        ]

        const lines = []
        let usedChars = MEMORY_HEADER.length + 2
        let usedTokens = estimateTokens(MEMORY_HEADER)
        for (const r of ordered) {
          if (lines.length >= MEMORY_MAX_ITEMS) break
          const label = MEMORY_KIND_LABEL[r.kind] || r.kind
          const title = String(r.title || '').replace(/\s+/g, ' ').trim()
          const summary = String(r.summary || '').replace(/\s+/g, ' ').trim()
          const clipped = summary.length > 40 ? summary.slice(0, 40) + '…' : summary
          const detail = clipped && clipped !== title ? '：' + clipped : ''
          const line = `- [${label}] ${title}${detail}`
          const chars = line.length + 1
          const tokens = estimateTokens(line) + 1
          if (usedChars + chars > MEMORY_MAX_CHARS || usedTokens + tokens > MEMORY_MAX_TOKENS) break
          lines.push(line)
          usedChars += chars
          usedTokens += tokens
        }
        if (lines.length) text = MEMORY_HEADER + '\n' + lines.join('\n')
      } finally {
        db.close()
      }
    }
  } catch {
    text = ''   // fail-open：读不到就当没有，不影响会话
  }

  memorySectionCache = { at: Date.now(), text }
  return text
}

function normalize(c = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    memRoot: typeof c.memRoot === 'string' ? c.memRoot : DEFAULTS.memRoot,
    maxSessions: num(c.maxSessions, DEFAULTS.maxSessions),
    maxScan: num(c.maxScan, DEFAULTS.maxScan),
    maxChars: num(c.maxChars, DEFAULTS.maxChars),
    lineChars: num(c.lineChars, DEFAULTS.lineChars),
    titleChars: num(c.titleChars, DEFAULTS.titleChars),
    askCount: num(c.askCount, DEFAULTS.askCount),
    includeEmpty: c.includeEmpty === true,
    enabled: c.enabled !== false,
  }
}

export function apply(ctx, config) {
  const cfg = normalize(config || {})
  const log = (msg) => {
    dbg(`[log] ${msg}`)
    try { ctx.logger && ctx.logger.info && ctx.logger.info(`[memory-anchor] ${msg}`) } catch { /* ignore */ }
  }

  dbg(`[apply] start; systemPrompt=${typeof ctx.systemPrompt}; section=${typeof (ctx.systemPrompt && ctx.systemPrompt.section)}; inject=${typeof ctx.inject}`)

  if (!cfg.enabled) { log('disabled by config'); return }

  for (const key of ['maxSessions', 'maxScan', 'maxChars', 'lineChars', 'titleChars', 'askCount']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 0) {
      throw new Error(`[memory-anchor] ${key} 必须是非负整数（收到 ${cfg[key]}）`)
    }
  }

  const memRoot = resolveMemRoot(cfg)
  const libsOk = [path.join(PKG_BIN, 'lib'), path.join(memRoot, 'bin', 'lib')]
    .some((d) => { try { return fs.existsSync(path.join(d, 'session-log.js')) } catch { return false } })
  if (!libsOk) {
    log(`记忆库模块不存在（${memRoot}），插件不挂载`)
    return
  }

  const register = (scope, tag) => {
    try {
      if (!scope || !scope.systemPrompt || typeof scope.systemPrompt.section !== 'function') {
        dbg(`[apply] skip (${tag}): systemPrompt.section unavailable`)
        return
      }
      scope.systemPrompt.section({
        name: 'memory-anchor:sessions',
        // order 从 55 改到 10150（2026-10-20）。
        //
        // 原因：官方 dsh-agent-loop 明确「前缀复用要求此前消息和声明逐字节一致；
        // 原地替换某个系统节点的提示词变更会使请求从该节点的第一个 token 起就不同」。
        // 系统提示词就是第 0 号节点 → 这段一变，整个请求的提供方前缀缓存全废。
        //
        // 旧值 55 落在 SECTION_ORDERS 里 persona(0) 与 PLAN_POLICY(500) 之间，
        // 后面依次是全部工具指导(1000-3000)、TOOLS_SDK(5000)、
        // STRUCTURED_OUTPUT(9900)、HARNESS_SOURCE(10000)、WEB_SURFACE(10100)，
        // 即「它一变，后面全部失效」。
        //
        // 新值 10150 在 WEB_SURFACE(10100) 之后、DEPLOYMENT_PERSONA_SUFFIX(10200) 之前，
        // 是倒数第二段。同样的变化只会让尾部失效，前面整块前缀保持可复用。
        order: 10150,
        text: (context) => {
          try {
            // 排除当前会话：把会话自己的摘要喂给自己没有意义，还白占 token。
            const currentId = context?.agent?.session?.header?.id

            // 冻结策略（2026-10-20 加）：
            // 同一会话内，注入文本只在第一次组装时计算，之后逐字节返回同一份。
            //
            // 为什么：官方 dsh-agent-loop 要求「前缀复用要求此前消息和声明逐字节一致」。
            // 之前每轮都调 renderSection() 重算，虽然实测 7 天内排序没翻，
            // 但底部两组分数只差 0.0007（a5063437 1.000 vs 70140598 0.956），
            // 时间衰减再走一点就会翻转 → 系统提示词变化 → 缓存全失效。
            // 冻结后同一会话内 100% 稳定，翻转只可能发生在下次新会话，不影响已建立的缓存。
            if (currentId) {
              const cached = frozenBySession.get(currentId)
              if (cached !== undefined) {
                dbg(`[text] frozen hit (${tag}); exclude=${currentId}; len=${cached.length}`)
                return cached
              }
            }

            const out = renderSection(cfg, currentId)
            if (currentId) {
              // 上限 50 个会话，防止长跑的 DSH 进程无限增长
              if (frozenBySession.size >= 50) {
                const oldest = frozenBySession.keys().next().value
                frozenBySession.delete(oldest)
              }
              frozenBySession.set(currentId, out)
            }
            dbg(`[text] frozen new (${tag}); exclude=${currentId || '-'}; len=${out.length}`)
            return out
          } catch (e) {
            dbg(`[text] error: ${String(e && e.message || e)}`)
            return ''
          }
        },
      })

      // 长期记忆段（2026-10-21 加）：画像 / 教训 / 决策，独立预算与冻结。
      // order 10160 在会话段 10150 之后，仍在尾部；两段互不影响。
      scope.systemPrompt.section({
        name: 'memory-anchor:memory',
        order: 10160,
        text: (context) => {
          try {
            const currentId = context?.agent?.session?.header?.id
            if (currentId) {
              const cached = frozenMemoryBySession.get(currentId)
              if (cached !== undefined) return cached
            }
            const out = renderMemorySection(memRoot)
            if (currentId) {
              if (frozenMemoryBySession.size >= 50) {
                frozenMemoryBySession.delete(frozenMemoryBySession.keys().next().value)
              }
              frozenMemoryBySession.set(currentId, out)
            }
            dbg(`[memory] frozen new (${tag}); len=${out.length}`)
            return out
          } catch (e) {
            dbg(`[memory] error: ${String(e && e.message || e)}`)
            return ''
          }
        },
      })

      dbg(`[apply] section registered (${tag})`)
      log(`已挂载：扫描 ${cfg.maxScan} 个会话 / 注入 ${cfg.maxSessions} 个 / 上限 ${cfg.maxChars} 字符 / 每行 ${cfg.lineChars} / 根 ${memRoot} (${tag})`)
    } catch (e) {
      const msg = String(e && e.message || e)
      if (msg.includes('already registered')) {
        dbg(`[apply] section already registered (${tag}), skip duplicate`)
        return
      }
      dbg(`[apply] register failed (${tag}): ${msg}`)
    }
  }

  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    register(ctx, 'direct')
  } else if (typeof ctx.inject === 'function') {
    dbg('[apply] direct unavailable, waiting on ctx.inject(systemPrompt)')
    try {
      ctx.inject(['systemPrompt'], (scope) => register(scope, 'inject'))
    } catch (e) {
      dbg(`[apply] ctx.inject failed: ${String(e && e.message || e)}`)
    }
  } else {
    dbg('[apply] neither systemPrompt nor inject available, giving up')
  }

  // ---- 关键词命中：agent/pre-step（2026-10-21，当晚放宽到前 3 轮）----
  // 每会话最多看 3 轮的用户消息；命中一条插一条，已插过的 id 不再重复插入。
  // 任何异常都放行原 decision。
  const HIT_ROUNDS = 3
  const hitState = new Map()   // sid -> { rounds, refs:Set }
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        const agent = payload?.agent
        const sid = agent?.session?.header?.id
        if (!sid) return decision
        if (agent?.session?.header?.origin === 'subagent') return decision
        const state = hitState.get(sid) || { rounds: 0, refs: new Set() }
        hitState.set(sid, state)
        if (hitState.size > 200) hitState.delete(hitState.keys().next().value)
        if (state.rounds >= HIT_ROUNDS) return decision
        const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user')
        const current = userMsgs[userMsgs.length - 1]
        if (!current) return decision
        const text = (current.content || [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join(' ').trim()
        if (!text) return decision
        state.rounds += 1
        const hit = firstTurnHits(memRoot, text, state.refs)
        if (!hit || !hit.text) return decision
        for (const id of hit.ids) state.refs.add(id)
        const msg = {
          id: 'memory-anchor:' + randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: hit.text }],
          source: { kind: 'plugin:memory-anchor' },
        }
        const idx = decision.messages.indexOf(current)
        const rewritten = [...decision.messages]
        rewritten.splice(idx < 0 ? 0 : idx, 0, msg)
        dbg(`[pre-step] injected ${hit.text.length} chars (round ${state.rounds}) sid=${sid}`)
        return { ...decision, messages: rewritten }
      } catch (e) {
        dbg(`[pre-step] error: ${String(e && e.message || e)}`)
        return decision
      }
    })
    dbg('[pre-step] hook registered')
  } catch (e) {
    dbg(`[pre-step] register failed: ${String(e && e.message || e)}`)
  }
}

// 模块被 DSH loader import 时必然执行；用于区分「模块没加载」和「apply 没被调用」。
dbg('[module] imported')
