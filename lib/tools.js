/**
 * dsh-memory-anchor —— 记忆库工具桥
 * ==================================
 *
 * 只做一件事：把 mem.js 的 add / search 包成模型可直接调用的工具。
 *
 * 为什么不把存储层搬进插件：
 *   dsh-memory-kit 的老问题是插件自带一套 schema，和 mem.js 各写各的同一批 .db。
 *   这里反过来：插件只负责「入口」，写入、查重、摘要、原文锚点全部由 mem.js 负责。
 *   mem.js 升级不需要动插件。
 *
 * 设计约束（和注入半一致）：
 *   - 零第三方依赖，只用 node:child_process / node:fs / node:path。
 *   - 进程隔离：每次调用 spawn 一个 mem.js，约 100ms；失败不抛，返回错误对象。
 *   - 不读 DSH 内部 API，不碰 asar。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 代码自带的 bin（发布包内），与数据目录解耦 */
const PKG_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin')

export const name = 'memory-anchor'
export const version = '0.1.0'

/** 只依赖 tools 服务；拿不到就静默不挂载，不影响 DSH 启动 */
export const inject = ['tools']

const TIMEOUT_MS = 30_000
const MAX_BUFFER = 8 * 1024 * 1024

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
  },
}

function log(ctx, level, msg) {
  try { ctx.logger?.[level]?.(`[memory-anchor] ${msg}`) } catch { /* 日志失败不影响功能 */ }
}

/** 找记忆库根目录：配置 > 环境变量 > <DSH_HOME>/memory */
function resolveMemRoot(config) {
  const raw = config.memRoot
    || process.env.DSH_MEM_ROOT
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory')
  return path.resolve(String(raw))
}

/**
 * 找 node 可执行文件。
 * DSH 主进程的 process.execPath 通常就是捆绑的 node.exe；若宿主是别的壳，
 * 回退到 DSH_HOME 下的运行时 node。
 */
