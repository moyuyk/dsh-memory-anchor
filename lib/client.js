/**
 * client.js —— 官方 GUI 里的记忆库入口
 *  1) 侧栏「记忆库」面板：统计 / 搜索 / 简单管理 / 导出快照
 *  2) 设置页「记忆库」卡片：只读统计
 *
 * 模块外壳与 DeepSeek Harness 客户端插件一致：window.__ModuleLoader__.load。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-anchor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const box = {
      padding: '10px 0',
      fontSize: 13,
      lineHeight: 1.55,
    }
    const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }
    const dim = { opacity: 0.65 }
    const small = { fontSize: 12, opacity: 0.7 }
    const btn = { cursor: 'pointer' }

    const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })

    const KIND = { pref: '画像', pitfall: '坑', decision: '决策', fact: '事实', state: '状态', todo: '待办', note: '笔记', session: '会话' }

    function Summary(props) {
      const data = props.data
      if (!data) return null
      return h('div', null,
        h('div', { style: row }, h('strong', null, '记忆库'), h('span', { style: dim }, data.total + ' 条')),
        ...data.scopes.filter((s) => s.total > 0).map((s) =>
          h('div', { key: s.scope, style: { marginTop: 4 } },
            h('div', { style: row }, h('span', null, s.scope), h('span', { style: dim }, s.total + ' 条')),
            h('div', { style: small }, s.byKind.map((k) => (KIND[k.kind] || k.kind) + ':' + k.c).join('  '))
          )
        )
      )
    }

    function MemoryPanel() {
      const [stats, setStats] = React.useState(null)
      const [items, setItems] = React.useState([])
      const [q, setQ] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [showExport, setShowExport] = React.useState(false)

      const loadStats = React.useCallback(() => {
        getJson('/memory-anchor/stats').then(setStats).catch((e) => setMsg('读取失败：' + e.message))
      }, [])
      React.useEffect(() => { loadStats() }, [loadStats])

      const search = () => {
        const query = q.trim()
        if (!query) return setItems([])
        getJson('/memory-anchor/search?q=' + encodeURIComponent(query))
          .then((r) => setItems(r.items || []))
          .catch((e) => setMsg('搜索失败：' + e.message))
      }

      const manage = (item, patch) => {
        if (patch.deleted && !window.confirm('删除「' + item.title + '」？')) return
        fetch('/memory-anchor/manage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: item.scope, id: item.id, ...patch }),
        })
          .then((r) => r.json())
          .then((r) => {
            if (!r.ok) throw new Error(r.error || 'failed')
            setMsg(patch.deleted ? '已删除' : '已标记')
            setItems((prev) => prev.filter((x) => !(x.scope === item.scope && x.id === item.id)))
            loadStats()
          })
          .catch((e) => setMsg('操作失败：' + e.message))
      }

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

      return h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '记忆库'),
          h('div', { style: { display: 'flex', gap: 8, position: 'relative' } },
            h('button', { style: btn, onClick: () => setShowExport(!showExport) }, '导出'),
            showExport ? h('div', {
              style: {
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                display: 'grid', gap: 2, padding: 4, zIndex: 20,
                background: 'Canvas', whiteSpace: 'nowrap',
              },
            },
              h('button', { style: { ...btn, textAlign: 'left' }, onClick: () => download('/memory-anchor/export') }, '摘要 JSON'),
              h('button', { style: { ...btn, textAlign: 'left' }, onClick: () => download('/memory-anchor/archive', { includeSessions: false }) }, '备份包（记忆库）'),
              h('button', { style: { ...btn, textAlign: 'left' }, onClick: () => download('/memory-anchor/archive', { includeSessions: true }) }, '完整包（含会话日志）')
            ) : null,
            h('label', { style: { ...btn, display: 'inline-block' } }, '导入',
              h('input', {
                type: 'file',
                accept: '.json,application/json',
                style: { display: 'none' },
                onChange: importFile,
              })
            )
          )
        ),
        showExport ? null : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: q,
            placeholder: '搜索记忆',
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') search() },
            style: {
              flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '8px 0', fontSize: 13,
              border: 'none', borderBottom: '1px solid rgba(128,128,128,.25)',
              background: 'transparent', color: 'inherit', outline: 'none',
            },
          }),
          h('button', { style: btn, onClick: search }, '搜索')
        ),
        msg ? h('div', { style: small }, msg) : null,
        h(Summary, { data: stats }),
        ...items.map((it) =>
          h('div', { key: it.scope + '#' + it.id, style: { padding: '10px 0' } },
            h('div', { style: row },
              h('span', { style: { fontWeight: 600 } }, '[' + (KIND[it.kind] || it.kind) + '] ' + it.title),
              h('span', { style: dim }, it.scope + '#' + it.id)
            ),
            h('div', { style: small }, String(it.summary || '').slice(0, 80)),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
              h('button', { style: btn, onClick: () => manage(it, { corrected: true }) }, '标记已纠正'),
              h('button', { style: btn, onClick: () => manage(it, { deleted: true }) }, '删除')
            )
          )
        )
      )
    }

    function SettingsCard() {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' })
      React.useEffect(() => {
        getJson('/memory-anchor/stats')
          .then((data) => setState({ loading: false, data, error: '' }))
          .catch((e) => setState({ loading: false, data: null, error: String((e && e.message) || e) }))
      }, [])
      if (state.loading) return h('div', { style: box }, '正在读取记忆库…')
      if (state.error) return h('div', { style: { ...box, opacity: 0.8 } }, '读取失败：' + state.error)
      return h('div', { style: { ...box, padding: '12px 16px' } }, h(Summary, { data: state.data }))
    }

    /** 侧栏入口：文字由宿主 label 渲染，组件不再重复显示 */
    function MemoryEntry() {
      return null
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