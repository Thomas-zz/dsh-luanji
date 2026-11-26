/**
 * Local records and immutable quotations. Changes publish only after a durable write.
 *
 * notes.json 格式 v3 = v2 + `sync` 同步元数据（见 docs/sync-protocol-v1.md）：
 *   { v:3, records[], quotes[], draft, drafts{}, sync{
 *       enabled, spaceId, generation, cursor, revs{}, pending[], conflicts[],
 *       held{}, idMap{}, missingBlobs{}, lastSyncAt, lastError, lastErrorAt } }
 *
 * 硬性约定：
 *  - 业务数据与同步状态（待提交操作、游标、确认版本）在同一次原子文件替换中提交；
 *  - 绑定过数据空间后删除走墓碑（UI 隐藏但保留记录），否则无法同步删除；
 *  - v2 升级前保留完整备份 notes.json.v2.bak，损坏文件永远不被空库覆盖；
 *  - 每条待提交操作冻结完整的本地快照（含图片数据），上传期间的新编辑排新操作。
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultDataDir() { return path.join(os.homedir(), '.dsh', 'luanji') }
const MAX_TEXT = 20000
const MAX_BLOB_BYTES = 2097152
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/
const HASH_RE = /^[0-9a-f]{64}$/
const copy = (v) => structuredClone(v)
const text = (v, max = MAX_TEXT) => {
  const s = typeof v === 'string' ? v : ''
  if (s.length > max) throw new Error(`内容太长，请控制在 ${max} 字以内。`)
  return s
}

/** 单写入 Host：数据目录锁，异常退出后可由本机新进程接管。 */
function acquireLock(dataDir) {
  const lockFile = path.join(dataDir, 'notes.json.lock')
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    const pid = Number(raw?.pid)
    if (Number.isInteger(pid) && pid !== process.pid) {
      process.kill(pid, 0) // 存活则抛错；不存在则可接管
      throw new Error(`另一个进程（PID ${pid}）正在使用乱记数据目录 ${dataDir}。请先退出它，或删除 ${lockFile}。`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.message?.includes?.('正在使用')) throw error
    // 锁文件损坏或进程已死：接管。
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }, null, 2), { mode: 0o600 })
}

function images(value = []) {
  if (!Array.isArray(value) || value.length > 6) throw new Error('一条记录最多贴 6 张图。')
  return value.map((image) => {
    const data = typeof image?.data === 'string' ? image.data : ''
    const hash = typeof image?.hash === 'string' ? image.hash : ''
    if (data) {
      if (!DATA_URL_RE.test(data) || data.length > 3 * 1024 * 1024) throw new Error('图片格式不支持或超过 2 MB，请缩小后重试。')
    } else if (!HASH_RE.test(hash)) {
      throw new Error('图片缺少内容或内容哈希。')
    }
    const mime = data ? data.slice(5, data.indexOf(';')) : (typeof image?.mime === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(image.mime) ? image.mime : 'application/octet-stream')
    const size = Number.isFinite(Number(image?.size)) && Number(image.size) > 0 ? Math.floor(Number(image.size)) : (data ? Math.floor((data.length - data.indexOf(',') - 1) * 3 / 4) : 0)
    return {
      id: text(image?.id || randomUUID(), 100),
      name: text(image?.name || '图片', 200),
      data,
      ...(HASH_RE.test(hash) ? { hash: hash.toLowerCase() } : {}),
      mime,
      size,
    }
  })
}

/** 附件指纹：本地图片 → 内容哈希（与云端 blobs 对齐）。 */
export function imageHash(image) {
  if (HASH_RE.test(String(image?.hash || ''))) return String(image.hash).toLowerCase()
  const base64 = String(image?.data || '').slice(String(image?.data || '').indexOf(',') + 1)
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
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
    source: ['agent', 'web', 'selection', 'dsh', 'ui'].includes(value.source) ? value.source : 'ui',
    created_at: Number(value.created_at || value.createdAt) || Date.now(),
    updated_at: Number(value.updated_at || value.updatedAt || value.created_at) || Date.now(),
    deleted_at: Number.isFinite(Number(value.deleted_at)) && value.deleted_at > 0 ? Math.floor(Number(value.deleted_at)) : null,
  }
}