function resolveNodePath(config) {
  if (config.nodePath) {
    const p = String(config.nodePath)
    if (fs.existsSync(p)) return p
  }
  const exec = process.execPath
  const base = path.basename(exec).toLowerCase()
  if (base === 'node' || base === 'node.exe') return exec

  const dshHome = process.env.DSH_HOME || ''
  const candidates = [
    process.env.DSH_NODE,
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return exec
}

function runMem({ nodePath, memRoot, args, payload, sessionId }) {
  const candidates = [path.join(PKG_BIN, 'mem.js'), path.join(memRoot, 'bin', 'mem.js')]
  const memjs = candidates.find((p) => { try { return fs.existsSync(p) } catch { return false } })
  if (!memjs) throw new Error(`找不到 mem.js：${candidates.join(' | ')}`)

  const opts = {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    // 主进程环境里没有 DSH_SESSION_ID（那是会话级注入给 shell 的），
    // 不显式传的话 mem.js 的「自动抓当前会话原文」会一直失败。
    env: { ...process.env, DSH_MEM_ROOT: memRoot, ...(sessionId ? { DSH_SESSION_ID: sessionId } : {}) },
  }
  if (payload !== undefined) opts.input = JSON.stringify(payload)
  return execFileSync(nodePath, [memjs, ...args], opts)
}

/** 从 add 的 stdout 里抠出 scope#id */
function extractRef(out) {
  const m = String(out).match(/\[已记录\]\s+(\S+#\d+)/)
  return m ? m[1] : ''
}

function clip(s, n) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function buildTools({ nodePath, memRoot }) {
  return [
    {
      name: 'memory_add',
      description:
        '记住一条跨会话仍然成立的事实：用户偏好、项目约定、决定及原因、踩过的坑、环境事实。'
        + '一次一条，标题独立可读。不要写临时状态、密钥、仓库里已有的东西。'
        + '写入前会自动做 2-gram 查重（≥0.8 阻断，可用 force 强写），并自动抓当前会话原文锚点。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题，独立可读' },
          summary: { type: 'string', description: '摘要，60-200 字；不填则等于标题' },
          kind: {
            type: 'string',
            enum: ['fact', 'decision', 'pitfall', 'pref', 'state', 'todo', 'note', 'session'],
            description: '类型；教训用 pitfall，决定用 decision，用户偏好用 pref',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，2-5 个' },
          weight: { type: 'number', description: '权重 1-5，默认 3；越重要越高' },
          scope: { type: 'string', description: 'global / chat / proj:项目名，默认 global' },
          force: { type: 'boolean', description: '跳过 ≥0.8 的查重阻断（确认要新增时用）' },
          raw_text: { type: 'string', description: '可选：直接给原文；不填则自动抓当前会话' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args = {}, exec = {}) {
        const title = String(args.title || '').trim()
        if (!title) throw new Error('title 不能为空')

        // 当前会话 id：注入半用的是 context.agent.session.header.id，工具侧从 exec.agent 取同一份。
        const sessionId = String(exec?.agent?.session?.header?.id || '')

        const payload = {
          title,
          summary: typeof args.summary === 'string' ? args.summary : '',
          kind: args.kind || 'note',
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          weight: Number(args.weight) || 3,
          scope: String(args.scope || 'global'),
          force: Boolean(args.force),
          source: 'agent-tool',
        }
        if (typeof args.raw_text === 'string' && args.raw_text.trim()) {
          payload.rawText = args.raw_text
        }

        // 写守卫：疑似密钥/令牌直接拒绝（mem.js add 里还有一层兜底）
        const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AKID[A-Za-z0-9]{13,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/
        if (SECRET_RE.test(`${title}\n${payload.summary}\n${payload.rawText || ''}`)) {
          return {
            ok: false,
            reason: 'secret',
            hint: '内容疑似包含密钥/令牌，已拒绝写入；密钥请放 keys 目录或凭据层',
          }
        }

        try {
          const out = runMem({ nodePath, memRoot, args: ['add', '--json-stdin'], payload, sessionId }).trim()
          return { ok: true, ref: extractRef(out), output: clip(out, 2000) }
        } catch (e) {
          const out = String(e.stdout || '').trim()
          const err = String(e.stderr || e.message || '').trim()
          const duplicate = /\[去重\]/.test(out)
          return {
            ok: false,
            reason: duplicate ? 'duplicate' : 'failed',
            hint: duplicate
              ? '已有高度相似条目：改旧条目用 mem.js update <ref>；确认要新增就加 force=true'
              : '检查 mem.js 是否存在、node 路径是否正确',
            output: clip(out, 1500),
            error: clip(err, 500),
          }
        }
      },
    },

    {
      name: 'memory_search',
      description:
        '检索本地记忆库（摘要级）：跨会话的决定、坑、偏好、环境事实。'
        + '中文 2 字以上即可。需要原话、代码片段或完整上下文时，拿到 ref 后再用 mem.js raw <ref>。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，中文 2 字以上' },
          limit: { type: 'number', description: '返回条数，默认 5，最大 20' },
          scope: { type: 'string', description: '可选：global / chat / proj:项目名；不填搜全部' },
          all: { type: 'boolean', description: '是否包含已失效/被取代的历史条目，默认 false' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args = {}) {
        const query = String(args.query || '').trim()
        if (!query) throw new Error('query 不能为空')
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))

        const flags = ['search', query, '--json', '--limit', String(limit)]
        if (args.scope) flags.push('--scope', String(args.scope))
        if (args.all) flags.push('--all')

        try {
          const out = runMem({ nodePath, memRoot, args: flags }).trim()
          let rows
          try {
            rows = JSON.parse(out)
          } catch {
            return { ok: false, error: 'mem.js 返回的不是 JSON', raw: clip(out, 800) }
          }
          return {
            ok: true,
            count: rows.length,
            items: rows.map((r) => ({
              ref: `${r.scope}#${r.id}`,
              kind: r.kind,
              title: r.title,
              summary: clip(r.summary, 200),
              weight: r.weight,
              score: r._score,
              created_at: r.created_at,
              has_raw: Boolean(r.has_raw),
            })),
          }
        } catch (e) {
          return {
            ok: false,
            error: clip(String(e.stderr || e.message || ''), 500),
            hint: '检查 mem.js 是否存在、node 路径是否正确',
          }
        }
      },
    },
  ]
}

function pickTools(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const t = ctx.get('tools')
      if (t) return t
    }
  } catch { /* 可选服务缺失是正常的 */ }
  return ctx.tools || null
}

export function apply(ctx, config = {}) {
  const memRoot = resolveMemRoot(config)
  const nodePath = resolveNodePath(config)

  const memjsOk = [path.join(PKG_BIN, 'mem.js'), path.join(memRoot, 'bin', 'mem.js')]
    .some((p) => { try { return fs.existsSync(p) } catch { return false } })
  if (!memjsOk) {
    log(ctx, 'warn', `mem.js 不存在（${memRoot}），插件不挂载`)
    return
  }

  const tools = pickTools(ctx)
  if (!tools || typeof tools.register !== 'function') {
    log(ctx, 'warn', 'tools.register 不可用，插件不挂载')
    return
  }

  for (const def of buildTools({ nodePath, memRoot })) {
    try {
      tools.register(def)
      log(ctx, 'info', `已注册工具 ${def.name}`)
    } catch (e) {
      log(ctx, 'warn', `注册 ${def.name} 失败：${String(e && e.message || e)}`)
    }
  }
}