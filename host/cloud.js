/**
 * 可选的云端数据服务：和「乱记兼容」的 HTTP 服务做手动拉取 / 推送。
 *
 * 插件默认只读写本机（`~/.dsh/luanji/notes.json`）。只有在插件配置里显式写入
 * `cloud.url` 之后，本模块才会联网；认证方式由配置里提供的请求头决定
 * （例如 Bearer token，或 DSH 之外的乱记 Web 服务使用的会话 Cookie）。
 *
 * 数据契约（block6 的乱记 API 即为参考实现）：
 *   GET  {url}{paths.state}   → { records: [{ id, text, source, created_at, updated_at }], draft?: string }
 *   GET  {url}{paths.images}  → { images: [{ id, data }] }             // 可选
 *   POST {url}{paths.import}  → { added, updated }                      // body: { records, images }
 *
 * 合并在本机完成：同 id 以 `updated_at` 较新的一方为准；带引用的记录只留在本机
 * （云端模型没有引用），删除不同步。
 *
 * @module dsh-luanji/host/cloud
 */

import fs from 'node:fs'
import path from 'node:path'

/** 默认端点，按 block6 的乱记 API 约定。 */
const DEFAULT_PATHS = {
  state: '/api/luanji/state',
  images: '/api/luanji/images',
  import: '/api/luanji/import',
}

/** 单次响应上限，防止异常服务把宿主内存打满。 */
const MAX_RESPONSE = 64 * 1024 * 1024

/**
 * 规整插件配置里的 `cloud` 段。
 *
 * @param {unknown} raw - 插件 config.cloud。
 * @returns {{url: string, headers: Record<string, string>, timeoutMs: number, paths: typeof DEFAULT_PATHS} | null}
 */
export function normalizeCloudConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^/]+/i.test(url)) return null
  const headers = {}
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (token) headers.Authorization = `Bearer ${token}`
  const cookie = typeof raw.cookie === 'string' ? raw.cookie.trim() : ''
  if (cookie) headers.Cookie = cookie
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string' && value) headers[name] = value
    }
  }
  const timeoutMs = Number.isFinite(raw.timeoutMs) ? Math.min(60_000, Math.max(1_000, raw.timeoutMs)) : 15_000
  const paths = { ...DEFAULT_PATHS }
  if (raw.paths && typeof raw.paths === 'object') {
    for (const key of Object.keys(DEFAULT_PATHS)) {
      if (typeof raw.paths[key] === 'string' && raw.paths[key].startsWith('/')) paths[key] = raw.paths[key]
    }
  }
  return { url, headers, timeoutMs, paths }
}

/** 从 URL 里取一个可展示的 host，不暴露查询参数。 */
export function cloudHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * 创建云端同步服务。
 *
 * @param {object} options
 * @param {unknown} options.config - 插件 config.cloud。
 * @param {object} options.store - host/store.js 的实例。
 * @returns {{
 *   configured: boolean,
 *   url: string,
 *   status: () => Record<string, unknown>,
 *   pull: () => Promise<Record<string, unknown>>,
 *   push: () => Promise<Record<string, unknown>>,
 *   recordError: (error: Error) => void,
 * }}
 */
export function createCloudService({ config, store }) {
  const cloud = normalizeCloudConfig(config)
  const metaFile = path.join(store.dataDir, 'cloud-sync.json')

  const readMeta = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  const writeMeta = (patch) => {
    const next = { ...readMeta(), ...patch }
    try {
      fs.mkdirSync(store.dataDir, { recursive: true })
      const tmp = `${metaFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, metaFile)
    } catch {
      // 同步元数据不是关键路径，写不进去也不影响记录本身。
    }
  }

  /** 有一次带超时的 JSON 请求。 */
  async function request(pathname, { method = 'GET', body } = {}) {
    const target = new URL(cloud.url + pathname)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cloud.timeoutMs)
    try {
      const response = await fetch(target, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...cloud.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const raw = await response.text()
      if (raw.length > MAX_RESPONSE) throw new Error('云端响应过大，已拒绝读取。')
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error(`云端返回的不是 JSON（HTTP ${response.status}）。`)
      }
      if (!response.ok) {
        const reason = typeof data?.error === 'string' && data.error ? data.error : `HTTP ${response.status}`
        throw new Error(`云端请求失败：${reason}`)
      }
      return data
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('云端请求超时，请检查网络或服务地址。')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function status() {
    const meta = readMeta()
    return {
      configured: Boolean(cloud),
      url: cloud?.url || '',
      host: cloud ? cloudHost(cloud.url) : '',
      paths: cloud?.paths || null,
      lastPullAt: Number.isFinite(meta.lastPullAt) ? meta.lastPullAt : null,
      lastPushAt: Number.isFinite(meta.lastPushAt) ? meta.lastPushAt : null,
      lastError: typeof meta.lastError === 'string' ? meta.lastError : '',
      lastErrorAt: Number.isFinite(meta.lastErrorAt) ? meta.lastErrorAt : null,
      lastResult: meta.lastResult && typeof meta.lastResult === 'object' ? meta.lastResult : null,
    }
  }

  function requireCloud() {
    if (!cloud) throw new Error('还没有配置云端服务。在插件配置里填 cloud.url（可选 token / cookie / headers）。')
    return cloud
  }

  /** 拉取云端快照并并入本机。 */
  async function pull() {
    const current = requireCloud()
    if (!current) throw new Error('云端未配置。')
    const state = await request(current.paths.state)
    if (!state || !Array.isArray(state.records)) throw new Error('云端返回值缺少 records 列表。')
    let images = []
    let imagesWarning = ''
    try {
      const remoteImages = await request(current.paths.images)
      if (remoteImages && Array.isArray(remoteImages.images)) images = remoteImages.images
    } catch (error) {
      // 图片是可选端点：失败时只同步文字，不把整次拉取判失败。
      imagesWarning = error instanceof Error ? error.message : String(error)
    }
    const result = store.importRemote({ records: state.records, images, draft: state.draft })
    const at = Date.now()
    writeMeta({ lastPullAt: at, lastError: '', lastErrorAt: null, lastResult: { ...result, direction: 'pull', at } })
    return { ...result, imagesWarning, at }
  }

  /** 把本机纯文本记录推送到云端（引用记录留在本机）。 */
  async function push() {
    const current = requireCloud()
    if (!current) throw new Error('云端未配置。')
    const payload = store.exportForCloud()
    if (!payload.records.length) {
      const at = Date.now()
      writeMeta({ lastPushAt: at, lastError: '', lastErrorAt: null, lastResult: { ...payload, added: 0, updated: 0, direction: 'push', at } })
      return { added: 0, updated: 0, records: 0, images: 0, skippedQuoted: payload.skippedQuoted, at }
    }
    const remote = await request(current.paths.import, { method: 'POST', body: payload })
    const at = Date.now()
    const result = {
      added: Number(remote?.added) || 0,
      updated: Number(remote?.updated) || 0,
      records: payload.records.length,
      images: payload.images.length,
      skippedQuoted: payload.skippedQuoted,
      at,
    }
    writeMeta({ lastPushAt: at, lastError: '', lastErrorAt: null, lastResult: { ...result, direction: 'push' } })
    return result
  }

  return {
    get configured() { return Boolean(cloud) },
    get url() { return cloud?.url || '' },
    status,
    pull,
    push,
    recordError(error) {
      const message = error instanceof Error ? error.message : String(error)
      writeMeta({ lastError: message.slice(0, 500), lastErrorAt: Date.now() })
    },
  }
}
