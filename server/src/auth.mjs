/**
 * 认证：设备 Token（Bearer）+ 手机网页会话（Cookie）+ 单人登录口令。
 *
 * Token 仅创建时显示一次，服务端只存 sha256 哈希；
 * 会话 Cookie Secure / HttpOnly / SameSite=Strict，写操作另校验 CSRF 头。
 *
 * @module luanji-sync-server/auth
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Token 明文前缀（展示/撤销线索，不构成秘密）。 */
export const TOKEN_PREFIX = 'lj_'

/** 生成一个新设备 Token。 @returns {string} */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url')
}

/** Token / opId 一致哈希（hex）。 @param {string} value */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 按 Bearer 凭据查找有效 Token。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} token - 明文 Token。
 * @returns {{id: number, name: string} | null}
 */
export function findToken(db, token) {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null
  const row = db.prepare('SELECT id, name, revoked_at FROM tokens WHERE hash = ?').get(sha256Hex(token))
  if (!row || row.revoked_at) return null
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id)
  return { id: row.id, name: row.name }
}

/**
 * 设置/替换手机登录口令（scrypt）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} password - 明文口令。
 */
export function setPassword(db, password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('口令至少 8 位。')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')
  const stored = `scrypt$${salt}$${hash}`
  db.prepare('INSERT INTO phone_auth (id, password, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at').run(stored, Date.now())
}

/**
 * 校验手机登录口令。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} password
 * @returns {boolean}
 */
export function verifyPassword(db, password) {
  const row = db.prepare('SELECT password FROM phone_auth WHERE id = 1').get()
  if (!row) return false
  const [scheme, salt, hash] = String(row.password).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const given = scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 })
  const expected = Buffer.from(hash, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** @returns {boolean} 是否已设置手机口令 */
export function hasPassword(db) {
  return Boolean(db.prepare('SELECT 1 FROM phone_auth WHERE id = 1').get())
}

/**
 * 创建网页会话。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} ttlMs - 会话有效期。
 * @returns {{id: string, csrf: string}}
 */
export function createSession(db, ttlMs) {
  const id = randomBytes(24).toString('base64url')
  const csrf = randomBytes(18).toString('base64url')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, csrf, now, now + ttlMs)
  return { id, csrf }
}

/**
 * 查找有效会话。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{csrf: string} | null}
 */
export function findSession(db, id) {
  if (!id) return null
  const row = db.prepare('SELECT csrf, expires_at FROM sessions WHERE id = ?').get(id)
  if (!row || row.expires_at <= Date.now()) return null
  return { csrf: String(row.csrf) }
}

/** 删除过期会话。 @param {import('better-sqlite3').Database} db */
export function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
}

/**
 * 登录限速：窗口内失败次数达到上限后拒绝尝试。
 * 纯内存实现——重启清零，对单人服务足够。
 */
export class LoginThrottle {
  /**
   * @param {{windowMs: number, maxFailures: number}} options
   */
  constructor(options) {
    this.windowMs = options.windowMs
    this.maxFailures = options.maxFailures
    /** @type {Map<string, number[]>} */
    this.failures = new Map()
  }

  /** @param {string} key @returns {boolean} 是否仍允许尝试 */
  allow(key) {
    const cutoff = Date.now() - this.windowMs
    const list = (this.failures.get(key) || []).filter((at) => at > cutoff)
    this.failures.set(key, list)
    return list.length < this.maxFailures
  }

  /** @param {string} key 记一次失败 */
  fail(key) {
    const list = this.failures.get(key) || []
    list.push(Date.now())
    this.failures.set(key, list)
  }
}

/**
 * 简单固定窗口限速（内存）：用于 API 整体防护。
 */
export class RateLimiter {
  /**
   * @param {number} perMinute - 每分钟允许的请求数。
   */
  constructor(perMinute) {
    this.perMinute = perMinute
    /** @type {Map<string, {window: number, count: number}>} */
    this.buckets = new Map()
  }

  /**
   * @param {string} key
   * @returns {boolean} 是否放行
   */
  allow(key) {
    const now = Date.now()
    const window = Math.floor(now / 60000)
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.window !== window) {
      this.buckets.set(key, { window, count: 1 })
      return true
    }
    bucket.count += 1
    return bucket.count <= this.perMinute
  }
}
