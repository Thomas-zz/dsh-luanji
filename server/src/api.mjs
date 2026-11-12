/**
 * /api/sync/v1/* HTTP 层：认证、限速、路由分发到 core。
 *
 * 认证两种：
 *  - 设备 Token：Authorization: Bearer lj_…（桌面插件、CLI）；
 *  - 手机网页会话：lj_session Cookie（同源）+ 写操作 X-CSRF-Token 头。
 *
 * @module luanji-sync-server/api
 */

import { applyOperation, info, readChanges, readBlob, storeBlob } from './core.mjs'
import { findSession, findToken } from './auth.mjs'
import { parseCookies, readBody, readJson, SECURITY_HEADERS, sendJson } from './http.mjs'
import { getMeta, META_KEYS } from './db.mjs'
import { ProtocolError } from './validate.mjs'

export const PROTOCOL_VERSION = 1

/**
 * 解析请求身份。返回 null 表示未认证。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('better-sqlite3').Database} db
 * @returns {{kind: 'token', name: string} | {kind: 'session', csrf: string} | null}
 */
export function resolveAuth(req, db) {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = findToken(db, header.slice(7).trim())
    return token ? { kind: 'token', name: token.name } : null
  }
  const session = findSession(db, parseCookies(req).lj_session)
  return session ? { kind: 'session', csrf: session.csrf } : null
}

/**
 * 处理 /api/sync/v1/* 请求。返回 true 表示已处理。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{db: import('better-sqlite3').Database, cfg: object, limiter: {allow(key: string): boolean}}} ctx
 * @returns {Promise<boolean>}
 */
export async function handleSyncApi(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/sync/v1/')) return false
  const route = url.pathname.slice('/api/sync/v1/'.length).replace(/\/+$/, '')
  const method = req.method || 'GET'

  try {
    // 协议版本：客户端带版本头时不兼容立即拒绝（不落到 404）。
    const clientVersion = req.headers['x-luanji-protocol']
    if (clientVersion !== undefined && String(clientVersion) !== String(PROTOCOL_VERSION)) {
      sendJson(res, 501, { ok: false, code: 'PROTOCOL_UNSUPPORTED', error: `服务只支持协议 v${PROTOCOL_VERSION}。` })
      return true
    }

    // 附件下载不需要 CSRF；其余写操作（ops / blobs PUT）要求会话身份带 CSRF 头。
    const isWrite = method !== 'GET'
    const needCsrf = isWrite && (route === 'ops' || route.startsWith('blobs/'))

    if (route === 'info' && method === 'GET') {
      const auth = requireAuth(req, res, ctx)
      if (!auth || !limitOr429(ctx, auth, res)) return true
      const out = info(ctx.db, ctx.cfg)
      sendJson(res, out.status, out.body)
      return true
    }

    if (route === 'ops' && method === 'POST') {
      const auth = requireAuth(req, res, ctx, { csrf: true })
      if (!auth || !limitOr429(ctx, auth, res)) return true
      const parsed = await readJson(req, ctx.cfg.maxOpsBodyBytes)
      if (parsed.error === 'too-large') { sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: '请求体过大。' }); return true }
      if (parsed.error) { sendJson(res, 400, { ok: false, code: 'INVALID_RECORD', error: '请求体不是合法 JSON 对象。' }); return true }
      const out = applyOperation(ctx.db, ctx.cfg, parsed.body)
      sendJson(res, out.status, out.body)
      return true
    }

    if (route === 'changes' && method === 'GET') {
      const auth = requireAuth(req, res, ctx)
      if (!auth || !limitOr429(ctx, auth, res)) return true
      // 客户端可带空间身份参数，不匹配立即失败（避免拿着旧游标空转）。
      const spaceId = url.searchParams.get('spaceId')
      const generation = url.searchParams.get('generation')
      if (spaceId || generation) {
        const mismatch = assertSpaceIdentity(ctx, { spaceId: spaceId || undefined, generation: generation || undefined })
        if (mismatch) { sendJson(res, 409, mismatch); return true }
      }
      const query = {
        cursor: Number(url.searchParams.get('cursor') ?? 0),
        limit: Number(url.searchParams.get('limit') ?? ctx.cfg.changesPageSize),
        upperBound: url.searchParams.has('upperBound') ? Number(url.searchParams.get('upperBound')) : null,
      }
      const out = readChanges(ctx.db, ctx.cfg, query)
      sendJson(res, out.status, out.body)
      return true
    }

    const blobMatch = route.match(/^blobs\/([0-9a-f]{64})$/)

    if (blobMatch && method === 'PUT') {
      const auth = requireAuth(req, res, ctx, { csrf: true })
      if (!auth || !limitOr429(ctx, auth, res)) return true
      const hash = blobMatch[1].toLowerCase()
      const bytes = await readBody(req, ctx.cfg.maxBlobBytes)
      if (bytes === null) { sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: `附件超过单文件上限 ${ctx.cfg.maxBlobBytes} 字节。` }); return true }
      const out = storeBlob(ctx.db, ctx.cfg, hash, bytes, { mime: req.headers['content-type'], name: req.headers['x-luanji-blob-name'] })
      sendJson(res, out.status, out.body)
      return true
    }

    if (blobMatch && method === 'GET') {
      const auth = requireAuth(req, res, ctx)
      if (!auth) return true
      const blob = readBlob(ctx.db, ctx.cfg, blobMatch[1].toLowerCase())
      if (!blob) { sendJson(res, 404, { ok: false, code: 'BLOB_MISSING', error: '附件不存在。' }); return true }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': blob.mime,
        'content-length': String(blob.bytes.length),
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${blobMatch[1].toLowerCase()}"`,
      })
      res.end(blob.bytes)
      return true
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '未知的同步接口。' })
    return true
  } catch (error) {
    if (error instanceof ProtocolError) {
      sendJson(res, error.code === 'SPACE_CHANGED' ? 409 : 400, { ok: false, code: error.code, error: error.message, ...error.extra })
      return true
    }
    throw error
  }
}

