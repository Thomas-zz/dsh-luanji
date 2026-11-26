/**
 * 同步核心逻辑：操作提交（幂等 + 版本冲突）、变更日志读取、附件存取。
 *
 * 硬性约定（docs/sync-protocol-v1.md）：
 *  - opId 回执、records 当前版本、changes 不可变快照在同一事务中写入，
 *    幂等靠数据库主键落实，不靠应用内先查再写；
 *  - baseRev 不匹配返回 REV_CONFLICT 与远端当前版本；
 *  - 变更日志永不清理（首版），cursor=0 可重放整个库（含墓碑）。
 *
 * @module luanji-sync-server/core
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getMeta, META_KEYS } from './db.mjs'
import { validateRecord, ProtocolError } from './validate.mjs'

/** 可随响应返回给客户端的记录形状（去内部列名）。 */
function rowToRecord(row) {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    quote: row.quote_json ? JSON.parse(row.quote_json) : null,
    attachments: JSON.parse(row.attachments_json || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? null,
    rev: row.rev,
  }
}

/** 请求体一致性哈希：同 opId 必须重放同一请求。 */
export function operationRequestHash(op) {
  const canonical = JSON.stringify({
    spaceId: op.spaceId, generation: op.generation, opId: op.opId,
    recordId: op.recordId, baseRev: op.baseRev, kind: op.kind, record: op.record ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 空间身份校验：不匹配即 SPACE_CHANGED（客户端必须停止增量同步并重新合并）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{spaceId?: unknown, generation?: unknown}} op
 */
function assertSpace(db, op) {
  const spaceId = getMeta(db, META_KEYS.spaceId)
  const generation = getMeta(db, META_KEYS.generation)
  if (op.spaceId !== undefined && op.spaceId !== spaceId) throw new ProtocolError('SPACE_CHANGED', '数据空间不一致：客户端绑定的 spaceId 与服务端不同。', { spaceId, generation })
  if (op.generation !== undefined && op.generation !== generation) throw new ProtocolError('SPACE_CHANGED', '服务已重建或从快照恢复（generation 变化），需要重新合并。', { spaceId, generation })
}

/**
 * 提交一个操作（put / delete）。
 *
 * 返回值即 HTTP 应答体；`committed` 表示本事务是否落了数据（供测试与日志用）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} cfg - 服务配置（限制）。
 * @param {{spaceId?: string, generation?: string, opId: string, recordId: string, baseRev: number, kind: 'put'|'delete', record?: unknown}} op
 * @returns {{status: number, body: object, committed: boolean}}
 */
export function applyOperation(db, cfg, op) {
  if (!op || typeof op !== 'object') throw new ProtocolError('INVALID_RECORD', '操作必须是对象。')
  const opId = String(op.opId || '')
  const recordId = String(op.recordId || '')
  if (!opId || opId.length > 150 || !recordId || recordId.length > 150) throw new ProtocolError('INVALID_RECORD', 'opId 与 recordId 不能为空。')
  if (op.kind !== 'put' && op.kind !== 'delete') throw new ProtocolError('INVALID_RECORD', 'kind 只能是 put 或 delete。')
  const baseRev = Number(op.baseRev)
  if (!Number.isFinite(baseRev) || baseRev < 0 || !Number.isInteger(baseRev)) throw new ProtocolError('INVALID_RECORD', 'baseRev 必须是非负整数。')
  assertSpace(db, op)

  const requestHash = operationRequestHash(op)
  let result = null

  const tx = db.transaction(() => {
    // ① 幂等回执：同 opId 同请求体原样重放，不同请求体拒绝。
    const receipt = db.prepare('SELECT request_hash, result_json FROM operation_receipts WHERE op_id = ?').get(opId)
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        result = { status: 409, body: { ok: false, code: 'OP_BODY_MISMATCH', error: '同一 opId 的重试请求体不一致，已拒绝。' }, committed: false }
        return
      }
      const stored = JSON.parse(receipt.result_json)
      result = { status: stored.status, body: stored.body, committed: false }
      return
    }

    const current = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId)

    if (op.kind === 'put') {
      const record = validateRecord(op.record, cfg)
      if (record.id !== recordId) throw new ProtocolError('INVALID_RECORD', 'record.id 与 recordId 不一致。')
      // baseRev=0 代表创建；已存在（含墓碑）即冲突。
      if (baseRev === 0 && current) {
        result = conflict(current)
        return
      }
      if (baseRev > 0 && !current) {
        result = { status: 200, body: { ok: false, code: 'NOT_FOUND', recordId, error: '记录不存在，无法更新。' } }
        return
      }
      if (current && current.rev !== baseRev) {
        result = conflict(current)
        return
      }
      // 附件必须先上传：缺哈希直接给结构化结果，不当成成功。
      if (record.attachments.length) {
        const hashes = record.attachments.map((a) => a.hash)
        const marks = hashes.map(() => '?').join(',')
        const found = new Set(db.prepare(`SELECT hash FROM blobs WHERE hash IN (${marks})`).all(...hashes).map((r) => r.hash))
        const missing = hashes.filter((h) => !found.has(h))
        if (missing.length) {
          result = { status: 200, body: { ok: false, code: 'BLOB_MISSING', recordId, missing, error: '附件尚未上传，请先 PUT blobs 再重试同一操作。' } }
          return
        }
      }
      const now = Date.now()
      const rev = current ? current.rev + 1 : 1
      const stored = { ...record, deleted_at: null }
      db.prepare(`INSERT INTO records (id, text, source, quote_json, attachments_json, created_at, updated_at, deleted_at, rev)
                  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
                  ON CONFLICT(id) DO UPDATE SET text=excluded.text, source=excluded.source, quote_json=excluded.quote_json,
                    attachments_json=excluded.attachments_json, created_at=excluded.created_at, updated_at=excluded.updated_at,
                    deleted_at=NULL, rev=excluded.rev`)
        .run(stored.id, stored.text, stored.source, stored.quote ? JSON.stringify(stored.quote) : null, JSON.stringify(stored.attachments), stored.created_at, stored.updated_at, rev)
      const seq = appendChange(db, stored, rev, 'put', now)
      const body = { ok: true, opId, recordId, rev, seq }
      db.prepare('INSERT INTO operation_receipts (op_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)').run(opId, requestHash, JSON.stringify({ status: 200, body }), now)
      result = { status: 200, body, committed: true }
      return
    }

    // kind === 'delete'
    if (!current) {
      result = { status: 200, body: { ok: false, code: 'NOT_FOUND', recordId, error: '记录不存在，无需删除。' } }
      return
    }
    if (current.rev !== baseRev) {
      result = conflict(current)
      return
    }
    if (current.deleted_at !== null && current.deleted_at !== undefined) {
      result = { status: 200, body: { ok: false, code: 'ALREADY_DELETED', recordId, rev: current.rev, error: '记录已被删除。' } }
      return
    }
    const now = Date.now()
    const rev = current.rev + 1
    const tombstone = { ...rowToRecord(current), deleted_at: now, updated_at: now }
    db.prepare('UPDATE records SET deleted_at = ?, updated_at = ?, rev = ? WHERE id = ?').run(now, now, rev, recordId)
    const seq = appendChange(db, tombstone, rev, 'delete', now)
    const body = { ok: true, opId, recordId, rev, seq }
    db.prepare('INSERT INTO operation_receipts (op_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)').run(opId, requestHash, JSON.stringify({ status: 200, body }), now)
    result = { status: 200, body, committed: true }
  })

  tx()
  return result

  /** 远端当前版本随 409 返回，供冲突面板展示。 */
  function conflict(row) {
    const remote = rowToRecord(row)
    return { status: 409, body: { ok: false, code: 'REV_CONFLICT', recordId, error: '远端已有新版本。', remote: { rev: remote.rev, record: remote } } }
  }
}

