/**
 * 极小 HTTP 工具：读体限额、JSON 应答、安全响应头、来源校验。
 * 不引入框架；路由在各 api 模块内手写。
 *
 * @module luanji-sync-server/http
 */

/** 常见安全响应头（网页与 API 通用；上传内容永不作为 HTML 执行）。 */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
}

/**
 * 发 JSON 应答。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {object} obj
 */
export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读请求体（原始字节），超过上限立即截断并报错。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer | null>} 超限时返回 null（调用方按 413 处理）。
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
  })
}

/**
 * 读请求体并 JSON.parse；坏 JSON 返回 undefined（调用方按 400 处理）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{body: object}|{error: 'too-large'|'bad-json'}>}
 */
export async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes)
  if (raw === null) return { error: 'too-large' }
  try {
    const parsed = JSON.parse(raw.toString('utf8') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'bad-json' }
    return { body: parsed }
  } catch {
    return { error: 'bad-json' }
  }
}

/**
 * 解析 Cookie 头。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
  const header = req.headers.cookie
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

/**
 * 会话 Cookie 串。Secure 在本地 http 调试（localhost）下省略，其余一律带。
 *
 * @param {string} name
 * @param {string} value
 * @param {{secure: boolean}} options
 * @returns {string}
 */
export function sessionCookie(name, value, { secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 来源校验：Origin 存在时必须与 Host 同源（跨源写一律拒绝）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return true // 非浏览器 / same-origin fetch 一般不带或带同源
  try {
    const url = new URL(String(origin))
    const host = req.headers.host || ''
    return url.host === host
  } catch {
    return false
  }
}

/** 请求日志：只记方法、路径、状态与耗时，不记查询串里的数据和任何凭据/正文。 */
export function logRequest(req, res, ms) {
  const path = String(req.url || '/').split('?')[0]
  console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${ms}ms`)
}
