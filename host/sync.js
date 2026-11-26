/**
 * 新版 v1 同步引擎：单设备单同步循环，不用 WebSocket。
 *
 * 触发：本地保存后 2 秒防抖、开启期间每 30 秒、手动「立即同步」、启动时。
 * 失败从 5 秒指数退避到最多 5 分钟（带抖动）；认证失败/空间变化/配额满等
 * 需要用户介入的错误立即停表，不无限高频重试。
 *
 * 上传使用冻结的操作快照（含图片数据），请求期间的新编辑排为新操作；
 * 网络不确定时始终重试原 opId 与原请求体。拉取按服务端单调 seq 分页，
 * 变更与游标同一次本地原子提交；附件先传内容、后提交引用，下载失败保留
 * 明确的待处理状态可重试。
 *
 * @module dsh-luanji/host/sync
 */

import { createHash } from 'node:crypto'
import { readSyncConfig, validateSyncUrl, writeSyncConfig } from './sync-config.js'

const PROTOCOL = '1'
const DEBOUNCE_MS = 2000
const INTERVAL_MS = 30000
const BACKOFF_BASE_MS = 5000
const BACKOFF_MAX_MS = 300000
const REQUEST_TIMEOUT_MS = 20000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const PAGE_LIMIT = 100

/** 需要用户介入、停止自动重试的错误类别。 */
const ATTENTION_CODES = new Set(['UNAUTHORIZED', 'SPACE_CHANGED', 'QUOTA_EXCEEDED', 'PROTOCOL_UNSUPPORTED', 'OP_BODY_MISMATCH', 'LOCAL_BLOB_MISSING'])

/**
 * 组装同步引擎。
 *
 * @param {object} options
 * @param {object} options.store - host/store.js 实例。
 * @param {(() => void)} [options.onChange] - 状态变化通知（可选，供界面刷新）。
 */
