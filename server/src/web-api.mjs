/**
 * /api/web/v1/*：手机网页专用的登录与只读列表接口。
 *
 * 编辑、删除、附件上传下载全部复用 /api/sync/v1/*（会话 Cookie + CSRF），
 * 手机与桌面走同一套版本与幂等规则，不绕过冲突控制。
 *
 * @module luanji-sync-server/web-api
 */

import { createSession, findSession, hasPassword, verifyPassword } from './auth.mjs'
import { parseCookies, readJson, sameOrigin, sendJson, sessionCookie } from './http.mjs'

export const SESSION_COOKIE = 'lj_session'

/**
 * 处理 /api/web/v1/* 请求。返回 true 表示已处理。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{db: import('better-sqlite3').Database, cfg: object, throttle: LoginThrottle}} ctx
 * @returns {Promise<boolean>}
 */
export async function handleWebApi(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/web/v1/')) return false
  const route = url.pathname.slice('/api/web/v1/'.length).replace(/\/+$/, '')
  const method = req.method || 'GET'

  // 所有 web 接口都是同源请求；跨源写直接拒绝。
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, code: 'UNAUTHORIZED', error: '跨源请求被拒绝。' })
    return true
  }

  if (route === 'login' && method === 'POST') {
    const key = 'ip:' + (req.socket.remoteAddress || 'unknown')
    if (!ctx.throttle.allow(key)) {
      res.setHeader('retry-after', '300')
      sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: '尝试次数过多，请稍后再试。' })
      return true
    }
    const parsed = await readJson(req, 16 * 1024)
    if (parsed.error) { sendJson(res, 400, { ok: false, code: 'INVALID_RECORD', error: '请求体不是合法 JSON。' }); return true }
    if (!hasPassword(ctx.db)) {
      sendJson(res, 403, { ok: false, code: 'UNAUTHORIZED', error: '尚未设置手机登录口令。请在服务器上运行 admin password-set。' })
      return true
    }
    const password = typeof parsed.body.password === 'string' ? parsed.body.password : ''
    if (!password || !verifyPassword(ctx.db, password)) {
      ctx.throttle.fail(key)
      sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '口令不正确。' })
      return true
    }
    const session = createSession(ctx.db, ctx.cfg.sessionTtlMs)
    // Secure：HTTPS 下必带；本机 http 调试（localhost）省略，浏览器仍按 SameSite=Strict 隔离。
    const secure = !isLocalRequest(req)
    res.setHeader('set-cookie', sessionCookie(SESSION_COOKIE, session.id, { secure }))
    sendJson(res, 200, { ok: true, csrf: session.csrf })
    return true
  }

  if (route === 'logout' && method === 'POST') {
    const session = parseCookies(req)[SESSION_COOKIE]
    if (session) ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(session)
    res.setHeader('set-cookie', expiredCookie())
    sendJson(res, 200, { ok: true })
    return true
  }

  if (route === 'session' && method === 'GET') {
    // 页面刷新后恢复 CSRF 令牌（会话 Cookie 只在同源请求里携带，令牌同源可读）。
    const session = findSession(ctx.db, parseCookies(req)[SESSION_COOKIE])
    if (!session) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '请先登录。' }); return true }
    sendJson(res, 200, { ok: true, csrf: session.csrf })
    return true
  }

  if (route === 'records' && method === 'GET') {
    const session = requireWebSession(req, ctx)
    if (!session) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '请先登录。' }); return true }
    const q = (url.searchParams.get('q') ?? '').slice(0, 200)
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    // 个人规模：SQLite 文本查询即可（正文 + 引用原文 + 会话名）。
    const pattern = `%${q.replace(/([%_\\])/g, '\\$1')}%`
    const where = q
      ? "deleted_at IS NULL AND (text LIKE ? ESCAPE '\\' OR quote_json LIKE ? ESCAPE '\\')"
      : 'deleted_at IS NULL'
    const args = q ? [pattern, pattern] : []
    const total = Number(ctx.db.prepare(`SELECT COUNT(*) AS c FROM records WHERE ${where}`).get(...args).c)
    const rows = ctx.db.prepare(`SELECT * FROM records WHERE ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...args, limit, offset)
    sendJson(res, 200, { ok: true, total, offset, limit, records: rows.map(webRecord) })
    return true
  }

  const detailMatch = route.match(/^records\/([0-9A-Za-z-]{1,150})$/)
  if (detailMatch && method === 'GET') {
    const session = requireWebSession(req, ctx)
    if (!session) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '请先登录。' }); return true }
    const row = ctx.db.prepare('SELECT * FROM records WHERE id = ?').get(decodeURIComponent(detailMatch[1]))
    if (!row || row.deleted_at !== null) { sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '记录不存在。' }); return true }
    sendJson(res, 200, { ok: true, record: webRecord(row) })
    return true
  }

  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '未知的网页接口。' })
  return true
}

/** 会话有效性（web 只认 Cookie，不认 Token）。 */
function requireWebSession(req, ctx) {
  return findSession(ctx.db, parseCookies(req)[SESSION_COOKIE])
}

/** 立即过期的会话 Cookie。 */
function expiredCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** 网页记录形状：wire 记录 + 服务端 rev（编辑时作为 baseRev）。 */
function webRecord(row) {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    quote: row.quote_json ? JSON.parse(row.quote_json) : null,
    attachments: JSON.parse(row.attachments_json || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    rev: row.rev,
  }
}

/** 本机调试（http://localhost / 127.0.0.1 / [::1]）时 Cookie 不加 Secure。 */
function isLocalRequest(req) {
  const host = String(req.headers.host || '')
  return /^localhost(\:\d+)?$/i.test(host) || /^127\.0\.0\.1(\:\d+)?$/.test(host) || /^\[::1\](\:\d+)?$/.test(host)
}
