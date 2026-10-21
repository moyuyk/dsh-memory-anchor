/**
 * client.js —— 插件详情页里的记忆库管理
 *
 * 注册位置：plugins.bundle.config（和 dsh-workbuddy-connect 相同）
 *   → 插件 → dsh-memory-anchor → 记忆库
 *
 * 加载方式：bundle（在 profile 的 dsh.profile.bundles 里），
 *   插件页开关可真正启停；关闭时不加载工具和注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-anchor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }
    const dim = { opacity: 0.65 }
    const small = { fontSize: 12, opacity: 0.7 }
    // 文字按钮：无边框、无背景，只保留可点击
    const textBtn = {
      border: 'none', background: 'transparent', color: 'inherit',
      cursor: 'pointer', padding: 0, font: 'inherit',
    }
    const menuItem = { ...textBtn, textAlign: 'left', fontSize: 13, padding: '2px 0' }

    const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })

    const KIND = { pref: '画像', pitfall: '坑', decision: '决策', fact: '事实', state: '状态', todo: '待办', note: '笔记', session: '会话' }

    function Summary(props) {
      const data = props.data
      if (!data) return null
      return h('div', { style: { display: 'grid', gap: 6 } },
        h('div', { style: row }, h('strong', null, '记忆库'), h('span', { style: dim }, data.total + ' 条')),
        ...data.scopes.filter((s) => s.total > 0).map((s) =>
          h('div', { key: s.scope, style: { display: 'grid', gap: 2 } },
            h('div', { style: row }, h('span', null, s.scope), h('span', { style: dim }, s.total + ' 条')),
            h('div', { style: small }, s.byKind.map((k) => (KIND[k.kind] || k.kind) + ':' + k.c).join('  '))
          )
        )
      )
    }

    function MemoryPanel() {
      const [stats, setStats] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [showExport, setShowExport] = React.useState(false)

      const loadStats = React.useCallback(() => {
        getJson('/memory-anchor/stats').then(setStats).catch((e) => setMsg('读取失败：' + e.message))
      }, [])
      React.useEffect(() => { loadStats() }, [loadStats])

      const download = (url, body) => {
        const opts = body
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : { cache: 'no-store' }
        fetch(url, opts)
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const cd = r.headers.get('content-disposition') || ''
            const m = cd.match(/filename="([^"]+)"/)
            return r.blob().then((blob) => ({ blob, name: m ? m[1] : 'memory-anchor-export' }))
          })
          .then(({ blob, name }) => {
            const link = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = link
            a.download = name
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => URL.revokeObjectURL(link), 1000)
            setMsg('已导出：' + name)
          })
          .catch((e) => setMsg('导出失败：' + e.message))
      }

      const importFile = (e) => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        file.text()
          .then((text) => {
            let items
            try { items = JSON.parse(text) } catch { throw new Error('不是合法 JSON') }
            if (!Array.isArray(items)) throw new Error('JSON 应为数组')
            return fetch('/memory-anchor/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ scope: 'global', items }),
            }).then((r) => r.json()).then((r) => {
              if (!r.ok) throw new Error(r.error || '导入失败')
              setMsg(r.output || '导入完成')
              loadStats()
            })
          })
          .catch((err) => setMsg('导入失败：' + err.message))
          .finally(() => { e.target.value = '' })
      }

      const recent = (stats?.scopes || [])
        .flatMap((s) => (s.recent || []).map((r) => ({ ...r, scope: s.scope })))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 8)

      return h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '记忆库'),
          h('div', { style: { display: 'flex', gap: 14, position: 'relative' } },
            h('button', { style: textBtn, onClick: () => setShowExport(!showExport) }, '导出 ▾'),
            showExport ? h('div', {
              style: {
                position: 'absolute', right: 0, top: '100%', marginTop: 6,
                display: 'grid', gap: 6, padding: '8px 10px', zIndex: 20,
                background: 'Canvas', whiteSpace: 'nowrap',
                boxShadow: '0 4px 16px rgba(0,0,0,.14)', borderRadius: 6,
              },
            },
              h('button', { style: menuItem, onClick: () => download('/memory-anchor/export') }, '仅结论 JSON'),
              h('button', { style: menuItem, onClick: () => download('/memory-anchor/archive', { includeSessions: false }) }, '记忆库备份（不含日志）'),
              h('button', { style: menuItem, onClick: () => download('/memory-anchor/archive', { includeSessions: true }) }, '完整备份（含会话日志）')
            ) : null,
            h('label', { style: { ...textBtn, display: 'inline-block' } }, '导入',
              h('input', {
                type: 'file',
                accept: '.json,application/json',
                style: { display: 'none' },
                onChange: importFile,
              })
            )
          )
        ),
        msg ? h('div', { style: small }, msg) : null,
        h(Summary, { data: stats }),
        recent.length ? h('div', { style: { display: 'grid', gap: 4 } },
          h('div', { style: small }, '最近条目'),
          ...recent.map((r) =>
            h('div', { key: r.scope + '#' + r.id, style: { display: 'grid', gap: 2 } },
              h('div', { style: row },
                h('span', null, '[' + (KIND[r.kind] || r.kind) + '] ' + r.title),
                h('span', { style: dim }, r.scope + '#' + r.id)
              )
            )
          )
        ) : null
      )
    }

    function SettingsCard() {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' })
      React.useEffect(() => {
        getJson('/memory-anchor/stats')
          .then((data) => setState({ loading: false, data, error: '' }))
          .catch((e) => setState({ loading: false, data: null, error: String((e && e.message) || e) }))
      }, [])
      if (state.loading) return h('div', null, '正在读取记忆库…')
      if (state.error) return h('div', { style: { opacity: 0.8 } }, '读取失败：' + state.error)
      return h(Summary, { data: state.data })
    }

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.register !== 'function') return

      const registerConfig = () => {
        try {
          slots.register({ name: 'plugins.bundle.config', key: 'dsh-memory-anchor' }, MemoryPanel)
        } catch { /* slot not ready */ }
      }
      const registerSettings = () => {
        try {
          slots.register(
            { name: 'settings.section', id: 'dsh-memory-anchor', order: 60, label: () => '记忆库' },
            SettingsCard
          )
        } catch { /* slot not ready */ }
      }

      for (const [slot, fn] of [['plugins.bundle.config', registerConfig], ['settings.section', registerSettings]]) {
        try { slots.inject(slot, fn) } catch { fn() }
      }
    }

    return { apply, inject: ['slots'] }
  },
})