export function createSyncService({ store, onChange }) {
  let chain = Promise.resolve()
  let cycleActive = false
  let debounceTimer = null
  let intervalTimer = null
  let currentAbort = null
  let consecutiveFailures = 0
  let nextAttemptAt = 0
  let attention = null // {code, message}
  let disposed = false
  const notify = () => { try { onChange?.() } catch { /* 界面回调失败不影响同步 */ } }

  // ── HTTP ─────────────────────────────────────────────
  /** 带超时与固定头的 JSON 请求；HTTP 错误不抛，返回 {status, data}。 */
  async function requestJson(config, pathname, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const onOuterAbort = () => controller.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await fetch(config.url + pathname, {
        method,
        redirect: 'error', // 不跟随跨源重定向
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          'x-luanji-protocol': PROTOCOL,
          connection: 'close',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const raw = await response.text()
      if (raw.length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('同步服务响应过大，已拒绝读取。'), { network: true })
      let data
      try { data = JSON.parse(raw) } catch { data = { ok: false, code: 'PROTOCOL_UNSUPPORTED', error: `同步服务返回的不是 JSON（HTTP ${response.status}）。` } }
      return { status: response.status, data }
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('同步已停止。'), { aborted: true })
      throw classifyTransportError(error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  /** 把 fetch 传输层异常翻译成可展示的错误类别。 */
  function classifyTransportError(error) {
    if (error?.aborted) return error
    const code = error?.cause?.code || error?.code || ''
    if (/(CERT|SSL|TLS)/.test(code)) {
      return Object.assign(new Error(`同步服务证书校验失败（${code}）。请检查服务地址与证书配置。`), { kind: 'cert' })
    }
    return Object.assign(new Error('无法连接同步服务：地址不可达或网络不可用。'), { kind: 'network' })
  }

  async function fetchInfo(config, signal) {
    const res = await requestJson(config, '/api/sync/v1/info', { signal })
    if (res.status === 401) throw Object.assign(new Error('认证失败：访问密钥不正确或已被撤销。'), { kind: 'auth' })
    if (res.status === 501 || res.data?.code === 'PROTOCOL_UNSUPPORTED') throw Object.assign(new Error('协议不兼容：服务与插件支持的同步协议版本不一致。'), { kind: 'protocol' })
    if (res.status !== 200 || !res.data?.ok) throw Object.assign(new Error(`同步服务返回异常（HTTP ${res.status}）。`), { kind: 'http' })
    if (res.data.protocolVersion !== 1) throw Object.assign(new Error('协议不兼容：服务支持的协议版本与插件不一致。'), { kind: 'protocol' })
    return res.data
  }

  // ── 对外：测试连接（只读，不上传） ────────────────────
  /**
   * 测试连接：只调用 GET /info，检查认证、协议版本与稳定空间身份。
   * @param {{url?: string, token?: string}} [override] - 表单里输入但尚未保存的配置。
   */
  async function testConnection(override) {
    const saved = readSyncConfig(store.dataDir)
    const url = override?.url || saved?.url || ''
    const token = override?.token || saved?.token || ''
    const check = validateSyncUrl(url)
    if (check.error) return { ok: false, kind: 'config', error: check.error }
    if (!token) return { ok: false, kind: 'config', error: '请填写访问密钥。' }
    const config = { url: check.url, token }
    try {
      const info = await fetchInfo(config)
      return {
        ok: true, host: check.host, protocolVersion: info.protocolVersion,
        spaceId: info.spaceId, generation: info.generation,
        activeCount: info.activeCount, localCount: store.count, limits: info.limits,
      }
    } catch (error) {
      const kind = error?.kind === 'auth' ? 'auth' : error?.kind === 'protocol' ? 'protocol' : error?.kind === 'cert' ? 'cert' : error?.kind === 'http' ? 'http' : 'network'
      return { ok: false, kind, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── 对外：启用（首次合并） ───────────────────────────
  /**
   * 启用同步并合并：保存配置 → 备份本地 → 拉取有界远端快照 → 计算合并 →
   * 开启循环并立刻跑一轮（上传本地未发布内容、下载附件）。
   *
   * @param {{url: string, token?: string, deviceName: string}} input
   */
  async function enable(input) {
    const config = writeSyncConfig(store.dataDir, input)
    const info = await fetchInfo(config)
    const snapshot = store.syncSnapshot()
    const switchingSpace = Boolean(snapshot.spaceId && snapshot.spaceId !== info.spaceId)
    // 修改服务或数据空间 = 新连接：重新预览合并，不沿用旧游标（未同步内容保留）。
    if (switchingSpace) store.rebindForNewSpace()
    // 首次合并前生成本地完整快照。
    store.backupPreMerge()
    const pulled = await pullAllRecords(config, info, null)
    const summary = store.mergeFirstSync({
      remoteRecords: pulled.records,
      spaceId: info.spaceId,
      generation: info.generation,
      cursor: pulled.upperBound,
      deviceName: config.deviceName,
    })
    attention = null
    consecutiveFailures = 0
    nextAttemptAt = 0
    startLoop()
    await scheduleCycle()
    return { summary, info }
  }

  /** 完整拉取远端当前状态（变更日志重放，取每个 id 的最新版本）。 */
  async function pullAllRecords(config, info, signal) {
    const byId = new Map()
    let cursor = 0
    let upperBound = null
    for (let guard = 0; guard < 10000; guard++) {
      const query = `/api/sync/v1/changes?cursor=${cursor}&limit=${PAGE_LIMIT}`
        + (upperBound === null ? '' : `&upperBound=${upperBound}`)
        + `&spaceId=${encodeURIComponent(info.spaceId)}&generation=${encodeURIComponent(info.generation)}`
      const res = await requestJson(config, query, { signal })
      if (res.status === 401) throw Object.assign(new Error('认证失败：访问密钥不正确或已被撤销。'), { kind: 'auth' })
      if (res.status === 409 && res.data?.code === 'SPACE_CHANGED') throw Object.assign(new Error('服务数据空间已变化，请重新执行合并。'), { kind: 'space' })
      if (res.status !== 200 || !res.data?.ok) throw Object.assign(new Error(`拉取远端数据失败（HTTP ${res.status}）。`), { kind: 'http' })
      const page = res.data
      if (page.spaceId !== info.spaceId || page.generation !== info.generation) {
        throw Object.assign(new Error('服务数据空间已变化，请重新执行合并。'), { kind: 'space' })
      }
      upperBound = page.upperBound
      for (const change of page.changes) byId.set(change.id, { ...change.record, rev: change.rev })
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    return { records: [...byId.values()], upperBound }
  }

  // ── 循环 ─────────────────────────────────────────────
  function startLoop() {
    if (disposed || intervalTimer) return
    intervalTimer = setInterval(() => {
      const snapshot = store.syncSnapshot()
      if (!snapshot.enabled) return
      if (attention) return
      if (Date.now() < nextAttemptAt) return
      void scheduleCycle()
    }, INTERVAL_MS)
    intervalTimer.unref?.()
  }

  function stopLoop() {
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    currentAbort?.abort()
  }

  /** 本地保存后短暂防抖触发同步。 */
  function notifyLocalChange() {
    const snapshot = store.syncSnapshot()
    if (!snapshot.enabled || attention || disposed) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; void scheduleCycle() }, DEBOUNCE_MS)
    debounceTimer.unref?.()
    startLoop()
  }

  /**
   * 串行调度一轮同步：单设备单同步循环，多次触发只排队不并行。
   * 返回的 promise 在本轮（含之前排队的轮次）结束后兑现。
   */
  function scheduleCycle() {
    chain = chain.then(async () => {
      if (disposed || cycleActive) return
      cycleActive = true
      currentAbort = new AbortController()
      try {
        await cycleInner(currentAbort.signal)
        if (!attention) { consecutiveFailures = 0; nextAttemptAt = 0 }
      } catch (error) {
        if (!error?.aborted && !disposed) handleCycleError(error)
      } finally {
        cycleActive = false
        currentAbort = null
        notify()
      }
    })
    return chain
  }

  async function cycleInner(signal) {
    const snapshot = store.syncSnapshot()
    if (!snapshot.enabled || !snapshot.spaceId) return
    const config = readSyncConfig(store.dataDir)
    if (!config?.hasToken) {
      attention = { code: 'UNAUTHORIZED', message: '同步已开启但缺少访问密钥，请到同步设置里补齐。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    notify()

    // ① 身份检查：spaceId/generation 变化说明服务重建或恢复，停表等重新合并。
    const info = await fetchInfo(config, signal)
    const fresh = store.syncSnapshot()
    if (info.spaceId !== fresh.spaceId || info.generation !== fresh.generation) {
      attention = { code: 'SPACE_CHANGED', message: '同步服务的空间身份已变化（重建或从备份恢复）。请到同步设置里重新合并，增量同步已暂停。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }

    // ② 上传待办（冻结快照；串行、FIFO）。
    await uploadPending(config, signal)
    if (attention) return

    // ③ 拉取远端变更（分页 + 原子推进游标）。
    await pullChanges(config, signal)
    if (attention) return

    // ④ 下载缺失附件。
    await downloadBlobs(config, signal)
    if (attention) return

    store.setSyncStatus({ lastSyncAt: Date.now(), lastError: '' })
    attention = null
  }

  async function uploadPending(config, signal) {
    for (let guard = 0; guard < 500; guard++) {
      const snapshot = store.syncSnapshot()
      const op = snapshot.pending[0]
      if (!op) return
      const baseRev = snapshot.revs[op.recordId] ?? 0
      let response
      if (op.kind === 'put') {
        const wire = store.opToWire(op.record)
        // 附件成功后再提交引用：先按内容哈希上传（幂等）。
        for (const attachment of wire.attachments) {
          const image = op.record.images.find((item) => item.data && hashOf(item) === attachment.hash)
          if (!image) {
            // 本地缺内容（如待下载的远端图被再次编辑）：登记待处理并跳过整个提交。
            store.setSyncStatus({ lastError: `记录 ${op.recordId} 的附件本地数据缺失，暂不能上传；编辑该记录或等待附件下载后自动重试。` })
            attention = { code: 'LOCAL_BLOB_MISSING', message: '有记录的附件数据不完整，暂不能上传。请编辑该记录或等待附件下载完成。' }
            return
          }
          const uploaded = await putBlob(config, attachment, image, signal)
          if (!uploaded.ok) {
            if (uploaded.code === 'QUOTA_EXCEEDED') {
              attention = { code: 'QUOTA_EXCEEDED', message: '云端附件容量已满（配额超限）。本地内容完好；请清理云端或提高配额后再同步。' }
              store.setSyncStatus({ lastError: attention.message })
              stopLoop()
              return
            }
            if (uploaded.code === 'PAYLOAD_TOO_LARGE') {
              attention = { code: 'PAYLOAD_TOO_LARGE', message: `附件超过云端单文件上限（${attachment.size} 字节），请压缩图片后重新编辑该记录。` }
              store.setSyncStatus({ lastError: attention.message })
              stopLoop()
              return
            }
            throw Object.assign(new Error(uploaded.error || '附件上传失败。'), { kind: 'network' })
          }
        }
        response = await requestJson(config, '/api/sync/v1/ops', {
          method: 'POST', signal,
          body: { spaceId: snapshot.spaceId, generation: snapshot.generation, opId: op.opId, recordId: op.recordId, baseRev, kind: 'put', record: wire },
        })
      } else {
        response = await requestJson(config, '/api/sync/v1/ops', {
          method: 'POST', signal,
          body: { spaceId: snapshot.spaceId, generation: snapshot.generation, opId: op.opId, recordId: op.recordId, baseRev, kind: 'delete' },
        })
      }
      await handleOpResponse(op, response, config)
      if (attention) return
    }
  }

  /** 处理一次 ops 应答：确认 / 冲突 / 幂等可重试错误 / 需要介入。 */
  async function handleOpResponse(op, response, config) {
    const { status, data } = response
    if (status === 200 && data?.ok) {
      store.confirmOp(op, { rev: data.rev })
      return
    }
    const code = data?.code || `HTTP_${status}`
    if (code === 'REV_CONFLICT') {
      // 冲突：保留双方进面板，其余记录继续同步。
      store.recordConflict({ recordId: op.recordId, kind: op.kind, record: op.record }, data.remote || {}, config.deviceName)
      return
    }
    if (code === 'BLOB_MISSING') {
      // 服务端说附件没到：按列表补传后用同一 opId 原样重试（由外层循环完成）。
      return
    }
    if (code === 'NOT_FOUND' || code === 'ALREADY_DELETED') {
      // 目标状态已达成（记录不存在 / 已删除）：操作完成。
      store.confirmOp(op, {})
      return
    }
    if (code === 'UNAUTHORIZED') {
      attention = { code: 'UNAUTHORIZED', message: '云端拒绝了访问密钥（可能已被撤销）。请到同步设置里更新密钥；本地数据不受影响。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (code === 'SPACE_CHANGED') {
      attention = { code: 'SPACE_CHANGED', message: '同步服务的空间身份已变化（重建或从备份恢复）。请到同步设置里重新合并。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (code === 'QUOTA_EXCEEDED') {
      attention = { code: 'QUOTA_EXCEEDED', message: '云端容量已满（配额超限）。本地内容完好；请清理云端或提高配额后再同步。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (code === 'INVALID_RECORD') {
      // 该操作永远无法被接受：出队并明示，本地内容保留（重新编辑会再排队）。
      store.confirmOp(op, {})
      store.setSyncStatus({ lastError: `一条记录被云端拒绝（${data?.error || '格式不合法'}），已跳过上传；本地内容保留，可编辑后重试。` })
      return
    }
    if (code === 'OP_BODY_MISMATCH') {
      attention = { code: 'OP_BODY_MISMATCH', message: '云端发现同一操作 ID 的两次请求内容不同（服务可能被恢复过）。请到同步设置里重新合并。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (code === 'RATE_LIMITED' || status === 429) {
      throw Object.assign(new Error('云端限速，稍后自动重试。'), { kind: 'network' })
    }
    if (status >= 500) {
      throw Object.assign(new Error(`云端暂时不可用（HTTP ${status}），稍后自动重试。`), { kind: 'network' })
    }
    throw Object.assign(new Error(data?.error || `同步请求失败（HTTP ${status}）。`), { kind: 'network' })
  }

  /** 上传一个附件（内容哈希校验、幂等）。 */
  async function putBlob(config, attachment, image, signal) {
    const base64 = image.data.slice(image.data.indexOf(',') + 1)
    const bytes = Buffer.from(base64, 'base64')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2)
    const onOuterAbort = () => controller.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await fetch(config.url + '/api/sync/v1/blobs/' + attachment.hash, {
        method: 'PUT',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-luanji-protocol': PROTOCOL,
          connection: 'close',
          'content-type': attachment.mime || 'application/octet-stream',
          'x-luanji-blob-name': encodeURIComponent(attachment.name || '图片'),
        },
        body: bytes,
      })
      const data = await response.json().catch(() => ({ ok: false, code: 'PROTOCOL_UNSUPPORTED', error: '附件服务返回异常。' }))
      return response.ok && data.ok ? { ok: true } : { ok: false, code: data.code || `HTTP_${response.status}`, error: data.error }
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('同步已停止。'), { aborted: true })
      throw classifyTransportError(error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  async function pullChanges(config, signal) {
    for (let guard = 0; guard < 10000; guard++) {
      const snapshot = store.syncSnapshot()
      const query = `/api/sync/v1/changes?cursor=${snapshot.cursor}&limit=${PAGE_LIMIT}`
        + `&spaceId=${encodeURIComponent(snapshot.spaceId)}&generation=${encodeURIComponent(snapshot.generation)}`
      const res = await requestJson(config, query, { signal })
      if (res.status === 401) throw Object.assign(new Error('认证失败：访问密钥不正确或已被撤销。'), { kind: 'auth' })
      if (res.status === 409 && res.data?.code === 'SPACE_CHANGED') {
        attention = { code: 'SPACE_CHANGED', message: '同步服务的空间身份已变化。请到同步设置里重新合并。' }
        store.setSyncStatus({ lastError: attention.message })
        stopLoop()
        return
      }
      if (res.status === 429) throw Object.assign(new Error('云端限速，稍后自动重试。'), { kind: 'network' })
      if (res.status !== 200 || !res.data?.ok) throw Object.assign(new Error(`拉取变更失败（HTTP ${res.status}）。`), { kind: 'network' })
      const page = res.data
      // 变更与游标同一次原子提交；未上传的本地修改由 store 暂存（held），不覆盖。
      store.applyRemotePage(page.changes, page.nextCursor)
      if (!page.hasMore) return
    }
  }

  async function downloadBlobs(config, signal) {
    for (const [hash, meta] of Object.entries(store.missingBlobs())) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2)
      const onOuterAbort = () => controller.abort()
      signal?.addEventListener('abort', onOuterAbort, { once: true })
      try {
        const response = await fetch(config.url + '/api/sync/v1/blobs/' + hash, {
          redirect: 'error',
          signal: controller.signal,
          headers: { authorization: `Bearer ${config.token}`, 'x-luanji-protocol': PROTOCOL, connection: 'close' },
        })
        if (!response.ok) continue // 保留待下载状态，下一轮重试
        const mime = response.headers.get('content-type') || meta.mime || ''
        if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > 64 * 1024 * 1024) continue
        store.fillBlobData(hash, `data:${mime};base64,${buffer.toString('base64')}`)
      } catch {
        // 单个附件失败不拖垮整轮同步：保留待下载状态。
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onOuterAbort)
      }
    }
  }

  /** 一次循环失败：网络类退避重试；需要介入的停表。 */
  function handleCycleError(error) {
    const kind = error?.kind
    if (kind === 'auth') {
      attention = { code: 'UNAUTHORIZED', message: '认证失败：访问密钥不正确或已被撤销。请到同步设置里更新；本地数据不受影响。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (kind === 'space') {
      attention = { code: 'SPACE_CHANGED', message: '同步服务的空间身份已变化（重建或从备份恢复）。请到同步设置里重新合并。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    if (kind === 'protocol') {
      attention = { code: 'PROTOCOL_UNSUPPORTED', message: '协议不兼容：服务与插件支持的同步协议版本不一致。' }
      store.setSyncStatus({ lastError: attention.message })
      stopLoop()
      return
    }
    // 网络类：指数退避（5s → 5min）+ 抖动。
    store.setSyncStatus({ lastError: error instanceof Error ? error.message : String(error) })
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** consecutiveFailures, BACKOFF_MAX_MS)
    const jitter = backoff * (0.75 + Math.random() * 0.5)
    consecutiveFailures++
    nextAttemptAt = Date.now() + jitter
  }

  /** 图片内容哈希（与 store 的 imageHash 同算法）。 */
  function hashOf(image) {
    if (image.hash) return image.hash
    const base64 = String(image.data || '').slice(String(image.data || '').indexOf(',') + 1)
    return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
  }

  // ── 对外：状态 / 控制 ────────────────────────────────
  function status() {
    const config = readSyncConfig(store.dataDir)
    const snapshot = store.syncSnapshot()
    let phase = 'off'
    if (snapshot.enabled && snapshot.spaceId) {
      if (attention) phase = 'attention'
      else if (snapshot.conflicts.length) phase = 'conflict'
      else if (cycleActive) phase = 'syncing'
      else if (snapshot.lastError && snapshot.lastErrorAt && (!snapshot.lastSyncAt || snapshot.lastErrorAt > snapshot.lastSyncAt)) phase = 'waiting'
      else phase = 'synced'
    }
    return {
      configured: Boolean(config),
      url: config?.url || '',
      host: config?.host || '',
      deviceName: config?.deviceName || '',
      hasToken: Boolean(config?.hasToken),
      bound: Boolean(snapshot.spaceId),
      enabled: Boolean(snapshot.enabled && snapshot.spaceId),
      spaceId: snapshot.spaceId,
      generation: snapshot.generation,
      phase,
      attention: attention ? { code: attention.code, message: attention.message } : null,
      lastSyncAt: snapshot.lastSyncAt,
      lastError: snapshot.lastError,
      lastErrorAt: snapshot.lastErrorAt,
      pendingOps: snapshot.pending.length,
      conflicts: snapshot.conflicts.length,
      missingBlobs: Object.keys(snapshot.missingBlobs).length,
      localCount: store.count,
    }
  }

  /** 立即同步：跳过等待，但不启动第二条并行循环。 */
  async function syncNow() {
    const snapshot = store.syncSnapshot()
    if (!snapshot.enabled || !snapshot.spaceId) throw new Error('同步尚未开启。')
    if (attention) {
      // 手动触发可用于验证问题已修复：清掉警示跑一轮，再失败会重新停表。
      attention = null
      nextAttemptAt = 0
      consecutiveFailures = 0
      startLoop()
    }
    nextAttemptAt = 0
    await scheduleCycle()
    return status()
  }

  /** 关闭同步：立即停止新网络操作、尝试取消在途请求；数据与待办保留。 */
  function disable() {
    store.setSyncEnabled(false)
    attention = null
    stopLoop()
    notify()
    return status()
  }

  /**
   * 冲突三选一。
   * @param {string} recordId
   * @param {'local'|'remote'|'both'} choice
   */
  async function resolveConflict(recordId, choice) {
    const config = readSyncConfig(store.dataDir)
    store.resolveConflict(recordId, choice, config?.deviceName || '')
    void scheduleCycle()
    return status()
  }

  /** 手动重试待下载附件。 */
  async function retryBlobs() {
    void scheduleCycle()
    return status()
  }

  /** 插件卸载时清理。 */
  function dispose() {
    disposed = true
    stopLoop()
  }

  // 插件启动时若同步已开启：恢复循环并跑一轮（启动触发）。
  if (store.syncSnapshot().enabled) {
    startLoop()
    void scheduleCycle()
  }

  return {
    status, testConnection, enable, disable, syncNow, resolveConflict, retryBlobs, notifyLocalChange, dispose,
  }
}
