/**
 * dsh-memory-anchor —— host entry
 * ================================
 * 组合三个半：
 *   recall.js  会话摘要 + 长期要点（systemPrompt，两段）
 *   tools.js   memory_add / memory_search（tool）
 *   web.js     设置页只读统计路由
 *
 * 共用同一份 config（memRoot 等），任何一半失败都不影响其他部分。
 */

import os from 'node:os'
import path from 'node:path'
import { apply as applyRecall } from './recall.js'
import { apply as applyTools } from './tools.js'
import { setupWeb } from './web.js'

export const name = 'memory-anchor'
export const version = '0.1.0'

/** 两个服务都要：systemPrompt 用于注入，tools 用于注册工具 */
export const inject = ['systemPrompt', 'tools']

function resolveMemRoot(config) {
  if (config.memRoot) return path.resolve(config.memRoot)
  if (process.env.DSH_MEM_ROOT) return path.resolve(process.env.DSH_MEM_ROOT)
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory')
}

export function apply(ctx, config = {}) {
  const memRoot = resolveMemRoot(config)
  for (const [label, fn] of [['recall', applyRecall], ['tools', applyTools]]) {
    try {
      fn(ctx, config)
    } catch (e) {
      try {
        ctx.logger?.warn?.(`[memory-anchor] ${label} failed: ${String((e && e.message) || e)}`)
      } catch { /* logging must never break the host */ }
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => setupWeb(ctx, { memRoot }))
    else setupWeb(ctx, { memRoot })
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[memory-anchor] web failed: ${String((e && e.message) || e)}`)
    } catch { /* ignore */ }
  }
}