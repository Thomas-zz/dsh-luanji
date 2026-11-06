/** 乱记：原地记录、引用思考、随手便签。DSH native slots + local API. */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-luanji',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const API = '/dsh-luanji'
    const empty = () => ({ text: '', images: [], quote: null })
    let ctx, disposed = false, toastTimer, highlightTimer, refreshSequence = 0
    let state = { ready: false, loaded: false, records: [], error: '', drafts: { quick: empty(), manage: empty(), quote: empty() }, draftStatus: {}, open: null, toast: '', undo: null, busy: false, cloud: { configured: false } }
    const listeners = new Set()
    const set = (patch) => { if (disposed) return; state = { ...state, ...patch }; listeners.forEach((fn) => fn()) }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const useState = () => React.useSyncExternalStore(subscribe, () => state)
    const writes = new Map(), revisions = new Map(), timers = new Map()
    const captureIds = new Map()
    let hydrated = false, returnFocus = null
    function toast(message, undo = null) {
      clearTimeout(toastTimer); set({ toast: message, undo })
      toastTimer = setTimeout(() => set({ toast: '', undo: null }), 4500)
    }
    async function api(path, options = {}) {
      const response = await fetch(API + path, { ...options, headers: { 'content-type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
      const data = await response.json().catch(() => ({ error: '服务没有返回有效数据。' }))
      if (!response.ok || data.ok === false) throw new Error(data.error || '暂时无法保存，请重试。')
      return data
    }
    async function refresh() {
      const sequence = ++refreshSequence
      try {
        const [data, cloudInfo] = await Promise.all([api('/state'), api('/cloud').catch(() => null)])
        if (data.schemaVersion !== 2) throw new Error('乱记界面已更新，请重新加载插件或重启 DSH，以启用新的记录存储。')
        if (sequence !== refreshSequence) return
        const patch = { ready: true, loaded: true, error: '', records: data.records || [] }
        if (cloudInfo?.cloud) patch.cloud = cloudInfo.cloud
        if (!hydrated) {
          const initial = { quick: empty(), manage: { ...empty(), text: data.draft || '' }, quote: empty(), ...data.drafts }
          patch.drafts = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, revisions.has(key) ? state.drafts[key] : value]))
        }
        hydrated = true; set(patch); scheduleHighlights()
      } catch (e) { set({ ready: false, loaded: true, error: e.message }) }
    }
    function persistDraft(key) {
      clearTimeout(timers.get(key)); timers.delete(key)
      const value = structuredClone(state.drafts[key]), revision = revisions.get(key)
      const write = (writes.get(key) || Promise.resolve()).catch(() => {}).then(() => { if (!state.ready) throw new Error('本机存储尚未就绪'); return api('/draft', { method: 'PUT', body: { key, draft: value } }) })
      writes.set(key, write)
      write.then(() => {
        if (revisions.get(key) === revision) set({ draftStatus: { ...state.draftStatus, [key]: '草稿已存本机' } })
      }).catch(() => set({ draftStatus: { ...state.draftStatus, [key]: '草稿未保存，点击重试' } }))
      return write
    }
    function changeDraft(key, patch) {
      revisions.set(key, (revisions.get(key) || 0) + 1)
      set({ drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...patch } }, draftStatus: { ...state.draftStatus, [key]: '正在保存草稿…' } })
      clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => void persistDraft(key).catch(() => {}), 400))
    }
    /** 侧栏这一行的位置，用来把便签贴在行右侧而不是挡住对话。 */
    function rowRect() {
      const glyph = document.querySelector('.lj-glyph')
      const row = glyph?.closest('button')
      const rect = row?.getBoundingClientRect()
      if (rect && rect.width > 0) return rect
      return { left: 8, right: 248, top: 120, bottom: 156, width: 240, height: 36 }
    }
    /** 侧栏行可能被折叠成图标轨道，便签位置跟着行走。 */
    function anchorNow() {
      const glyph = document.querySelector('.lj-glyph')
      if (!glyph) return rowRect()
      return glyph.closest('button')?.getBoundingClientRect() || rowRect()
    }
    function openQuick() {
      returnFocus = document.activeElement
      set({ open: state.drafts.quote.quote ? 'quote' : 'quick' })
    }
    function closeComposer() {
      const key = state.open
      if (key) void persistDraft(key).catch(() => {})
      set({ open: null })
      if (returnFocus) { returnFocus.focus?.({ preventScroll: true }); returnFocus = null }
    }
    function manage() { if (state.open) closeComposer(); ctx.layout.selectPanel('luanji') }
    async function saveDraft(key) {
      const value = structuredClone(state.drafts[key])
      if (!state.ready || state.busy || (!value.text.trim() && !value.images.length && !value.quote)) return
      if (key === 'quote' && !value.text.trim() && !value.images.length) return
      set({ busy: true })
      clearTimeout(timers.get(key)); timers.delete(key)
      const revision = revisions.get(key)
      try {
        await (writes.get(key) || Promise.resolve()).catch(() => {})
        const signature = JSON.stringify(value)
        if (captureIds.get(key)?.signature !== signature) captureIds.set(key, { id: crypto.randomUUID(), signature })
        const { record } = await api('/notes', { method: 'POST', body: { ...value, id: captureIds.get(key).id, draftKey: key } })
        captureIds.delete(key)
        // 保存期间如果又改过同一份草稿，保留新内容，不要把用户的输入清掉。
        if (revisions.get(key) === revision) {
          revisions.set(key, revision + 1)
          set({ drafts: { ...state.drafts, [key]: empty() }, draftStatus: { ...state.draftStatus, [key]: '' } })
          if (state.open === key) set({ open: null })
          if (returnFocus) { returnFocus.focus?.({ preventScroll: true }); returnFocus = null }
        }
        toast('已记录', record.id); await refresh()
      } catch (e) { toast('没有保存成功：' + e.message) }
      finally { set({ busy: false }) }
    }
    /** 直接保存一段划选原文（不打开便签）。 */
    async function recordSelection(quote) {
      if (!state.ready || state.busy) { if (state.error) toast(state.error); return false }
      set({ busy: true })
      try {
        const { record } = await api('/notes', { method: 'POST', body: { id: crypto.randomUUID(), quote } })
        toast('已记录', record.id); await refresh(); return true
      } catch (e) { toast('没有保存成功：' + e.message); return false }
      finally { set({ busy: false }) }
    }
    const sourceName = (q) => q?.origin?.role === 'user' ? '我' : q?.origin?.role === 'assistant' ? `AI · ${q.origin.model || '模型未知'}` : '对话摘录'
    const when = (ms) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    function Icon({ kind = 'note', size = 17 }) {
      const paths = {
        note: 'M6 3.5h8.5L18.5 7.5V20.5H6z M14.5 3.5V7.5h4 M9 12h6 M9 15.5h4',
        grid: 'M4.5 4.5h6v6h-6z M13.5 4.5h6v6h-6z M4.5 13.5h6v6h-6z M13.5 13.5h6v6h-6z',
        image: 'M3.5 4.5h17v15h-17z M3.5 16l5.5-5.5 4.5 4.5 3-3 4 4 M16 8.5h.01',
        close: 'M6 6l12 12 M18 6L6 18',
        search: 'M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15.5 15.5l5 5',
        quote: 'M7 7.5h4v4.5c0 2.2-1.2 3.6-3.2 4.3 M13 7.5h4v4.5c0 2.2-1.2 3.6-3.2 4.3',
        check: 'M5 12.5l4.3 4.3L19 7.5',
        arrow: 'M8 16l8-8 M10 8h6v6',
        edit: 'M5 19l.9-3.6L16.5 4.8l2.7 2.7L8.6 18.1z M14.9 6.4l2.7 2.7',
        trash: 'M4.5 6.5h15 M9.5 6.5V4.5h5v2 M6.5 6.5l.8 13h9.4l.8-13 M10 10.5v6 M14 10.5v6',
        clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M12 7.5V12l3 2',
        inbox: 'M4 4.5h16v15H4z M4 13.5h4l1.5 3h5l1.5-3h4',
        plus: 'M12 5v14 M5 12h14',
      }
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[kind] }))
    }

    /** 引用块：引用在上、自己的想法在下（详情卡片与便签共用）。 */
    function Quote({ value, compact = false, onExpand }) {
      const long = value.text.length > 180
      return h('div', { className: 'lj-quote', 'data-luanji-ui': '' },
        h('div', { className: 'lj-quote-head' },
          h('span', { className: 'lj-quote-tag' }, h(Icon, { kind: 'quote', size: 13 }), '引用'),
          h('span', { className: 'lj-quote-source' }, sourceName(value)),
          value.origin?.sessionTitle && h('span', { className: 'lj-quote-dot', 'aria-hidden': true }, '·'),
          value.origin?.sessionTitle && h('span', { className: 'lj-quote-session', title: value.origin.sessionTitle }, value.origin.sessionTitle)),
        h('blockquote', { className: compact ? 'lj-clamp' : '' }, value.text),
        long && onExpand && h('button', { type: 'button', className: 'lj-quote-more', onClick: onExpand }, compact ? '展开引用' : '收起引用'))
    }
    function readImage(file) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片。')
      if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请先缩小。')
      return createImageBitmap(file).then((bitmap) => {
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
        const data = canvas.toDataURL('image/webp', .86)
        if (data.length > 3 * 1024 * 1024) throw new Error('图片缩小后仍超过 2 MB，请换一张。')
        return { id: crypto.randomUUID(), name: file.name || '粘贴的图片', data }
      })
    }
    function ImageList({ items, onRemove }) {
      return items?.length ? h('div', { className: 'lj-images' }, items.map((im) => h('div', { className: 'lj-image', key: im.id }, h('img', { src: im.data, alt: im.name, loading: 'lazy' }), onRemove && h('button', { type: 'button', className: 'lj-image-remove', title: '移除图片', 'aria-label': '移除图片', onClick: () => onRemove(im.id) }, h(Icon, { kind: 'close', size: 12 }))))) : null
    }
    function Composer({ draftKey, floating = false }) {
      const s = useState(), value = s.drafts[draftKey]
      const input = React.useRef(null), file = React.useRef(null)
      const [processing, setProcessing] = React.useState(false)
      React.useEffect(() => { if (floating) input.current?.focus() }, [floating, draftKey])
      React.useEffect(() => {
        const el = input.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = Math.min(260, Math.max(floating ? 96 : 64, el.scrollHeight)) + 'px'
      }, [value.text, floating])
      async function attach(files) {
        const list = [...files]
        if (processing || s.busy || !list.length) return
        if (state.drafts[draftKey].images.length + list.length > 6) { toast('一条记录最多贴 6 张图。'); return }
        setProcessing(true)
        try {
          const added = await Promise.all(list.map(readImage))
          changeDraft(draftKey, { images: [...state.drafts[draftKey].images, ...added] })
        } catch (e) { toast(e.message) }
        finally { setProcessing(false) }
      }
      const canSave = draftKey === 'quote' ? value.text.trim() || value.images.length : value.text.trim() || value.images.length || value.quote
      return h('div', { className: 'lj-composer', onDragOver: (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }, onDrop: (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void attach(e.dataTransfer.files) } } },
        value.quote && h(Quote, { value: value.quote, compact: true }),
        h('div', { className: 'lj-editor' },
          h('textarea', { ref: input, className: 'lj-input', value: value.text, rows: 3, maxLength: 20000, disabled: s.busy || !s.ready, placeholder: value.quote ? '写下你的想法…' : '想到什么，记一下。', 'aria-label': value.quote ? '自己的想法' : '记录内容', onChange: (e) => changeDraft(draftKey, { text: e.target.value }), onPaste: (e) => { const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); void attach(files) } }, onKeyDown: (e) => { if (!e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (canSave && !processing) void saveDraft(draftKey) } } }),
          h('div', { className: 'lj-compose-actions' },
            h('button', { type: 'button', className: 'lj-tool', onClick: () => file.current.click(), disabled: processing || s.busy, title: '贴一张图片' }, h(Icon, { kind: 'image', size: 16 }), processing ? '处理中…' : '贴图'),
            h('input', { ref: file, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, onChange: (e) => { void attach(e.target.files); e.target.value = '' } }),
            value.images.length > 0 && h('span', { className: 'lj-count' }, `${value.images.length}/6`),
            h('span', { className: 'lj-shortcut' }, /Mac/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵'),
            h('button', { type: 'button', className: 'lj-primary', disabled: !s.ready || !canSave || s.busy || processing, onClick: () => void saveDraft(draftKey) }, s.busy ? '记录中…' : '记录'))),
        s.draftStatus[draftKey] && h('button', { type: 'button', className: 'lj-draft-status', onClick: () => void persistDraft(draftKey).catch(() => {}) }, h(Icon, { kind: s.draftStatus[draftKey].includes('未') ? 'close' : 'check', size: 12 }), s.draftStatus[draftKey]))
    }

    /**
     * 侧栏面板列表里的图标。整行由 DSH 外壳渲染成一个 button：
     * 行尾 38px 是「进面板」热区（由捕获阶段的 click 坐标判定），其余区域打开便签。
     * 视觉上的行尾小按钮是装饰元素，不嵌套交互控件。
     */
    function PanelGlyph({ size = 16, active = false }) {
      return h(React.Fragment, null,
        h('span', { className: 'lj-glyph' + (active ? ' lj-active' : ''), 'data-luanji-ui': '' }, h(Icon, { kind: 'note', size })),
        h('span', { className: 'lj-row-detail', 'data-lj-detail': '', 'aria-hidden': true, 'data-luanji-ui': '' }, h(Icon, { kind: 'grid', size: 14 })))
    }

    /** 浮窗定位：默认贴在侧栏行右侧；窄屏变成底部卡片。 */
    function floatStyle(anchor) {
      const vw = window.innerWidth, vh = window.innerHeight
      if (vw <= 720) return {}
      const width = Math.min(420, vw - 32)
      const maxHeight = Math.min(640, vh - 32)
      let left = (anchor?.right ?? 248) + 12
      if (left + width > vw - 16) left = Math.max(16, vw - width - 16)
      let top = (anchor?.top ?? 120) - 8
      top = Math.max(16, Math.min(top, vh - maxHeight - 16))
      return { left, top, width, maxHeight }
    }
    /** 提示条对齐对话输入框（主内容区）的横向中心，并浮在输入框上方。 */
    function toastWrapStyle() {
      const seat = document.querySelector('[data-composer-seat]')?.getBoundingClientRect()
      if (!seat || seat.width <= 0) return { left: 0, right: 0, bottom: 28 }
      return { left: Math.max(0, seat.left), width: seat.width, bottom: Math.max(12, window.innerHeight - seat.top + 12) }
    }
    function Overlays() {
      const s = useState()
      return createPortal(h('div', { className: 'lj-overlays', 'data-luanji-ui': '' },
        s.open && h('section', { className: 'lj-float', role: 'dialog', 'aria-label': s.open === 'quote' ? '引用并记录' : '乱记便签', style: floatStyle(anchorNow()), onKeyDown: (e) => { if (e.key === 'Escape' && !s.busy) { e.stopPropagation(); closeComposer() } } },
          h('div', { className: 'lj-float-head' },
            h('div', { className: 'lj-float-title' }, h('span', { className: 'lj-mark' }, h(Icon, { kind: 'note', size: 15 })), h('strong', null, s.open === 'quote' ? '引用并记录' : '乱记'), h('span', { className: 'lj-float-sub' }, s.open === 'quote' ? '原文在上，想法在下' : '先留下，再理解')),
            h('div', { className: 'lj-tools' },
              h('button', { className: 'lj-icon', type: 'button', title: '打开乱记面板', 'aria-label': '打开乱记面板', onClick: manage }, h(Icon, { kind: 'grid', size: 15 })),
              h('button', { className: 'lj-icon', type: 'button', title: '收起，保留草稿', 'aria-label': '收起便签', disabled: s.busy, onClick: closeComposer }, h(Icon, { kind: 'close', size: 16 })))),
          s.error && h('div', { className: 'lj-error', role: 'alert' }, s.error, h('button', { className: 'lj-quiet', onClick: () => void refresh() }, '重试')),
          h(Composer, { draftKey: s.open, floating: true }),
          s.open === 'quote' && h('button', { className: 'lj-discard', type: 'button', disabled: s.busy, onClick: () => { changeDraft('quote', empty()); set({ open: 'quick' }) } }, '清空这份引用草稿')),
        s.toast && h('div', { className: 'lj-toast-wrap', style: toastWrapStyle() },
          h('div', { className: 'lj-toast', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'lj-toast-icon' }, h(Icon, { kind: 'check', size: 13 })),
            h('span', null, s.toast),
            s.undo && h('button', { type: 'button', onClick: async () => { try { await api('/notes/' + encodeURIComponent(s.undo), { method: 'DELETE' }); toast('已撤销'); await refresh() } catch (e) { toast(e.message) } } }, '撤销')))), document.body)
    }

    /**
     * DSH 原生划选浮层的动作区（注册在 conversation.chat.text-interaction 的 quote 键上）。
     * 取代原来的「原生引用文本 + 乱记独立动作条」两层浮层：整个浮层只有这一排，
     * 外观沿用 DSH 原生浮动按钮的令牌（floating-fill / elevation-panel / 999px 圆角）。
     */
    function QuoteActions({ trigger, dismiss, readText, clearSelection, inputActions }) {
      const [busy, setBusy] = React.useState(false)
      const close = () => { try { clearSelection?.() } catch { /* selection already gone */ } dismiss?.() }
      async function record() {
        if (busy) return
        const quote = readSelectionQuote()
        if (!quote) { close(); return }
        setBusy(true)
        try { if (await recordSelection(quote)) close() }
        finally { setBusy(false) }
      }
      function quoteAndRecord() {
        const quote = readSelectionQuote()
        if (!quote) { close(); return }
        if (state.drafts.quote.quote && JSON.stringify(state.drafts.quote.quote) !== JSON.stringify(quote)) {
          toast('先记录或清空上一份引用草稿，再引用这一句。'); close(); return
        }
        returnFocus = document.activeElement
        changeDraft('quote', { quote })
        set({ open: 'quote' })
        close()
      }
      function quoteToComposer() {
        const text = typeof readText === 'function' ? readText() : null
        if (text === null || text === undefined) { close(); return }
        const inserted = inputActions?.insertQuote?.(text)
        if (inserted === false) return
        close()
      }
      return h('div', { className: 'lj-selbar', 'data-luanji-ui': '', role: 'toolbar', 'aria-label': '划选记录', 'data-trigger': trigger, onPointerDown: (event) => event.preventDefault() },
        h('button', { type: 'button', className: 'lj-selbar-btn lj-selbar-primary', disabled: busy, onClick: () => void record() }, h(Icon, { kind: 'check', size: 14 }), busy ? '保存中…' : '记录'),
        h('span', { className: 'lj-selbar-divider', 'aria-hidden': true }),
        h('button', { type: 'button', className: 'lj-selbar-btn', disabled: busy, onClick: quoteAndRecord }, h(Icon, { kind: 'quote', size: 14 }), '引用并记录'),
        typeof inputActions?.insertQuote === 'function' && h(React.Fragment, null,
          h('span', { className: 'lj-selbar-divider', 'aria-hidden': true }),
          h('button', { type: 'button', className: 'lj-selbar-btn', disabled: busy, title: '把原文作为引用放进输入框', onClick: quoteToComposer }, h(Icon, { kind: 'arrow', size: 13 }), '引用文本')))
    }

    function RecordCard({ record }) {
      const [editing, setEditing] = React.useState(false), [value, setValue] = React.useState(record.text), [confirm, setConfirm] = React.useState(false), [saving, setSaving] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)
      async function remove() {
        if (!confirm) { setConfirm(true); return }
        setSaving(true)
        try { await api('/notes/' + encodeURIComponent(record.id), { method: 'DELETE' }); toast('已删除'); await refresh() }
        catch (e) { toast(e.message) } finally { setSaving(false) }
      }
      async function update() {
        setSaving(true)
        try { await api('/notes/' + encodeURIComponent(record.id), { method: 'PUT', body: { text: value } }); setEditing(false); toast('已保存'); await refresh() }
        catch (e) { toast(e.message) } finally { setSaving(false) }
      }
      return h('article', { className: 'lj-card', 'data-record-id': record.id },
        record.quote && h(Quote, { value: record.quote, compact: !expanded, onExpand: () => setExpanded(!expanded) }),
        editing
          ? h('div', { className: 'lj-card-edit' },
            h('textarea', { className: 'lj-edit', value, 'aria-label': '编辑自己的想法', onChange: (e) => setValue(e.target.value), maxLength: 20000 }),
            h('div', { className: 'lj-tools' }, h('button', { className: 'lj-quiet', disabled: saving, onClick: () => setEditing(false) }, '取消'), h('button', { className: 'lj-primary lj-small', disabled: saving, onClick: () => void update() }, '保存')))
          : record.text && h('p', { className: 'lj-card-text' }, record.text),
        h(ImageList, { items: record.images }),
        h('div', { className: 'lj-card-foot' },
          h('span', { className: 'lj-meta' }, h(Icon, { kind: 'clock', size: 12 }), when(record.created_at), record.source === 'agent' ? ' · 对话代记' : ''),
          h('div', { className: 'lj-card-actions' },
            record.quote?.origin.sessionId && h('button', { className: 'lj-quiet', onClick: () => void jump(record.quote) }, h(Icon, { kind: 'arrow', size: 13 }), '回到对话'),
            h('button', { className: 'lj-quiet', onClick: () => { setValue(record.text); setEditing(true) } }, h(Icon, { kind: 'edit', size: 13 }), record.quote && !record.text ? '补充想法' : '编辑'),
            h('button', { className: 'lj-quiet' + (confirm ? ' lj-danger' : ''), disabled: saving, onBlur: () => setConfirm(false), onClick: () => void remove() }, h(Icon, { kind: 'trash', size: 13 }), confirm ? '确认删除' : '删除'))))
    }
    function Management() {
      const s = useState(), [query, setQuery] = React.useState(''), [results, setResults] = React.useState(null), [searching, setSearching] = React.useState(false)
      const file = React.useRef(null), search = React.useRef(null), page = React.useRef(null)
      const [cloudBusy, setCloudBusy] = React.useState('')
      React.useEffect(() => { page.current?.focus({ preventScroll: true }) }, [])
      React.useEffect(() => { void refresh() }, [])
      React.useEffect(() => {
        let live = true
        if (!query.trim()) { setResults(null); setSearching(false); return }
        setSearching(true)
        const timer = setTimeout(() => api('/search?q=' + encodeURIComponent(query.trim())).then((v) => { if (live) { setResults(v.records); setSearching(false) } }).catch((e) => { if (live) { toast(e.message); setSearching(false) } }), 180)
        return () => { live = false; clearTimeout(timer) }
      }, [query, s.records])
      async function importFile(f) {
        if (!f) return
        try { const data = await api('/import', { method: 'POST', body: JSON.parse(await f.text()) }); toast(`已导入 ${data.added} 条，更新 ${data.updated} 条`); await refresh() }
        catch (e) { toast('导入失败：' + e.message) }
      }
      async function syncCloud(direction) {
        if (cloudBusy) return
        setCloudBusy(direction)
        try {
          const data = await api('/cloud/' + direction, { method: 'POST' })
          const result = data.result || {}
          if (direction === 'pull') toast(`云端拉取完成：新增 ${result.added || 0} 条，更新 ${result.updated || 0} 条`)
          else toast(`云端推送完成：${result.records || 0} 条正文`)
          await refresh()
        } catch (e) { toast('云端同步失败：' + e.message) }
        finally { setCloudBusy('') }
      }
      const cloud = s.cloud || { configured: false }
      const cloudWhen = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
      const rows = results || s.records
      return h('main', { className: 'lj-page', 'data-luanji-ui': '', ref: page, tabIndex: -1, onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); search.current.focus() } } },
        h('div', { className: 'lj-page-glow', 'aria-hidden': true }),
        h('header', { className: 'lj-hero' },
          h('div', { className: 'lj-hero-brand' },
            h('span', { className: 'lj-hero-mark' }, h(Icon, { kind: 'note', size: 20 })),
            h('div', null, h('h1', null, '乱记'), h('p', null, '随手留下，需要时找回来。'))),
          h('div', { className: 'lj-hero-actions' },
            s.loaded && h('span', { className: 'lj-pill' }, `${s.records.length} 条`),
            h('button', { className: 'lj-ghost', onClick: () => ctx.layout.selectPanel(null) }, '返回对话'))),
        h('section', { className: 'lj-compose-card' },
          h(Composer, { draftKey: 'manage' })),
        cloud.configured && h('section', { className: 'lj-cloudbar', 'aria-label': '云端同步' },
          h('span', { className: 'lj-cloud-dot', 'aria-hidden': true }),
          h('span', { className: 'lj-cloud-text' }, '云端 · ', cloud.host || cloud.url),
          h('span', { className: 'lj-cloud-meta' },
            cloud.lastPullAt ? `上次拉取 ${cloudWhen(cloud.lastPullAt)}` : '尚未拉取',
            cloud.lastError && h('span', { className: 'lj-cloud-error', title: cloud.lastError }, ' · 上次失败')),
          h('div', { className: 'lj-cloud-actions' },
            h('button', { type: 'button', className: 'lj-ghost lj-small', disabled: Boolean(cloudBusy), onClick: () => void syncCloud('pull') }, cloudBusy === 'pull' ? '拉取中…' : '从云端拉取'),
            h('button', { type: 'button', className: 'lj-ghost lj-small', disabled: Boolean(cloudBusy), onClick: () => void syncCloud('push') }, cloudBusy === 'push' ? '推送中…' : '推到云端'))),
        h('div', { className: 'lj-list-head' },
          h('div', { className: 'lj-list-title' }, h('h2', null, query ? '查找记录' : '最近记录'), query && !searching && results && h('span', { className: 'lj-count' }, `${results.length} 条`)),
          h('label', { className: 'lj-search' }, h(Icon, { kind: 'search', size: 15 }), h('input', { ref: search, type: 'search', value: query, placeholder: '找原话、模型或对话', 'aria-label': '搜索记录', onChange: (e) => setQuery(e.target.value) }))),
        s.error ? h('div', { className: 'lj-empty' }, h(Icon, { kind: 'note', size: 22 }), h('p', null, s.error), h('button', { className: 'lj-ghost', onClick: () => void refresh() }, '重试'))
          : !s.loaded ? h('div', { className: 'lj-empty lj-loading' }, '正在读取本机记录…')
            : searching ? h('div', { className: 'lj-empty' }, '查找中…')
              : rows.length ? h('div', { className: 'lj-cards' }, rows.map((r) => h(RecordCard, { key: r.id, record: r })))
                : h('div', { className: 'lj-empty' }, h(Icon, { kind: 'inbox', size: 26 }), h('p', null, query ? '没有找到，换个词试试。' : '对话里划选一句话，就能记在这里。也可以直接在上面写，或贴一张图。')),
        h('footer', { className: 'lj-page-foot' },
          h('span', { className: 'lj-meta' }, h(Icon, { kind: 'check', size: 12 }), '记录保存在本机', !cloud.configured && h('span', { className: 'lj-cloud-hint', title: '可选：在插件配置里填 cloud.url + 请求头' }, ' · 云端未配置（可选）')),
          h('div', { className: 'lj-tools' },
            h('a', { className: 'lj-quiet', href: API + '/export', download: 'luanji-notes.json' }, '导出'),
            h('button', { className: 'lj-quiet', onClick: () => file.current.click() }, '导入'),
            h('input', { ref: file, type: 'file', accept: '.json', hidden: true, onChange: (e) => { void importFile(e.target.files[0]); e.target.value = '' } }))))
    }

    // DSH 0.2.1: stable semantic node attributes + session-owned event source.
    const NODE = '[data-chat-node-key]'
    function current() {
      const rows = ctx.sessions.list.getSnapshot().byId
      return Object.values(rows).find((row) => (row.retainedBy?.mainView || 0) > 0) || null
    }
    function textNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement?.closest('button,textarea,input,script,style,[aria-hidden="true"],[hidden],[data-luanji-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT } })
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); return nodes
    }
    function content(root) { return textNodes(root).map((n) => n.data).join('') }
    function offset(root, container, at) {
      const pre = document.createRange(); pre.selectNodeContents(root); pre.setEnd(container, at)
      return textNodes(root).reduce((total, n) => {
        if (n === container) return total + at
        try { return total + (pre.intersectsNode(n) ? n.data.length : 0) } catch { return total }
      }, 0)
    }
    function resolveOrigin(root) {
      const sessionId = root.closest('[data-conversation-session]')?.dataset.conversationSession
      const row = ctx.sessions.list.getSnapshot().byId[sessionId]; if (!row) return null
      const nodeKey = root.dataset.chatNodeKey
      const binding = ctx.sessions.binding(row.id)
      const snapshot = ctx.uiConversation.binding(binding).target('chat').getSnapshot()
      const node = snapshot?.nodes?.get(nodeKey)
      if (!node || !['user', 'steering', 'assistant-step'].includes(node.kind)) return null
      const role = node.kind === 'assistant-step' ? 'assistant' : 'user'
      const events = binding.eventSource.getSnapshot().entries.map((entry) => entry.event)
      const event = role === 'assistant' ? events.findLast((e) => e.type === 'assistant/message' && e.data.turn === node.data.turn && e.data.step === node.data.step) : events.find((e) => e.type === 'user/message' && e.data.seq === node.data.seq)
      const source = event?.data?.message?.source
      return { role, model: role === 'assistant' ? source?.model || '' : '', sessionId: row.id, sessionTitle: row.title || '', messageId: String(event?.data?.message?.id || event?.data?.id || ''), seq: event?.seq ?? node.anchorSeq ?? null, nodeKey, turn: node.data.turn ?? Number(root.dataset.chatTurn) }
    }
    /**
     * 读取当前划选，生成一条可保存的引用（原文、来源、文本锚点）。
     * 不写入任何状态：动作条由 DSH 原生的 text-interaction 浮层承载。
     * @returns 引用对象，或 null（无选区、跨节点、不可定位等）。
     */
    function readSelectionQuote() {
      if (state.open) return null
      const selection = window.getSelection()
      if (!selection?.rangeCount || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
      const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement
      if (startEl?.closest('[data-luanji-ui],textarea,input,[contenteditable="true"]')) return null
      const root = startEl?.closest(NODE)
      if (!root || root !== endEl?.closest(NODE)) return null
      let origin
      try { origin = resolveOrigin(root) } catch { origin = null }
      if (!origin) return null
      const text = range.toString()
      if (!text.trim() || text.length > 20000) return null
      const full = content(root), start = offset(root, range.startContainer, range.startOffset), end = offset(root, range.endContainer, range.endOffset)
      const exact = full.slice(start, end)
      if (!exact.trim()) return null
      return { text, origin, anchor: { exact, start, end, prefix: full.slice(Math.max(0, start - 40), start), suffix: full.slice(end, end + 40) } }
    }
    function locate(root, anchor) {
      const nodes = textNodes(root), full = nodes.map((n) => n.data).join(''), exact = anchor.exact
      let start = anchor.start
      if (start < 0 || full.slice(start, start + exact.length) !== exact) {
        const matches = []; let from = 0
        while (from < full.length) { const i = full.indexOf(exact, from); if (i < 0) break; if ((!anchor.prefix || full.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix) && (!anchor.suffix || full.slice(i + exact.length, i + exact.length + anchor.suffix.length) === anchor.suffix)) matches.push(i); from = i + Math.max(1, exact.length) }
        if (matches.length !== 1) return null
        start = matches[0]
      }
      let cursor = 0, a, b
      for (const node of nodes) {
        if (!a && start < cursor + node.length) a = [node, start - cursor]
        if (a && start + exact.length <= cursor + node.length) { b = [node, start + exact.length - cursor]; break }
        cursor += node.length
      }
      if (!a || !b) return null
      const range = document.createRange(); range.setStart(...a); range.setEnd(...b); return range
    }
    function highlight() {
      if (disposed) return
      const roots = [...document.querySelectorAll(NODE)]
      if (!roots.length) { window.CSS?.highlights?.delete('luanji-recorded'); return }
      const buckets = new Map()
      for (const root of roots) {
        const key = (root.closest('[data-conversation-session]')?.dataset.conversationSession || '') + '|' + root.dataset.chatNodeKey
        const list = buckets.get(key); if (list) list.push(root); else buckets.set(key, [root])
      }
      const ranges = []
      for (const r of state.records) {
        const q = r.quote
        if (!q) continue
        const list = buckets.get(q.origin.sessionId + '|' + q.origin.nodeKey)
        if (!list) continue
        for (const root of list) { const range = locate(root, q.anchor); if (range) ranges.push(range) }
      }
      if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('luanji-recorded', new Highlight(...ranges))
    }
    function scheduleHighlights() { clearTimeout(highlightTimer); highlightTimer = setTimeout(highlight, 180) }
    async function jump(q) {
      set({ open: null }); ctx.uiWorkspace.openSession(q.origin.sessionId); ctx.layout.selectPanel(null)
      const until = Date.now() + 10000
      let loading = false
      await new Promise((resolve) => {
        const tick = () => {
          if (disposed) { resolve(); return }
          const candidates = current()?.id === q.origin.sessionId ? [...document.querySelectorAll(NODE)].filter((el) => el.dataset.chatNodeKey === q.origin.nodeKey && el.closest('[data-conversation-session]')?.dataset.conversationSession === q.origin.sessionId) : []
          // DSH can render reasoning and answer fragments with the same node key.
          const match = candidates.map((root) => ({ root, range: locate(root, q.anchor) })).find((item) => item.range)
          const root = match?.root || candidates.find((el) => el.getClientRects().length)
          if (root) {
            const target = match?.range.startContainer
            const element = target ? (target.nodeType === 1 ? target : target.parentElement) : root
            element.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); scheduleHighlights(); resolve()
          }
          else if (!loading && Number.isFinite(q.origin.seq) && ctx.sessions.binding(q.origin.sessionId)?.session) {
            loading = true
            Promise.resolve(ctx.sessions.binding(q.origin.sessionId).session.loadThrough(q.origin.seq)).catch(() => {}).finally(() => setTimeout(tick, 100))
          }
          else if (Date.now() > until) { toast('已请求打开来源对话；原句可能在尚未加载的较早消息中。'); resolve() }
          else setTimeout(tick, 100)
        }; tick()
      })
    }
    function apply(context) {
      ctx = context
      ctx.effect(() => {
        disposed = false
        const style = document.createElement('style'); style.dataset.luanji = ''; style.textContent = STYLES; document.head.append(style)
        // 面板列表这一行由 DSH 外壳渲染：行尾 38px 进面板，其余区域打开记录便签。
        const DETAIL_ZONE = 38
        const rowClick = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          const row = target.closest('button')
          if (!row || !row.querySelector?.('.lj-glyph')) return
          const rect = row.getBoundingClientRect()
          event.preventDefault(); event.stopPropagation()
          if (rect.width > 120 && event.clientX >= rect.right - DETAIL_ZONE) { manage(); return }
          openQuick()
        }
        const keyboard = (event) => {
          if (event.defaultPrevented || event.isComposing) return
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyL') { event.preventDefault(); openQuick() }
          else if (event.key === 'Escape' && state.open) closeComposer()
        }
        document.addEventListener('click', rowClick, true)
        document.addEventListener('keydown', keyboard)
        const observer = new MutationObserver((mutations) => {
          watchRow()
          if (mutations.some((m) => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('[data-luanji-ui],style'))) scheduleHighlights()
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        const unsubscribe = ctx.sessions.list.subscribe(scheduleHighlights)
        const focus = () => void refresh(); window.addEventListener('focus', focus)
        const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 12000)
        // 侧栏折叠 / 窗口缩放时让便签跟随行位置：用新快照触发一次真实渲染。
        let frame = 0, watchedRow = null, rowObserver = null
        function reflow() { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; if (state.open) set({}) }) }
        function watchRow() {
          const row = document.querySelector('.lj-glyph')?.closest('button')
          if (!row || row === watchedRow) return
          watchedRow = row
          row.setAttribute('aria-description', '点按打开记录便签；行尾小按钮进入乱记面板')
          rowObserver?.disconnect(); rowObserver = new ResizeObserver(reflow); rowObserver.observe(row)
        }
        const layoutObserver = new ResizeObserver(reflow)
        layoutObserver.observe(document.body)
        watchRow()
        window.addEventListener('resize', reflow)
        void refresh()
        return () => {
          for (const [key] of timers) void persistDraft(key).catch(() => {})
          disposed = true; style.remove(); observer.disconnect(); layoutObserver.disconnect(); rowObserver?.disconnect(); watchedRow?.removeAttribute?.('aria-description'); unsubscribe(); clearInterval(interval); clearTimeout(highlightTimer); clearTimeout(toastTimer); cancelAnimationFrame(frame)
          document.removeEventListener('click', rowClick, true); document.removeEventListener('keydown', keyboard); window.removeEventListener('focus', focus); window.removeEventListener('resize', reflow)
          window.CSS?.highlights?.delete('luanji-recorded')
        }
      }, 'luanji: selection and persistent marks')
      for (const [name, options, component] of [
        ['main', { key: 'luanji' }, Management],
        ['sidebar.panellist', { id: 'luanji', order: 5, label: '乱记' }, PanelGlyph],
        ['shell.overlay', { id: 'luanji-overlays' }, Overlays],
        // 接管 DSH 原生划选浮层的 quote 键渲染：一个浮层里放乱记的动作，不再额外浮一层。
        ['conversation.chat.text-interaction', { key: 'luanji' }, QuoteActions],
      ]) ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options, inject: () => ({}) }, component)), 'luanji: ' + name)
      // 划选时先于 DSH 原生引用动作打开同一个浮层：只出现一排按钮。
      // 动作表里的「引用文本」仍然调用原生 inputActions.insertQuote，保留原行为。
      ctx.effect(() => ctx.uiConversation.interactions.register({
        id: 'luanji',
        onInteraction(request) {
          if (request.trigger !== 'selection' && request.trigger !== 'contextmenu') return
          if (request.readText() === null) return
          const binding = ctx.sessions.binding(request.sessionId)
          if (!binding) return
          const session = binding.session.getSnapshot()
          if (session.removed) return
          if (session.subagent !== null && (session.subagent.address.mode !== 'continuable' || session.subagent.parentAvailable !== true)) return
          request.open()
        },
      }), 'luanji: text interaction admission')
    }

    const STYLES = `
/* ============ 主题令牌：跟随 DSH 明暗，蓝紫作强调色 ============ */
[data-luanji-ui] {
  --lj-accent: var(--dsw-static-deepseek-450, #5686fe);
  --lj-accent-strong: var(--dsw-static-deepseek-500, #4176e6);
  --lj-on-accent: var(--dsw-static-neutral-00, #fff);
  --lj-accent-soft: color-mix(in srgb, var(--lj-accent) 14%, transparent);
  --lj-accent-line: color-mix(in srgb, var(--lj-accent) 38%, transparent);
  --lj-text: var(--dsw-alias-label-primary, inherit);
  --lj-muted: var(--dsw-alias-label-secondary, inherit);
  --lj-faint: var(--dsw-alias-label-tertiary, inherit);
  --lj-line: var(--dsw-alias-border-l1, transparent);
  --lj-line-strong: var(--dsw-alias-border-l2, transparent);
  --lj-surface: var(--dsw-alias-bg-layer-1, transparent);
  --lj-surface-2: var(--dsw-alias-bg-layer-2, transparent);
  --lj-glass: color-mix(in srgb, var(--lj-surface) 74%, transparent);
  --lj-glass-strong: color-mix(in srgb, var(--lj-surface-2) 92%, transparent);
  --lj-card-bg: color-mix(in srgb, var(--lj-surface) 92%, transparent);
  --lj-card-border: var(--dsw-alias-border-l2, #0000001a);
  --lj-card-shadow: 0 14px 36px -30px rgb(0 0 0 / .5);
  --lj-glow: color-mix(in srgb, var(--lj-accent) 8%, transparent);
  --lj-hover: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  --lj-shadow: 0 24px 60px -20px rgb(0 0 0 / .6), 0 6px 18px -8px rgb(0 0 0 / .45);
  color: var(--lj-text);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  box-sizing: border-box;
}
body[data-ds-dark-theme] [data-luanji-ui] {
  --lj-glass: color-mix(in srgb, var(--lj-surface) 66%, transparent);
  --lj-glass-strong: color-mix(in srgb, var(--lj-surface-2) 84%, transparent);
  --lj-card-bg: color-mix(in srgb, var(--lj-surface-2) 82%, transparent);
  --lj-card-border: color-mix(in srgb, var(--dsw-static-neutral-00, #fff) 9%, transparent);
  --lj-card-shadow: 0 18px 42px -34px rgb(0 0 0 / .95);
  --lj-glow: color-mix(in srgb, var(--lj-accent) 17%, transparent);
}
[data-luanji-ui] *, [data-luanji-ui] *::before, [data-luanji-ui] *::after { box-sizing: border-box; }
[data-luanji-ui] :where(button, input, textarea) { font: inherit; color: inherit; }
[data-luanji-ui] :where(button) { border: 0; background: none; cursor: pointer; }
[data-luanji-ui] button:disabled { opacity: .45; cursor: default; }
[data-luanji-ui] :is(button, a, input, textarea):focus-visible { outline: 2px solid var(--lj-accent); outline-offset: 2px; }
[data-luanji-ui] a { color: inherit; text-decoration: none; }
[data-luanji-ui] svg { display: block; flex: none; }

/* ============ 侧栏面板行：整行开便签，行尾小按钮进面板 ============ */
.lj-glyph { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
.lj-glyph.lj-active { color: var(--lj-accent); }
button:has(.lj-glyph) { position: relative; padding-right: 38px !important; }
.lj-row-detail {
  position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px; color: var(--lj-muted); opacity: .78; pointer-events: none;
  transition: opacity .14s, background .14s, color .14s;
}
button:has(.lj-glyph):hover .lj-row-detail { opacity: 1; background: var(--lj-accent-soft); color: var(--lj-accent); }
[class*="collapsed"] .lj-row-detail { display: none !important; }
[class*="collapsed"] button:has(.lj-glyph) { padding-right: 0 !important; }
::highlight(luanji-recorded) {
  background-color: color-mix(in srgb, var(--dsw-static-deepseek-450, #5686fe) 22%, transparent);
  text-decoration: underline; text-decoration-color: var(--dsw-static-deepseek-450, #5686fe);
  text-decoration-thickness: 1.5px; text-underline-offset: 3px;
}

/* ============ 划选浮层（DSH 原生 text-interaction 的 quote 键） ============ */
.lj-overlays { position: relative; z-index: 1100; }
.lj-selbar {
  display: inline-flex; align-items: center; gap: 2px; padding: 4px; max-width: 100%;
  background: var(--dsw-alias-button-floating-fill, var(--lj-glass-strong));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px/20px var(--dsw-font-family, inherit));
  border-radius: 999px; corner-shape: round; flex-wrap: wrap;
  box-shadow: var(--dsw-elevation-panel, var(--lj-shadow));
  animation: lj-rise .14s cubic-bezier(.2,.8,.2,1);
}
.lj-selbar-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border-radius: 999px; white-space: nowrap; color: inherit; font: inherit;
  transition: background .14s, color .14s;
}
.lj-selbar-btn:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover, var(--lj-hover)); }
.lj-selbar-btn:focus-visible { outline: 2px solid var(--lj-accent); outline-offset: 1px; }
.lj-selbar-primary { color: var(--lj-accent); font-weight: 500; }
.lj-selbar-divider { width: 1px; height: 14px; margin: 0 1px; background: var(--dsw-alias-border-l3, var(--lj-line-strong)); opacity: .7; }

/* ============ 记录便签浮窗 ============ */
.lj-float {
  position: fixed; z-index: 4; overflow: auto; overscroll-behavior: contain;
  background: var(--lj-glass); border: 1px solid var(--lj-line-strong); border-radius: 20px;
  box-shadow: var(--lj-shadow); backdrop-filter: blur(30px) saturate(170%); -webkit-backdrop-filter: blur(30px) saturate(170%);
  animation: lj-pop .18s cubic-bezier(.2,.8,.2,1); transform-origin: left top;
}
.lj-float::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(120% 70% at 0% 0%, var(--lj-glow), transparent 64%);
}
.lj-float > * { position: relative; }
.lj-float-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 15px 14px 6px 16px; }
.lj-float-title { display: flex; align-items: center; gap: 9px; min-width: 0; }
.lj-float-title strong { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.lj-float-sub { color: var(--lj-faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lj-mark { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; background: var(--lj-accent-soft); color: var(--lj-accent); }
.lj-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; color: var(--lj-muted); transition: background .14s, color .14s; }
.lj-icon:hover { background: var(--lj-hover); color: var(--lj-text); }
.lj-float .lj-composer { padding: 6px 16px 16px; }
.lj-discard { color: var(--lj-faint); font-size: 12px; margin: 0 16px 14px; padding: 0; }
.lj-discard:hover { color: var(--lj-danger, var(--dsw-alias-state-error-primary, #f25a5a)); }

/* ============ 输入区 ============ */
.lj-composer { display: flex; flex-direction: column; }
.lj-editor { border: 1px solid var(--lj-line); border-radius: 14px; background: color-mix(in srgb, var(--lj-surface-2) 55%, transparent); padding: 11px 13px 9px; transition: border-color .16s, box-shadow .16s; }
.lj-editor:focus-within { border-color: var(--lj-accent-line); box-shadow: 0 0 0 3px var(--lj-accent-soft); }
.lj-input { display: block; width: 100%; min-height: 68px; max-height: 260px; resize: none; border: 0; background: none; outline: 0 !important; line-height: 1.8; padding: 0; color: var(--lj-text); }
.lj-input::placeholder, .lj-search input::placeholder { color: var(--lj-faint); opacity: 1; }
.lj-compose-actions { display: flex; align-items: center; gap: 8px; padding-top: 9px; }
.lj-tool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--lj-muted); padding: 4px 7px; border-radius: 7px; transition: background .14s, color .14s; }
.lj-tool:hover:not(:disabled) { background: var(--lj-hover); color: var(--lj-text); }
.lj-count { font-size: 11px; color: var(--lj-faint); }
.lj-shortcut { color: var(--lj-faint); font-size: 11px; margin-left: auto; }
.lj-primary { background: var(--lj-accent); color: var(--lj-on-accent); padding: 6px 16px; border-radius: 9px; font-size: 13px; font-weight: 500; box-shadow: 0 6px 16px -10px color-mix(in srgb, var(--lj-accent) 80%, transparent); transition: background .14s, transform .1s; }
.lj-primary:hover:not(:disabled) { background: var(--lj-accent-strong); }
.lj-primary:active:not(:disabled) { transform: scale(.98); }
.lj-primary.lj-small { padding: 4px 12px; font-size: 12px; }
.lj-quiet { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--lj-muted); padding: 4px 6px; border-radius: 7px; white-space: nowrap; transition: background .14s, color .14s; }
.lj-quiet:hover { background: var(--lj-hover); color: var(--lj-text); }
.lj-danger { color: var(--dsw-alias-state-error-primary, #f25a5a) !important; }
.lj-draft-status { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; color: var(--lj-faint); font-size: 11px; padding: 8px 0 0; }
.lj-draft-status:hover { color: var(--lj-muted); }

/* ============ 引用块：引用在上 ============ */
.lj-quote {
  position: relative; margin: 0 0 12px; padding: 10px 12px 10px 13px; border-radius: 11px;
  background: color-mix(in srgb, var(--lj-accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--lj-accent) 16%, transparent);
}
.lj-quote::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 3px; background: var(--lj-accent); opacity: .75; }
.lj-quote-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; min-width: 0; }
.lj-quote-tag { display: inline-flex; align-items: center; gap: 3px; flex: none; white-space: nowrap; font-size: 11px; font-weight: 600; color: var(--lj-accent); letter-spacing: .02em; }
.lj-quote-source { flex: none; font-size: 11px; color: var(--lj-muted); white-space: nowrap; }
.lj-quote-dot { flex: none; color: var(--lj-faint); font-size: 11px; margin: 0 -2px; }
.lj-quote-session { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--lj-faint); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lj-quote blockquote { margin: 0; padding: 0; font-size: 13.5px; line-height: 1.75; color: var(--lj-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.lj-clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.lj-quote-more { margin-top: 5px; font-size: 11px; color: var(--lj-accent); padding: 0; }

/* ============ 图片 ============ */
.lj-images { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.lj-image { position: relative; max-width: 100%; border-radius: 12px; overflow: hidden; }
.lj-image img { display: block; max-width: 100%; height: 116px; max-height: 200px; object-fit: cover; }
.lj-card .lj-image img { height: auto; max-height: 340px; object-fit: contain; }
.lj-image-remove { position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; border-radius: 12px; background: rgb(0 0 0 / .55); color: var(--lj-on-accent); display: inline-flex; align-items: center; justify-content: center; backdrop-filter: blur(6px); }
.lj-image-remove:hover { background: rgb(0 0 0 / .72); }

/* ============ 提示条（对齐输入框中心、浮在输入框上方） ============ */
.lj-toast-wrap { position: fixed; z-index: 5; display: flex; align-items: flex-end; justify-content: center; pointer-events: none; }
.lj-toast {
  pointer-events: auto; display: flex; align-items: center; gap: 9px; padding: 9px 14px 9px 11px;
  max-width: min(520px, calc(100vw - 32px));
  background: var(--lj-glass-strong); border: 1px solid var(--lj-line-strong); border-radius: 13px;
  box-shadow: var(--lj-shadow); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%);
  font-size: 13px; animation: lj-rise .18s cubic-bezier(.2,.8,.2,1);
}
.lj-toast-icon { display: inline-flex; align-items: center; justify-content: center; width: 21px; height: 21px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #22c55e); color: var(--lj-on-accent); }
.lj-toast button { margin-left: 6px; color: var(--lj-accent); font-size: 12.5px; font-weight: 500; padding: 3px 6px; border-radius: 6px; }
.lj-toast button:hover { background: var(--lj-accent-soft); }

/* ============ 云端同步条（仅配置后出现） ============ */
.lj-cloudbar { display: flex; align-items: center; gap: 9px; padding: 9px 13px; margin: -10px 0 18px; border: 1px solid var(--lj-line); border-radius: 13px; background: color-mix(in srgb, var(--lj-surface) 40%, transparent); font-size: 12px; color: var(--lj-muted); }
.lj-cloud-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-success-primary, #22c55e); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 16%, transparent); }
.lj-cloud-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--lj-text); }
.lj-cloud-meta { color: var(--lj-faint); white-space: nowrap; }
.lj-cloud-error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
.lj-cloud-actions { margin-left: auto; display: flex; gap: 6px; flex: none; }
.lj-ghost.lj-small { padding: 4px 9px; font-size: 12px; border-radius: 8px; }
.lj-cloud-hint { color: var(--lj-faint); }

/* ============ 详情 / 管理面板 ============ */
.lj-page:focus, .lj-page:focus-visible { outline: none; }
.lj-page {
  width: 100%; max-width: 820px; height: 100%; overflow-y: auto; margin: 0 auto; position: relative;
  padding: calc(var(--dsh-frame-top-clearance, 0px) + 34px) 32px 40px;
}
.lj-page-glow { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: min(900px, 120%); height: 320px; pointer-events: none;
  background: radial-gradient(60% 100% at 50% 0%, var(--lj-glow), transparent 72%); }
.lj-hero { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.lj-hero-brand { display: flex; align-items: center; gap: 13px; }
.lj-hero-mark { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 13px; color: var(--lj-accent);
  background: linear-gradient(145deg, color-mix(in srgb, var(--lj-accent) 22%, transparent), color-mix(in srgb, var(--lj-accent) 6%, transparent));
  border: 1px solid color-mix(in srgb, var(--lj-accent) 22%, transparent); box-shadow: 0 8px 20px -12px color-mix(in srgb, var(--lj-accent) 60%, transparent); }
.lj-hero h1 { font-size: 22px; line-height: 1.3; margin: 0; font-weight: 650; letter-spacing: .01em; }
.lj-hero p { margin: 4px 0 0; color: var(--lj-muted); font-size: 13px; }
.lj-hero-actions { display: flex; align-items: center; gap: 10px; padding-top: 4px; }
.lj-pill { font-size: 12px; color: var(--lj-muted); padding: 4px 10px; border-radius: 999px; background: color-mix(in srgb, var(--lj-surface-2) 60%, transparent); border: 1px solid var(--lj-line); }
.lj-ghost { font-size: 13px; color: var(--lj-muted); padding: 6px 10px; border-radius: 9px; border: 1px solid var(--lj-line); background: color-mix(in srgb, var(--lj-surface) 55%, transparent); transition: background .14s, color .14s, border-color .14s; }
.lj-ghost:hover { background: var(--lj-hover); color: var(--lj-text); border-color: var(--lj-line-strong); }

.lj-compose-card {
  position: relative; padding: 16px 18px 14px; border-radius: 18px; margin-bottom: 26px;
  background: var(--lj-glass); border: 1px solid var(--lj-line-strong);
  box-shadow: 0 1px 0 rgb(255 255 255 / .03) inset, 0 16px 40px -28px rgb(0 0 0 / .6);
  backdrop-filter: blur(24px) saturate(150%); -webkit-backdrop-filter: blur(24px) saturate(150%);
}
.lj-compose-card::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(90% 120% at 0% 0%, var(--lj-accent-soft), transparent 55%);
}
.lj-compose-card > * { position: relative; }
.lj-compose-card .lj-composer .lj-editor { border-color: transparent; background: transparent; padding: 0; box-shadow: none !important; }
.lj-compose-card .lj-composer { gap: 0; }

.lj-list-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 12px; }
.lj-list-title { display: flex; align-items: baseline; gap: 10px; }
.lj-list-title h2 { font-size: 13px; font-weight: 600; color: var(--lj-muted); margin: 0; letter-spacing: .02em; }
.lj-search {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 12px; border-radius: 11px;
  background: color-mix(in srgb, var(--lj-surface) 60%, transparent); border: 1px solid var(--lj-line);
  color: var(--lj-faint); transition: border-color .16s, background .16s, box-shadow .16s;
}
.lj-search:focus-within { border-color: var(--lj-accent-line); background: var(--lj-glass-strong); box-shadow: 0 0 0 3px var(--lj-accent-soft); color: var(--lj-accent); }
.lj-search input { min-width: 0; width: 176px; border: 0; background: none; outline: 0 !important; padding: 0; font-size: 12.5px; color: var(--lj-text); }
.lj-search input::-webkit-search-cancel-button { -webkit-appearance: none; }

.lj-cards { display: flex; flex-direction: column; gap: 12px; }
.lj-card {
  position: relative; padding: 16px 18px 12px; border-radius: 17px;
  background: var(--lj-card-bg);
  border: 1px solid var(--lj-card-border);
  box-shadow: 0 1px 0 var(--lj-line) inset, var(--lj-card-shadow);
  transition: border-color .16s, background .16s, transform .16s, box-shadow .16s;
}
.lj-card:hover { border-color: var(--lj-line-strong); background: color-mix(in srgb, var(--lj-surface-2) 92%, transparent); box-shadow: 0 1px 0 var(--lj-line-strong) inset, 0 22px 46px -34px rgb(0 0 0 / .8); }
.lj-card .lj-quote { margin-top: 0; padding: 11px 12px 10px 13px; }
.lj-card .lj-quote blockquote { font-size: 13.5px; }
.lj-card-text { margin: 2px 0 4px; font-size: 15px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--lj-text); }
.lj-card .lj-quote + .lj-card-text { margin-top: 12px; }
.lj-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.lj-meta { display: inline-flex; align-items: center; gap: 5px; color: var(--lj-faint); font-size: 11.5px; }
.lj-card-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transform: translateY(1px); transition: opacity .15s; }
.lj-card:hover .lj-card-actions, .lj-card:focus-within .lj-card-actions { opacity: 1; }
.lj-card-actions .lj-quiet { color: var(--lj-muted); }
.lj-card-actions .lj-quiet:hover { color: var(--lj-accent); }
.lj-card-edit .lj-edit { width: 100%; min-height: 96px; border: 1px solid var(--lj-line-strong); border-radius: 11px; background: color-mix(in srgb, var(--lj-surface-2) 40%, transparent); padding: 10px 12px; resize: vertical; outline: 0 !important; }
.lj-card-edit .lj-edit:focus { border-color: var(--lj-accent-line); box-shadow: 0 0 0 3px var(--lj-accent-soft); }
.lj-card-edit .lj-tools { justify-content: flex-end; gap: 6px; margin-top: 8px; }
.lj-tools { display: flex; align-items: center; gap: 4px; }

.lj-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  min-height: 210px; padding: 34px 20px; text-align: center; color: var(--lj-faint); font-size: 13px;
  border: 1px dashed var(--lj-line-strong); border-radius: 17px; background: color-mix(in srgb, var(--lj-surface) 30%, transparent);
}
.lj-empty p { margin: 0; max-width: 360px; line-height: 1.75; }
.lj-empty > svg { color: var(--lj-faint); opacity: .8; }
.lj-empty .lj-ghost { margin-top: 4px; }
.lj-loading { min-height: 140px; }
.lj-page-foot { display: flex; align-items: center; justify-content: space-between; color: var(--lj-faint); padding-top: 26px; margin-top: 8px; border-top: 1px solid var(--lj-line); }
.lj-error { margin: 8px 16px; color: var(--dsw-alias-state-error-primary, #f25a5a); font-size: 12px; }

@keyframes lj-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes lj-pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (max-width: 720px) {
  .lj-page { padding-left: 18px; padding-right: 18px; }
  .lj-hero { flex-direction: column; }
  .lj-hero-actions { align-self: stretch; justify-content: space-between; }
  .lj-list-head { flex-wrap: wrap; }
  .lj-search { flex: 1; }
  .lj-search input { width: 100%; }
  .lj-float {
    left: 12px !important; right: 12px; top: auto !important; bottom: max(12px, env(safe-area-inset-bottom));
    width: auto !important; max-height: min(78dvh, 640px) !important; transform-origin: center bottom;
  }
  .lj-card-actions { opacity: 1; }
  .lj-float-sub { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .lj-float, .lj-selbar, .lj-toast { animation: none; }
}
`
    return { inject: ['slots', 'layout', 'sessions', 'uiConversation', 'uiWorkspace'], apply }
  },
})