/** 写一条不可变变更快照。 @returns {number} seq */
function appendChange(db, record, rev, op, at) {
  const info = db.prepare('INSERT INTO changes (id, op, rev, record_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(record.id, op, rev, JSON.stringify(record), at)
  return Number(info.lastInsertRowid)
}

/**
 * 读取一页变更。
 *
 * 首次请求（不带 upperBound）在同一读里取当前最大 seq 作为分页上界；
 * 后续页必须携带同一 upperBound，页大小同时受条数与字节约束。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} cfg
 * @param {{cursor: number, limit?: number, upperBound?: number|null}} query
 * @returns {{status: number, body: object}}
 */
export function readChanges(db, cfg, query) {
  const spaceId = getMeta(db, META_KEYS.spaceId)
  const generation = getMeta(db, META_KEYS.generation)
  const maxSeq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes').get().s)
  const cursor = Math.max(0, Math.floor(query.cursor) || 0)
  const upperBound = query.upperBound === null || query.upperBound === undefined ? maxSeq : Math.min(Math.floor(query.upperBound) || 0, maxSeq)
  const limit = Math.min(Math.max(1, Math.floor(query.limit) || cfg.changesPageSize), cfg.changesPageSize)

  // 只取本页候选（条数上界），字节上界在循环里截断；剩余用 EXISTS 判断。
  const rows = db.prepare('SELECT seq, id, op, rev, record_json FROM changes WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?').all(cursor, upperBound, limit)
  const changes = []
  let bytes = 0
  let nextCursor = cursor
  for (const row of rows) {
    if (changes.length > 0 && bytes + row.record_json.length > cfg.changesPageBytes) break
    changes.push({ seq: row.seq, id: row.id, op: row.op, rev: row.rev, record: JSON.parse(row.record_json) })
    nextCursor = row.seq
    bytes += row.record_json.length + 64
  }
  const hasMore = Boolean(db.prepare('SELECT 1 FROM changes WHERE seq > ? AND seq <= ? LIMIT 1').get(nextCursor, upperBound))
  return {
    status: 200,
    body: { ok: true, spaceId, generation, upperBound, nextCursor, hasMore, changes },
  }
}

/** 附件落盘路径。 */
export function blobPath(blobDir, hash) {
  return path.join(blobDir, hash.slice(0, 2), hash)
}

/**
 * 保存一个附件（幂等；内容哈希不符 / 超单文件限额 / 超总容量即拒绝）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} cfg
 * @param {string} hash - 期望的 sha256（hex）。
 * @param {Buffer} bytes
 * @param {{mime?: string, name?: string}} meta
 * @returns {{status: number, body: object}}
 */
export function storeBlob(db, cfg, hash, bytes, meta = {}) {
  if (!/^[0-9a-f]{64}$/.test(hash)) return { status: 400, body: { ok: false, code: 'INVALID_HASH', error: '附件哈希必须是 sha256 十六进制。' } }
  if (!bytes || !bytes.length) return { status: 400, body: { ok: false, code: 'INVALID_HASH', error: '附件内容为空。' } }
  if (bytes.length > cfg.maxBlobBytes) return { status: 413, body: { ok: false, code: 'PAYLOAD_TOO_LARGE', error: `附件超过单文件上限 ${cfg.maxBlobBytes} 字节。` } }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== hash) return { status: 400, body: { ok: false, code: 'INVALID_HASH', error: '附件内容与哈希不符。' } }

  const existing = db.prepare('SELECT hash, size FROM blobs WHERE hash = ?').get(hash)
  if (existing) return { status: 200, body: { ok: true, hash, size: existing.size, deduplicated: true } }

  const total = Number(db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM blobs').get().s)
  if (total + bytes.length > cfg.quotaBytes) {
    return { status: 413, body: { ok: false, code: 'QUOTA_EXCEEDED', error: `附件总容量已达上限（${cfg.quotaBytes} 字节）。` } }
  }

  const file = blobPath(cfg.blobDir, hash)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  const mime = /^image\/(png|jpeg|webp|gif)$/.test(String(meta.mime || '')) ? String(meta.mime) : 'application/octet-stream'
  db.prepare('INSERT INTO blobs (hash, size, mime, name, created_at) VALUES (?, ?, ?, ?, ?)').run(hash, bytes.length, mime, String(meta.name || '').slice(0, 200), Date.now())
  return { status: 200, body: { ok: true, hash, size: bytes.length } }
}

/**
 * 读取附件（校验存在）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} cfg
 * @param {string} hash
 * @returns {{bytes: Buffer, mime: string} | null}
 */
export function readBlob(db, cfg, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  const row = db.prepare('SELECT size, mime FROM blobs WHERE hash = ?').get(hash)
  if (!row) return null
  const file = blobPath(cfg.blobDir, hash)
  let bytes
  try { bytes = fs.readFileSync(file) } catch { return null }
  if (bytes.length !== row.size) return null
  return { bytes, mime: row.mime }
}

/**
 * 服务概要信息。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} cfg
 * @returns {{status: number, body: object}}
 */
export function info(db, cfg) {
  const activeCount = Number(db.prepare('SELECT COUNT(*) AS c FROM records WHERE deleted_at IS NULL').get().c)
  return {
    status: 200,
    body: {
      ok: true,
      protocolVersion: 1,
      spaceId: getMeta(db, META_KEYS.spaceId),
      generation: getMeta(db, META_KEYS.generation),
      activeCount,
      limits: {
        maxTextChars: cfg.maxTextChars,
        maxAttachments: cfg.maxAttachments,
        maxBlobBytes: cfg.maxBlobBytes,
        quotaBytes: cfg.quotaBytes,
      },
    },
  }
}
