/**
 * SQLite 打开、版本化迁移与 meta 读写。
 *
 * 数据库随服务打包（better-sqlite3），部署者不需要安装任何数据库软件。
 * WAL + busy_timeout：单实例个人服务足够；快照一律用 VACUUM INTO，
 * 不直接复制正在写入的数据库文件。
 *
 * @module luanji-sync-server/db
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** 空间身份键。 */
export const META_KEYS = { spaceId: 'spaceId', generation: 'generation', schemaVersion: 'schemaVersion' }

/**
 * 打开数据库并执行未应用的迁移（按文件名序，逐个事务）。
 *
 * @param {string} dbFile - SQLite 文件路径。
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  ensureSpaceIdentity(db)
  return db
}

/** 版本化迁移：migrations/*.sql 按序执行，已执行的记录在 meta 里。 */
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const applied = new Set(
    (db.prepare('SELECT value FROM meta WHERE key LIKE ?').all('migration:%') || []).map((row) => row.value),
  )
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('migration:' + file, file)
    })()
  }
}

/** 空间身份：spaceId 首次生成后不变；generation 在恢复/重建时必须更换。 */
function ensureSpaceIdentity(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
  insert.run(META_KEYS.spaceId, randomUUID())
  insert.run(META_KEYS.generation, randomUUID())
}

/**
 * 读取 meta 值。
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string | undefined}
 */
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? String(row.value) : undefined
}

/**
 * 写入 meta 值。
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} value
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}

/**
 * 更换 generation。空服务重建、从快照恢复后必须调用；客户端发现变化会停止增量同步并重新合并。
 * @param {import('better-sqlite3').Database} db
 * @returns {string} 新 generation
 */
export function rotateGeneration(db) {
  const next = randomUUID()
  setMeta(db, META_KEYS.generation, next)
  return next
}
