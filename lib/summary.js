/**
 * 会话摘要提取 —— 把一个会话压成一句话
 * =====================================
 *
 * 目的：跨会话注入时，每个会话给一行「这个会话干了什么」，而不是列记忆条目。
 *
 * 做法：机械提取，不调 LLM。
 *   - 主题 = 第一条真实用户消息（去掉系统注入噪声）
 *   - 诉求 = 用户消息的去重关键词（最多 3 条短句）
 *   - 规模 = 轮次数、工具调用统计、涉及文件数
 *
 * 为什么机械提取：插件不能调模型（会拖慢每轮、且不可控）。
 * 机械摘要的信息量有限，但足以让新会话知道「上次在做什么」。
 */

const NOISE_RE = /system-reminder|Current runtime context|^<system|AUTO-HANDOFF:BEGIN|^You are an AI agent/i
const IGNORE_PATH_RE = /[\\/]Temp[\\/]|[\\/]temp[\\/]|[\\/]node_modules[\\/]|\.tmp$|AppData[\\/]Local[\\/]Temp/i

/** 只有这些工具算「改动文件」，read/grep/glob 只是看，不算改 */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_file', 'multi_edit'])

function isTalk(e) {
  if (!e || typeof e.seq !== 'number') return false
  if (!['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type)) return false
  if (e.type === 'user/message') {
    const t = (e.data?.content || []).map((c) => c.text || '').join(' ')
    if (NOISE_RE.test(t)) return false
  }
  return true
}

/** 从工具调用参数里抠文件路径 */
function filesFromArgs(args) {
  if (!args || typeof args !== 'object') return []
  const out = []
  for (const k of ['file_path', 'filePath', 'path', 'target']) {
    if (typeof args[k] === 'string' && args[k].trim()) out.push(args[k].trim())
  }
  return out
}

/** 把长文本压成一句：去空白、截断 */
function oneLine(s, max = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 给一个会话文件生成摘要。
 * @param {string} filePath  session.v4.jsonl.zstd 路径
 * @param {object} libs      recall.js 的 getLibs() 返回的模块
 * @param {object} opts      { maxUserMsgs, titleChars }
 * @returns {object|null}    null = 空会话或无内容
 */
export function summarizeSession(filePath, libs, opts = {}) {
  const { maxUserMsgs = 3, titleChars = 60 } = opts
  let events
  try {
    ({ events } = libs.readSession(filePath))
  } catch {
    return null
  }
  if (!Array.isArray(events) || !events.length) return null

  const talk = events.filter(isTalk)
  if (!talk.length) return null

  const userMsgs = []
  const files = new Set()
  const toolCount = new Map()
  let firstTime = null
  let lastTime = null

  for (const e of talk) {
    const n = libs.normalizeEvent(e)
    if (!n) continue
    if (!firstTime && n.time) firstTime = n.time
    if (n.time) lastTime = n.time

    if (libs.isHumanMessage(n)) {
      const t = oneLine(n.text, 200)
      if (t) userMsgs.push(t)
    } else if (n.role === 'tool-call') {
      for (const tc of n.toolCalls || []) {
        const name = tc.name || 'tool'
        toolCount.set(name, (toolCount.get(name) || 0) + 1)
        // 只统计「写」类工具动过的文件，read/grep/glob 不算改动
        if (!WRITE_TOOLS.has(name)) continue
        const a = typeof tc.arguments === 'string'
          ? (() => { try { return JSON.parse(tc.arguments) } catch { return null } })()
          : tc.arguments
        for (const f of filesFromArgs(a)) {
          if (!IGNORE_PATH_RE.test(f)) files.add(f)
        }
      }
    }
  }

  if (!userMsgs.length && !toolCount.size) return null

  // 主题：第一条用户消息（截短，去掉句尾标点）
  const rawTitle = (userMsgs[0] || '(无用户消息，只有工具调用)').replace(/[，。；：,.;:]+$/, '')
  const title = oneLine(rawTitle, titleChars)

  // 诉求：取后续用户消息的首句，去重后最多 maxUserMsgs-1 条
  const asks = []
  for (const m of userMsgs.slice(1, 8)) {
    const head = m.split(/[。！？\n]/)[0].slice(0, 28)
    if (!head) continue
    if (head === title.slice(0, 28)) continue
    if (asks.some((a) => a === head || head.startsWith(a) || a.startsWith(head))) continue
    asks.push(head)
    if (asks.length >= maxUserMsgs - 1) break
  }

  const ts = firstTime ? new Date(firstTime) : null
  const stamp = ts
    ? `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
    : '--'

  return {
    title,
    asks,
    stamp,
    turns: userMsgs.length,
    toolTotal: [...toolCount.values()].reduce((a, b) => a + b, 0),
    topTools: [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`),
    fileCount: files.size,
    firstTime,
    lastTime,
    eventCount: talk.length,
  }
}

/** 把摘要渲染成一行注入文本 */
export function renderSummaryLine(s, { maxChars = 150 } = {}) {
  const stat = []
  if (s.turns) stat.push(`${s.turns}轮`)
  if (s.fileCount) stat.push(`改${s.fileCount}文件`)

  let line = `- ${s.stamp}「${s.title}」`
  if (s.asks.length) {
    // 诉求按剩余预算截，避免整行超长把统计挤掉
    const budget = Math.max(20, maxChars - line.length - (stat.length ? stat.join('，').length + 4 : 0))
    let askText = '→ ' + s.asks.join('；')
    if (askText.length > budget) askText = askText.slice(0, budget) + '…'
    line += askText
  }
  if (stat.length) line += `（${stat.join('，')}）`

  if (line.length > maxChars) line = line.slice(0, maxChars) + '…'
  return line
}