/** 同步元数据的默认形状（首次绑定前 / 旧格式迁移时使用）。 */
function defaultSync() {
  return {
    enabled: false, spaceId: null, generation: null, cursor: 0,
    revs: {}, pending: [], conflicts: [], held: {}, idMap: {}, missingBlobs: {},
    lastSyncAt: null, lastError: '', lastErrorAt: null,
  }
}

/** 宽松但保序地清洗 sync 段：坏字段丢弃，不因个别字段毁掉整个待办队列。 */
function sanitizeSync(value) {
  const sync = defaultSync()
  if (!value || typeof value !== 'object') return sync
  sync.enabled = Boolean(value.enabled)
  sync.spaceId = typeof value.spaceId === 'string' && value.spaceId ? value.spaceId : null
  sync.generation = typeof value.generation === 'string' && value.generation ? value.generation : null
  sync.cursor = Number.isFinite(Number(value.cursor)) ? Math.max(0, Math.floor(Number(value.cursor))) : 0
  if (value.revs && typeof value.revs === 'object') {
    for (const [id, rev] of Object.entries(value.revs)) {
      if (typeof id === 'string' && Number.isFinite(Number(rev))) sync.revs[id] = Math.max(0, Math.floor(Number(rev)))
    }
  }
  if (Array.isArray(value.pending)) {
    sync.pending = value.pending.filter((op) => op && typeof op === 'object' && typeof op.recordId === 'string' && (op.kind === 'put' || op.kind === 'delete') && typeof op.opId === 'string')
      .map((op) => ({
        opId: op.opId, recordId: op.recordId, kind: op.kind,
        record: op.kind === 'put' ? record(op.record) : null,
        enqueuedAt: Number.isFinite(Number(op.enqueuedAt)) ? Number(op.enqueuedAt) : Date.now(),
      }))
  }
  if (Array.isArray(value.conflicts)) {
    sync.conflicts = value.conflicts.filter((c) => c && typeof c === 'object' && typeof c.recordId === 'string')
  }
  for (const key of ['held', 'idMap', 'missingBlobs']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) sync[key] = copy(value[key])
  }
  sync.lastSyncAt = Number.isFinite(Number(value.lastSyncAt)) ? Number(value.lastSyncAt) : null
  sync.lastError = typeof value.lastError === 'string' ? value.lastError.slice(0, 500) : ''
  sync.lastErrorAt = Number.isFinite(Number(value.lastErrorAt)) ? Number(value.lastErrorAt) : null
  return sync
}

function normalize(payload) {
  if (!payload || !Array.isArray(payload.records)) throw new Error('记录文件格式不正确。')
  const quotes = (payload.quotes || []).map(quote)
  const ids = new Set(quotes.map((q) => q.id))
  const records = payload.records.map(record)
  if (records.some((r) => r.quoteId && !ids.has(r.quoteId))) throw new Error('记录缺少对应的原始引用。')
  return {
    v: 3, records, quotes,
    draft: text(payload.draft),
    drafts: Object.fromEntries(Object.entries(payload.drafts || {}).map(([key, value]) => [key, draft(value)])),
    sync: sanitizeSync(payload.sync),
  }
}

/** 本地记录 → 协议 wire 记录（attachments 按内容哈希）。 */
function toWire(r, quoteValue) {
  return {
    id: r.id, text: r.text, source: r.source,
    created_at: r.created_at, updated_at: r.updated_at,
    quote: quoteValue || null,
    attachments: r.images.map((image) => ({ id: image.id, hash: imageHash(image), mime: image.mime || 'application/octet-stream', size: image.size, name: image.name })),
    deleted_at: r.deleted_at ?? null,
  }
}

/** 递归按键名排序的稳定序列化（内容比较与键顺序无关）。 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 规范化业务内容比较（首合并去重用）：排除 rev/同步状态与 updated_at，
 * 引用与附件按内容比对，与字段顺序无关。
 */
export function sameBusinessContent(a, b) {
  const strip = (record) => {
    const copy = { ...record }
    delete copy.rev
    delete copy.updated_at
    return copy
  }
  return stableStringify(strip(a)) === stableStringify(strip(b))
}