/**
 * 认证失败统一 401（不区分“没带”与“带错”）。
 * 会话写操作要求 CSRF 头匹配。
 */
function requireAuth(req, res, ctx, options = {}) {
  const auth = resolveAuth(req, ctx.db)
  if (!auth) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '认证失败：请检查设备 Token 或登录状态。' })
    return null
  }
  if (options.csrf && auth.kind === 'session' && req.headers['x-csrf-token'] !== auth.csrf) {
    sendJson(res, 403, { ok: false, code: 'UNAUTHORIZED', error: '缺少或错误的 CSRF 令牌。' })
    return null
  }
  return auth
}

/** 限速：超限直接 429 + Retry-After，客户端按退避处理。 */
function limitOr429(ctx, auth, res) {
  const key = auth.kind === 'token' ? 'token:' + auth.name : 'session'
  if (!ctx.limiter.allow(key)) {
    res.setHeader('retry-after', '30')
    sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: '请求过于频繁，请稍后重试。' })
    return false
  }
  return true
}

/**
 * 空间身份检查（changes 查询参数用）。不匹配时返回 409 应答体。
 *
 * @returns {object | null}
 */
function assertSpaceIdentity(ctx, probe) {
  const spaceId = getMeta(ctx.db, META_KEYS.spaceId)
  const generation = getMeta(ctx.db, META_KEYS.generation)
  if (probe.spaceId !== undefined && probe.spaceId !== spaceId) {
    return { ok: false, code: 'SPACE_CHANGED', error: '数据空间不一致。', spaceId, generation }
  }
  if (probe.generation !== undefined && probe.generation !== generation) {
    return { ok: false, code: 'SPACE_CHANGED', error: '服务已重建或从快照恢复，需要重新合并。', spaceId, generation }
  }
  return null
}
