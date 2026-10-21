/**
 * client.mjs —— 插件页面板的 DOM 级测试
 * =====================================
 * 不引入 React / jsdom：用最小 stub 跑组件函数，断言渲染出来的树。
 * 覆盖：模块注册、slot 注册、导出菜单四项（含 Markdown）、条目点开看详情。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'

// ---- 最小 React stub：支持 useState / useEffect / useCallback ----
let hookStates = []
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useState(init) {
    const i = hookIndex++
    if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init
    return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v }]
  },
  useEffect(fn) { fn() },
  useCallback(fn) { return fn },
}

// ---- 捕获客户端模块注册 ----
let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }

const responses = {
  '/memory-anchor/stats': {
    total: 2,
    scopes: [{
      scope: 'global', total: 2, byKind: [],
      recent: [{ id: 1, kind: 'fact', title: '测试条目', updated_at: '2026-10-21 10:00' }],
    }],
  },
  ['/memory-anchor/node?ref=' + encodeURIComponent('global#1')]: {
    id: 1, scope: 'global', kind: 'fact', title: '测试条目',
    summary: '这是摘要', tags: 't1,t2', updated_at: '2026-10-21 10:00', has_raw: true,
  },
}
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => responses[url] || {},
  headers: { get: () => '' },
})

await import('../lib/client.js')
assert.ok(captured && typeof captured.factory === 'function', 'client module registered')

const api = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof api.apply, 'function', 'factory returns apply')
assert.deepEqual(api.inject, ['slots'], 'injects slots')

const chars = []
const registered = []
const ctx = {
  slots: {
    register: (slot, comp) => { registered.push({ slot, comp }) },
    inject: (_name, fn) => fn(),
  },
}
api.apply(ctx)
assert.equal(registered.length, 2, 'registers two slots')
assert.equal(registered[0].slot.name, 'plugins.bundle.config', 'plugin detail slot')
assert.equal(registered[1].slot.name, 'settings.section', 'settings slot')

const panel = registered[0].comp
const render = () => { hookIndex = 0; return panel() }

const textOf = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}
const findButtons = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findButtons(n, out); return out }
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') out.push(node)
  findButtons(node.props && node.props.children, out)
  return out
}
const btn = (tree, text) => findButtons(tree).find((b) => textOf(b).includes(text))

// 第一轮：useEffect 触发 fetch，等微任务后再渲染
let tree = render()
await new Promise((r) => setTimeout(r, 0))
tree = render()

assert.ok(textOf(tree).includes('测试条目'), 'recent entry rendered')
assert.ok(btn(tree, '导出 ▾'), 'export button present')
assert.ok(textOf(tree).includes('导入'), 'import entry present')

// 展开导出菜单：四项，含 Markdown
btn(tree, '导出 ▾').props.onClick()
tree = render()
assert.ok(btn(tree, 'Markdown 摘要'), 'markdown export option')
assert.ok(btn(tree, '完整备份（含会话日志）'), 'full backup option')

// 点条目：详情显示摘要与锚点标记
btn(tree, '测试条目').props.onClick()
await new Promise((r) => setTimeout(r, 0))
tree = render()
assert.ok(textOf(tree).includes('这是摘要'), 'detail summary rendered')
assert.ok(textOf(tree).includes('原文：可回源'), 'detail anchor flag rendered')

console.log('client ok')