export function createStore(options = {}) {
  const dataDir = options.dataDir || defaultDataDir()
  const file = path.join(dataDir, 'notes.json')
  acquireLock(dataDir)
  const releaseLock = () => { try { fs.unlinkSync(path.join(dataDir, 'notes.json.lock')) } catch { /* 已被接管 */ } }
  process.once('exit', releaseLock)

  let data = { v: 3, records: [], quotes: [], draft: '', drafts: {}, sync: defaultSync() }
  let migratedFromV2 = false
  let recovery = ''
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.v === undefined || parsed.v < 3)) migratedFromV2 = true
    data = normalize(parsed)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Never replace an unreadable file with an empty notebook.
      throw new Error(`乱记数据无法读取，原文件已保留：${file}。可从 notes.json.bak 恢复。${error.message}`)
    }
  }
  let lastTs = Math.max(0, ...data.records.map((r) => r.updated_at))
  const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1))
  /** 引擎应用远端/合并期间不排队新操作。 */
  let applyingRemote = false
  const bound = () => Boolean(data.sync.spaceId)

  function commit(next) {
    fs.mkdirSync(dataDir, { recursive: true })
    if (migratedFromV2) {
      // 新格式迁移前保留完整 v2 备份（只写一次）。
      const backup = file + '.v2.bak'
      if (!fs.existsSync(backup) && fs.existsSync(file)) fs.copyFileSync(file, backup)
      migratedFromV2 = false
    }
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
  const visible = () => data.records.filter((r) => !r.deleted_at)
  const all = () => [...visible()].sort((a, b) => b.updated_at - a.updated_at).map(project)
  function collect(next) {
    // 墓碑仍要保留其引用（否则无法同步带引用的删除）。
    const refs = new Set(next.records.map((r) => r.quoteId))
    next.quotes = next.quotes.filter((q) => refs.has(q.id))
  }

  /** 绑定后为一次本地变更排队冻结操作（与业务写入同一事务）。 */
  function enqueueOp(next, kind, record) {
    if (!bound() || applyingRemote) return
    next.sync.pending.push({
      opId: randomUUID(), recordId: record.id, kind,
      record: kind === 'put' ? copy(record) : null,
      enqueuedAt: Date.now(),
    })
  }

  return {
    get dataDir() { return dataDir }, get count() { return visible().length },
    state() { return { schemaVersion: 3, records: all(), count: visible().length, draft: data.draft, drafts: copy(data.drafts), recovery } },
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
      enqueueOp(next, 'put', r)
      commit(next)
      return this.get(id)
    },
    update(id, value) {
      const next = copy(data)
      const r = next.records.find((r) => r.id === String(id))
      if (!r || r.deleted_at) throw new Error('这条记录已经不在了。')
      const patch = typeof value === 'string' ? { text: value } : value
      r.text = text(patch.text).trim()
      if (patch.images !== undefined) r.images = images(patch.images)
      if (!r.text && !r.images.length && !r.quoteId) throw new Error('纸上没有字，先写一下再放下。')
      r.updated_at = nextTs()
      enqueueOp(next, 'put', r)
      commit(next); return this.get(id)
    },
    remove(id) {
      const removed = this.get(id)
      if (!removed || removed.deleted_at) throw new Error('这条记录已经不在了。')
      const next = copy(data)
      const r = next.records.find((item) => item.id === String(id))
      if (bound()) {
        // 墓碑 + 删除操作：UI 隐藏，但内容保留到删除确认同步完成。
        r.deleted_at = nextTs()
        enqueueOp(next, 'delete', r)
      } else {
        next.records = next.records.filter((item) => item.id !== String(id)); collect(next)
      }
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
    exportAll() {
      // 普通导出 = 完整业务数据与附件，不带设备凭据、游标与在途操作（A15）。
      const next = copy(data)
      next.records = next.records.filter((r) => !r.deleted_at)
      collect(next)
      delete next.sync
      return { ...next, exported_at: Date.now() }
    },
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
        else if (next.records[index].deleted_at) continue // 不复活墓碑（删除已排队的记录）
        else if (r.updated_at > next.records[index].updated_at) { next.records[index] = r; updated++ }
      }
      if (added || updated) { collect(next); commit(next) }
      return { added, updated, count: this.count }
    },

    // ── 同步引擎专用：所有方法与业务写入共用同一个原子 commit ──────────

    /** 同步状态快照（引擎与状态接口用；不含任何凭据）。 */
    syncSnapshot() { return copy(data.sync) },

    /** 绑定过数据空间（无论开关）：删除都会走墓碑、编辑都会排队。 */
    syncBound() { return bound() },

    /** 测试连接等只读展示用。 */
    syncSummary() {
      const sync = data.sync
      return {
        bound: bound(), enabled: Boolean(sync.enabled && bound()),
        spaceId: sync.spaceId, generation: sync.generation,
        pendingOps: sync.pending.length,
        conflicts: sync.conflicts.length,
        missingBlobs: Object.keys(sync.missingBlobs).length,
        lastSyncAt: sync.lastSyncAt, lastError: sync.lastError, lastErrorAt: sync.lastErrorAt,
      }
    },

    /** 引擎内部：远端应用 / 合并期间抑制操作入队。 */
    beginRemoteApply() { applyingRemote = true },
    endRemoteApply() { applyingRemote = false },

    /** 首次合并前的本地完整备份。 */
    backupPreMerge() {
      if (!fs.existsSync(file)) return ''
      const target = file + '.pre-merge.bak'
      fs.copyFileSync(file, target)
      return target
    },

    /**
     * 首次合并（或更换服务 / generation 变化后的重新合并）。
     * 一次原子提交完成：去重、远端落地、本地副本换新 ID、冲突入面板、排队本地未发布内容。
     *
     * @param {{remoteRecords: object[], spaceId: string, generation: string, cursor: number, deviceName?: string, remerge?: boolean}} input
     * @returns {{deduped: number, copied: number, remoteAdded: number, deleteConflicts: number, conflicts: number, queued: number}}
     */
    mergeFirstSync(input) {
      const next = copy(data)
      const sync = next.sync
      const summary = { deduped: 0, copied: 0, remoteAdded: 0, deleteConflicts: 0, conflicts: 0, queued: 0 }
      applyingRemote = true
      try {
        const byId = new Map(next.records.map((r) => [r.id, r]))
        const pendingById = new Map(sync.pending.map((op) => [op.recordId, op]))
        const remoteIds = new Set()

        for (const wire of input.remoteRecords) {
          remoteIds.add(wire.id)
          const local = byId.get(wire.id)
          const pendingOp = pendingById.get(wire.id)
          if (pendingOp && pendingOp.kind === 'put') {
            const frozen = toWire(pendingOp.record, next.quotes.find((q) => q.id === pendingOp.record.quoteId))
            if (sameBusinessContent(frozen, wire)) {
              // 远端已包含这次未提交的内容：直接确认，去掉重复操作。
              sync.pending = sync.pending.filter((op) => op.recordId !== wire.id)
              applyWireToState(next, wire)
              summary.deduped++
            } else {
              sync.conflicts.push(makeConflict(wire, { kind: 'put', record: pendingOp.record }, input.deviceName))
              sync.pending = sync.pending.filter((op) => op.recordId !== wire.id)
              summary.conflicts++
            }
            continue
          }
          if (pendingOp && pendingOp.kind === 'delete') {
            if (wire.deleted_at) {
              // 双方都删了：直接确认删除。
              sync.pending = sync.pending.filter((op) => op.recordId !== wire.id)
              applyWireToState(next, wire)
            } else {
              sync.conflicts.push(makeConflict(wire, { kind: 'delete', record: byId.get(wire.id) || pendingOp.record }, input.deviceName))
              sync.pending = sync.pending.filter((op) => op.recordId !== wire.id)
              summary.deleteConflicts++
            }
            continue
          }
          if (!local) {
            applyWireToState(next, wire)
            summary.remoteAdded++
            continue
          }
          const localWire = toWire(local, next.quotes.find((q) => q.id === local.quoteId))
          const hadBaseline = sync.revs[wire.id] !== undefined
          if (sameBusinessContent(localWire, wire)) {
            applyWireToState(next, wire)
            summary.deduped++
            continue
          }
          if (local.deleted_at && !wire.deleted_at) {
            // 本地从未同步的删除 vs 远端内容：删除冲突。
            sync.conflicts.push(makeConflict(wire, { kind: 'delete', record: local }, input.deviceName))
            summary.deleteConflicts++
            continue
          }
          if (!hadBaseline && !input.remerge) {
            // 首合并、无共同基线：远端保留原 ID，本地版本复制成新 UUID（映射持久化，重跑不重复）。
            const newId = sync.idMap[wire.id]?.newId || randomUUID()
            const copyRecord = copy(local)
            copyRecord.id = newId
            copyRecord.created_at = local.created_at
            next.records.push(copyRecord)
            sync.idMap[wire.id] = { newId, at: Date.now(), from: input.deviceName || '' }
            applyWireToState(next, wire)
            summary.copied++
            continue
          }
          // 有基线但内容不同（重新合并 / 既有历史）：冲突面板。
          sync.conflicts.push(makeConflict(wire, { kind: 'put', record: local }, input.deviceName))
          summary.conflicts++
        }

        // 本地未发布内容排队上传（含从未同步的墓碑删除）。
        for (const local of next.records) {
          if (remoteIds.has(local.id)) continue
          if (pendingById.has(local.id)) continue
          if (local.deleted_at) {
            sync.pending.push({ opId: randomUUID(), recordId: local.id, kind: 'delete', record: null, enqueuedAt: Date.now() })
          } else {
            if (local.text.trim() || local.images.length || local.quoteId) {
              sync.pending.push({ opId: randomUUID(), recordId: local.id, kind: 'put', record: copy(local), enqueuedAt: Date.now() })
            }
          }
          summary.queued++
        }

        sync.enabled = true
        sync.spaceId = input.spaceId
        sync.generation = input.generation
        sync.cursor = input.cursor
        sync.lastError = ''
        sync.lastErrorAt = null
        collect(next)
        commit(next)
        return summary
      } finally { applyingRemote = false }
    },

    /**
     * 应用一页远端变更并推进游标（同一次原子提交）。
     * 有本地待上传修改的记录暂存远端版本（held），不静默覆盖。
     *
     * @param {Array<{seq:number, rev:number, record:object}>} changes
     * @param {number} nextCursor
     */
    applyRemotePage(changes, nextCursor) {
      const next = copy(data)
      const sync = next.sync
      const pendingIds = new Set(sync.pending.map((op) => op.recordId))
      const conflictedIds = new Set(sync.conflicts.map((c) => c.recordId))
      for (const change of changes) {
        const wire = change.record
        if (!wire || typeof wire.id !== 'string') continue
        if (pendingIds.has(wire.id) || conflictedIds.has(wire.id)) {
          // 未上传的本地修改不允许被拉取静默覆盖：暂存最新远端版本。
          sync.held[wire.id] = { rev: change.rev, record: copy(wire), at: Date.now() }
          continue
        }
        applyWireToState(next, wire)
        sync.revs[wire.id] = change.rev
        delete sync.held[wire.id]
      }
      sync.cursor = nextCursor
      commit(next)
    },

    /**
     * 确认一个操作：移出队列并记录新 rev。
     * @param {{opId: string, recordId: string}} op
     * @param {{rev?: number}} [result]
     */
    confirmOp(op, result = {}) {
      const next = copy(data)
      next.sync.pending = next.sync.pending.filter((item) => item.opId !== op.opId)
      if (Number.isFinite(Number(result.rev)) && result.rev > 0) next.sync.revs[op.recordId] = Math.floor(Number(result.rev))
      delete next.sync.held[op.recordId]
      commit(next)
    },

    /**
     * 上传与远端冲突：把该记录的操作转入冲突面板。
     * @param {{recordId: string, kind: 'put'|'delete', record: object|null}} local
     * @param {{rev: number, record: object}} remote
     * @param {string} [deviceName]
     */
    recordConflict(local, remote, deviceName = '') {
      const next = copy(data)
      next.sync.pending = next.sync.pending.filter((op) => op.recordId !== local.recordId)
      next.sync.conflicts = next.sync.conflicts.filter((c) => c.recordId !== local.recordId)
      next.sync.conflicts.push(makeConflict(remote.record, local, deviceName, remote.rev))
      delete next.sync.held[local.recordId]
      commit(next)
    },

    /**
     * 冲突面板三选一。
     * @param {string} recordId
     * @param {'local'|'remote'|'both'} choice
     * @param {string} [deviceName]
     */
    resolveConflict(recordId, choice, deviceName = '') {
      const sync = data.sync
      const conflict = sync.conflicts.find((c) => c.recordId === recordId)
      if (!conflict) throw new Error('没有这条冲突。')
      const next = copy(data)
      const target = next.sync.conflicts.find((c) => c.recordId === recordId)
      const remoteWire = target.remote.record
      if (choice === 'remote') {
        applyWireToState(next, remoteWire)
        next.sync.revs[recordId] = target.remote.rev
      } else if (choice === 'local') {
        // 保留本机：以远端 rev 为新基线，重发本地内容（删除冲突则重发删除）。
        next.sync.revs[recordId] = target.remote.rev
        const local = target.local
        next.sync.pending.push({
          opId: randomUUID(), recordId,
          kind: local.kind,
          record: local.kind === 'put' ? copy(local.record) : null,
          enqueuedAt: Date.now(),
        })
      } else {
        // 保留两份：远端内容落地原 ID；本地版本（含被删除前的内容）另存新记录并上传。
        applyWireToState(next, remoteWire)
        next.sync.revs[recordId] = target.remote.rev
        const local = target.local
        const copyRecord = record(local.record || { text: '' })
        copyRecord.id = randomUUID()
        copyRecord.deleted_at = null
        copyRecord.created_at = Date.now()
        copyRecord.updated_at = Date.now()
        next.records.push(copyRecord)
        if (copyRecord.quoteId && !next.quotes.some((q) => q.id === copyRecord.quoteId)) {
          // 删除冲突场景里引用仍应随副本保留。
          const original = data.quotes.find((q) => q.id === copyRecord.quoteId)
          if (original) next.quotes.push(copy(original))
        }
        next.sync.pending.push({ opId: randomUUID(), recordId: copyRecord.id, kind: 'put', record: copy(copyRecord), enqueuedAt: Date.now() })
      }
      next.sync.conflicts = next.sync.conflicts.filter((c) => c.recordId !== recordId)
      delete next.sync.held[recordId]
      void deviceName
      collect(next)
      commit(next)
      return true
    },

    /** 冲突列表（面板展示，含双方内容）。 */
    conflicts() { return copy(data.sync.conflicts) },
    conflictHeld(recordId) { return copy(data.sync.held[recordId] || null) },

    /** 引擎写入服务身份（重新合并后 generation 变化时）。 */
    updateSpaceIdentity({ spaceId, generation }) {
      const next = copy(data)
      next.sync.spaceId = spaceId
      next.sync.generation = generation
      commit(next)
    },

    /**
     * 更换服务或数据空间 = 新连接：清掉旧空间的版本与游标、重新预览合并；
     * 未同步的待办操作、ID 映射与待下载附件全部保留（未同步内容保留）。
     */
    rebindForNewSpace() {
      const next = copy(data)
      next.sync.revs = {}
      next.sync.cursor = 0
      next.sync.held = {}
      next.sync.conflicts = []
      commit(next)
    },

    /** 关闭同步：停止标记，绑定、游标、待办全部保留。 */
    setSyncEnabled(enabled) {
      const next = copy(data)
      next.sync.enabled = Boolean(enabled)
      commit(next)
    },

    /** 更新同步展示状态（最近成功/错误）。 */
    setSyncStatus({ lastSyncAt, lastError }) {
      const next = copy(data)
      if (lastSyncAt !== undefined) next.sync.lastSyncAt = lastSyncAt
      if (lastError !== undefined) {
        next.sync.lastError = String(lastError || '').slice(0, 500)
        next.sync.lastErrorAt = lastError ? Date.now() : null
      }
      commit(next)
    },

    /**
     * 附件数据回填（下载完成后）。失败时保留待下载标记。
     * @param {string} hash
     * @param {string} dataUrl - data:image/...;base64,...
     */
    fillBlobData(hash, dataUrl) {
      if (!HASH_RE.test(hash) || !DATA_URL_RE.test(dataUrl)) throw new Error('附件内容格式不正确。')
      const next = copy(data)
      let touched = false
      for (const r of next.records) {
        for (const image of r.images) {
          if (!image.data && (image.hash === hash || imageHash(image) === hash)) {
            image.data = dataUrl
            image.mime = dataUrl.slice(5, dataUrl.indexOf(';'))
            touched = true
          }
        }
      }
      if (next.sync.missingBlobs[hash]) { delete next.sync.missingBlobs[hash]; touched = true }
      if (touched) commit(next)
      return touched
    },

    /** 待下载附件清单（含记录引用信息）。 */
    missingBlobs() { return copy(data.sync.missingBlobs) },

    /** 本地记录转 wire（引擎上传用）。 */
    toWireRecord(id) {
      const r = data.records.find((item) => item.id === String(id))
      if (!r) return null
      return toWire(r, data.quotes.find((q) => q.id === r.quoteId) || null)
    },

    /** 冻结的操作快照（本地格式）转 wire；引用不可变，从库里取。 */
    opToWire(record) {
      return toWire(record, data.quotes.find((q) => q.id === record.quoteId) || null)
    },

    /**
     * 并入一个「乱记兼容」云端服务的快照（只做文本/图片；引用仍只在本机）。
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
        if (!DATA_URL_RE.test(data) || data.length > 3 * 1024 * 1024) continue
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
          if (local.deleted_at || touched <= local.updated_at) { skipped++; continue }
          next.records[index] = { ...local, text: body, images: picked, updated_at: touched }
          updated++
        } else {
          next.records.push({ id, text: body, images: picked, quoteId: '', source: 'web', created_at: created, updated_at: touched, deleted_at: null })
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
      for (const record of [...visible()].sort((a, b) => a.created_at - b.created_at)) {
        if (record.quoteId) { skippedQuoted++; continue }
        let body = record.text.trim()
        if (!body && !record.images.length) continue
        const markers = []
        for (const image of record.images) {
          if (!image.data) continue
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

  /** 冲突条目（持久保存双方与远端 rev，即便游标继续前进也不丢）。local.record 保持本地格式。 */
  function makeConflict(remoteWire, local, deviceName, rev) {
    return {
      recordId: remoteWire.id,
      at: Date.now(),
      remote: { rev: rev ?? remoteWire.rev ?? 0, record: copy(remoteWire) },
      local: { kind: local.kind, record: local.record ? copy(local.record) : null },
      note: deviceName ? `来自 ${deviceName}` : '',
    }
  }

  /** wire 记录落地：含墓碑、引用插入；附件优先复用本地已有数据，缺的登记待下载。 */
  function applyWireToState(next, wire) {
    const previous = next.records.find((item) => item.id === wire.id)
    const attachments = Array.isArray(wire.attachments) ? wire.attachments : []
    const images = attachments.map((a) => {
      const known = previous?.images.find((im) => im.hash === a.hash && im.data) || null
      return {
        id: String(a.id || randomUUID()), name: String(a.name || '图片'),
        data: known ? known.data : '',
        hash: String(a.hash || '').toLowerCase(),
        mime: String(a.mime || (known ? known.mime : 'application/octet-stream')),
        size: Number(a.size) || (known ? known.size : 0),
      }
    })
    const r = {
      id: wire.id,
      text: typeof wire.text === 'string' ? wire.text : '',
      images,
      quoteId: '',
      source: ['agent', 'web', 'selection', 'dsh', 'ui'].includes(wire.source) ? wire.source : 'ui',
      created_at: Number(wire.created_at) || Date.now(),
      updated_at: Number(wire.updated_at) || Date.now(),
      deleted_at: Number(wire.deleted_at) > 0 ? Number(wire.deleted_at) : null,
    }
    if (wire.quote && typeof wire.quote === 'object') {
      const q = quote(wire.quote)
      const existing = next.quotes.find((item) => item.id === q.id)
      if (!existing) next.quotes.push(q)
      r.quoteId = existing ? existing.id : q.id
    }
    const index = next.records.findIndex((item) => item.id === wire.id)
    if (index >= 0) next.records[index] = r
    else next.records.push(r)
    if (Number(wire.rev) > 0) next.sync.revs[wire.id] = Math.floor(Number(wire.rev))
    // 缺数据的附件进入明确的待下载状态（保留元信息，可重试）。
    for (const image of r.images) {
      if (!image.data && HASH_RE.test(image.hash)) {
        next.sync.missingBlobs[image.hash] = { recordId: r.id, mime: image.mime, name: image.name, at: Date.now() }
      }
    }
  }
}

export { MAX_TEXT, MAX_BLOB_BYTES }
