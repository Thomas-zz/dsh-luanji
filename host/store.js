/** Local records and immutable quotations. Changes publish only after a durable write. */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultDataDir() { return path.join(os.homedir(), '.dsh', 'luanji') }
const MAX_TEXT = 20000
const copy = (v) => structuredClone(v)
const text = (v, max = MAX_TEXT) => {
  const s = typeof v === 'string' ? v : ''
  if (s.length > max) throw new Error(`内容太长，请控制在 ${max} 字以内。`)
  return s
}
function images(value = []) {
  if (!Array.isArray(value) || value.length > 6) throw new Error('一条记录最多贴 6 张图。')
  return value.map((image) => {
    const data = String(image.data || '')
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 3 * 1024 * 1024) throw new Error('图片格式不支持或超过 2 MB，请缩小后重试。')
    return { id: text(image.id || randomUUID(), 100), data, name: text(image.name || '图片', 200) }
  })
}
function quote(value) {
  const raw = value?.origin || {}
  const anchor = value?.anchor || {}
  const original = text(value?.text)
  if (!original.trim()) throw new Error('引用内容为空。')
  return {
    id: text(value.id || randomUUID(), 150), text: original,
    origin: {
      role: ['user', 'assistant'].includes(raw.role) ? raw.role : 'unknown',
      model: text(raw.model, 300),
      sessionId: text(raw.sessionId, 300), sessionTitle: text(raw.sessionTitle, 500),
      messageId: text(String(raw.messageId || ''), 300), nodeKey: text(raw.nodeKey, 500),
      turn: Number.isFinite(raw.turn) ? raw.turn : null, seq: Number.isFinite(raw.seq) ? raw.seq : null,
    },
    anchor: { start: Number.isInteger(anchor.start) ? anchor.start : -1, end: Number.isInteger(anchor.end) ? anchor.end : -1, exact: text(anchor.exact || original), prefix: text(anchor.prefix, 100), suffix: text(anchor.suffix, 100) },
  }
}
function draft(value = {}) {
  return { text: text(value.text), images: images(value.images), quote: value.quote ? quote(value.quote) : null }
}
function record(value) {
  return {
    id: text(String(value.id || randomUUID()), 150), text: text(value.text),
    images: images(value.images), quoteId: text(value.quoteId, 150),
    source: ['agent', 'web', 'selection'].includes(value.source) ? value.source : 'ui',
    created_at: Number(value.created_at || value.createdAt) || Date.now(),
    updated_at: Number(value.updated_at || value.updatedAt || value.created_at) || Date.now(),
  }
}
function normalize(payload) {
  if (!payload || !Array.isArray(payload.records)) throw new Error('记录文件格式不正确。')
  const quotes = (payload.quotes || []).map(quote)
  const ids = new Set(quotes.map((q) => q.id))
  const records = payload.records.map(record)
  if (records.some((r) => r.quoteId && !ids.has(r.quoteId))) throw new Error('记录缺少对应的原始引用。')
  return { v: 2, records, quotes, draft: text(payload.draft), drafts: Object.fromEntries(Object.entries(payload.drafts || {}).map(([key, value]) => [key, draft(value)])) }
}
export function createStore(options = {}) {
  const dataDir = options.dataDir || defaultDataDir()
  const file = path.join(dataDir, 'notes.json')
  let data = { v: 2, records: [], quotes: [], draft: '', drafts: {} }
  let recovery = ''
  try { data = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  catch (error) {
    if (error.code !== 'ENOENT') {
      // Never replace an unreadable file with an empty notebook.
      throw new Error(`乱记数据无法读取，原文件已保留：${file}。可从 notes.json.bak 恢复。${error.message}`)
    }
  }
  let lastTs = Math.max(0, ...data.records.map((r) => r.updated_at))
  const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1))
  function commit(next) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = file + '.' + randomUUID() + '.tmp'
    let fd
    try {
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
      fs.renameSync(tmp, file)
      data = next
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    }
  }
  const project = (r) => ({ ...copy(r), quote: copy(data.quotes.find((q) => q.id === r.quoteId) || null) })
  const all = () => [...data.records].sort((a, b) => b.updated_at - a.updated_at).map(project)
  function collect(next) {
    const refs = new Set(next.records.map((r) => r.quoteId))
    next.quotes = next.quotes.filter((q) => refs.has(q.id))
  }
  return {
    get dataDir() { return dataDir }, get count() { return data.records.length },
    state() { return { schemaVersion: 2, records: all(), count: data.records.length, draft: data.draft, drafts: copy(data.drafts), recovery } },
    all, get(id) { const r = data.records.find((r) => r.id === String(id)); return r ? project(r) : null },
    add(value) {
      const id = value.id || randomUUID()
      const old = this.get(id)
      if (old) return old // idempotent retry after a lost HTTP response
      const q = value.quote ? quote(value.quote) : null
      const now = nextTs()
      const r = record({ ...value, id, text: text(value.text).trim(), quoteId: q?.id || '', created_at: now, updated_at: now })
      if (!r.text && !r.images.length && !q) throw new Error('纸上没有字，先写一下再放下。')
      const next = copy(data)
      if (q) { q.id = randomUUID(); r.quoteId = q.id; next.quotes.push(q) }
      next.records.push(r)
      if (value.draftKey) next.drafts[value.draftKey] = draft()
      if (value.draftKey === 'manage') next.draft = ''
      commit(next)
      return this.get(id)
    },
    update(id, value) {
      const next = copy(data)
      const r = next.records.find((r) => r.id === String(id))
      if (!r) throw new Error('这条记录已经不在了。')
      const patch = typeof value === 'string' ? { text: value } : value
      r.text = text(patch.text).trim()
      if (patch.images !== undefined) r.images = images(patch.images)
      if (!r.text && !r.images.length && !r.quoteId) throw new Error('纸上没有字，先写一下再放下。')
      r.updated_at = nextTs()
      commit(next); return this.get(id)
    },
    remove(id) {
      const removed = this.get(id)
      if (!removed) throw new Error('这条记录已经不在了。')
      const next = copy(data); next.records = next.records.filter((r) => r.id !== String(id)); collect(next)
      commit(next); return removed
    },
    saveDraft(value, key) {
      const next = copy(data)
      if (key) {
        if (!['quick', 'manage', 'quote'].includes(key)) throw new Error('未知草稿入口。')
        next.drafts[key] = draft(value)
      } else next.draft = text(value)
      commit(next); return key ? copy(next.drafts[key]) : next.draft
    },
    exportAll() { return { ...copy(data), exported_at: Date.now() } },
    importMany(payload) {
      const incoming = normalize(Array.isArray(payload) ? { records: payload } : payload)
      const next = copy(data)
      // Quotes are immutable: remap colliding external IDs instead of overwriting originals.
      const mapped = new Map()
      for (const q of incoming.quotes) {
        const existing = next.quotes.find((item) => item.id === q.id)
        if (existing && JSON.stringify(existing) !== JSON.stringify(q)) {
          const before = q.id; q.id = randomUUID(); mapped.set(before, q.id)
        }
        if (!next.quotes.some((item) => item.id === q.id)) next.quotes.push(q)
      }
      let added = 0, updated = 0
      for (const r of incoming.records) {
        if (mapped.has(r.quoteId)) r.quoteId = mapped.get(r.quoteId)
        if (!r.text.trim() && !r.images.length && !r.quoteId) continue
        const index = next.records.findIndex((item) => item.id === r.id)
        if (index < 0) { next.records.push(r); added++ }
        else if (r.updated_at > next.records[index].updated_at) { next.records[index] = r; updated++ }
      }
      if (added || updated) { collect(next); commit(next) }
      return { added, updated, count: data.records.length }
    },

    /**
     * 并入一个「乱记兼容」云端服务的快照（只做文本/图片；引用仍只在本机）。
     *
     * 云端正文里可能带 `〔图:id〕` 标记（乱记 Web 版的图片引用），这里把标记摘掉，
     * 并把云端图片作为记录图片附上。同 id 的记录只在云端 `updated_at` 更新时才覆盖，
     * 冲突不会删除本机引用或本机更晚的修改。
     *
     * @param {{records?: Array<object>, images?: Array<{id?: unknown, data?: unknown}>, draft?: unknown}} payload
     * @returns {{added: number, updated: number, skipped: number, images: number, draft: boolean}}
     */
    importRemote(payload) {
      const remoteRecords = Array.isArray(payload?.records) ? payload.records : []
      const imageMap = new Map()
      for (const raw of Array.isArray(payload?.images) ? payload.images : []) {
        const id = typeof raw?.id === 'string' ? raw.id : ''
        const data = typeof raw?.data === 'string' ? raw.data : ''
        if (!/^[a-z0-9]{4,16}$/.test(id) || imageMap.has(id)) continue
        if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 3 * 1024 * 1024) continue
        imageMap.set(id, { id, data, name: '云端图片' })
      }
      const next = copy(data)
      const now = Date.now()
      let added = 0, updated = 0, skipped = 0, maxTouched = 0
      for (const raw of remoteRecords) {
        const id = typeof raw?.id === 'string' ? raw.id.slice(0, 150) : ''
        if (!id) { skipped++; continue }
        const picked = []
        const body = (typeof raw?.text === 'string' ? raw.text : '').replace(/〔图:([a-z0-9]+)〕/g, (_, imageId) => {
          const image = imageMap.get(imageId)
          if (image && picked.length < 6 && !picked.some((item) => item.id === imageId)) picked.push(image)
          return ''
        }).trim()
        if (body.length > MAX_TEXT) { skipped++; continue }
        if (!body && !picked.length) { skipped++; continue }
        const createdAt = Number(raw?.created_at)
        const remoteUpdated = Number(raw?.updated_at)
        const created = Number.isFinite(createdAt) ? createdAt : now
        const touched = Number.isFinite(remoteUpdated) ? remoteUpdated : created
        const index = next.records.findIndex((item) => item.id === id)
        if (index >= 0) {
          const local = next.records[index]
          if (touched <= local.updated_at) { skipped++; continue }
          next.records[index] = { ...local, text: body, images: picked, updated_at: touched }
          updated++
        } else {
          next.records.push({ id, text: body, images: picked, quoteId: '', source: 'web', created_at: created, updated_at: touched })
          added++
        }
        maxTouched = Math.max(maxTouched, touched)
      }
      let draftChanged = false
      if (typeof payload?.draft === 'string' && payload.draft.trim() && !data.draft.trim()) {
        next.draft = text(payload.draft)
        draftChanged = true
      }
      if (added || updated || draftChanged) {
        collect(next)
        commit(next)
        if (maxTouched) lastTs = Math.max(lastTs, maxTouched)
      }
      return { added, updated, skipped, images: imageMap.size, draft: draftChanged }
    },

    /**
     * 导出可推到「乱记兼容」云端服务的纯文本记录。
     *
     * 云端数据模型只有正文（没有引用），所以带引用的记录留在本机，不推送；
     * 本机图片会生成短 id 并写成 `〔图:id〕` 标记，随正文一起上传。
     *
     * @returns {{records: Array<object>, images: Array<{id: string, data: string}>, skippedQuoted: number}}
     */
    exportForCloud() {
      const used = new Set()
      const imageIdOf = (image) => {
        let seed = String(image.id || image.data.slice(-32))
        for (let round = 0; round < 8; round++) {
          const id = createHash('sha256').update(seed).digest('hex').slice(0, 10)
          if (!used.has(id)) { used.add(id); return id }
          seed = id + ':' + round
        }
        const fallback = ('img' + used.size).padStart(10, '0').slice(0, 10)
        used.add(fallback)
        return fallback
      }
      const records = [], images = []
      let skippedQuoted = 0
      for (const record of [...data.records].sort((a, b) => a.created_at - b.created_at)) {
        if (record.quoteId) { skippedQuoted++; continue }
        let body = record.text.trim()
        if (!body && !record.images.length) continue
        const markers = []
        for (const image of record.images) {
          const id = imageIdOf(image)
          images.push({ id, data: image.data })
          markers.push(`〔图:${id}〕`)
        }
        if (markers.length) body = (body ? body + '\n\n' : '') + markers.join('')
        records.push({ id: record.id, text: body, source: 'dsh', created_at: record.created_at, updated_at: record.updated_at })
      }
      return { records, images, skippedQuoted }
    },
  }
}
