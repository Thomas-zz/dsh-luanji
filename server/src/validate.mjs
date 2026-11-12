/**
 * 协议记录（wire record）校验：只接受已知字段、限制尺寸，不静默截断。
 *
 * 记录结构与 docs/sync-protocol-v1.md 一致：
 *   { id, text, source, created_at, updated_at, quote|null, attachments[], deleted_at|null }
 *
 * @module luanji-sync-server/validate
 */

const ID_MAX = 150
const STRING_FIELD_MAX = 20000
const SOURCES = new Set(['agent', 'web', 'selection', 'ui', 'dsh'])
const MIME_RE = /^image\/(png|jpeg|webp|gif)$/
const HASH_RE = /^[0-9a-f]{64}$/

/** 协议层错误：带结构化 code，由 api 层映射 HTTP 状态码。 */
export class ProtocolError extends Error {
  /**
   * @param {string} code - 结构化错误码（INVALID_RECORD / BLOB_MISSING …）。
   * @param {string} message - 人类可读说明（可展示给用户）。
   * @param {object} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string}
 */
function str(value, field, max = STRING_FIELD_MAX) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ProtocolError('INVALID_RECORD', `${field} 必须是字符串。`)
  if (value.length > max) throw new ProtocolError('INVALID_RECORD', `${field} 超过 ${max} 字上限。`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function int(value, field) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new ProtocolError('INVALID_RECORD', `${field} 必须是非负数字。`)
  return Math.floor(n)
}

/**
 * 校验引用（quote）：不可变，必须保留 origin / anchor 全部字段。
 *
 * @param {unknown} value
 * @returns {object}
 */
function quote(value) {
  if (!value || typeof value !== 'object') throw new ProtocolError('INVALID_RECORD', 'quote 必须是对象或 null。')
  const text = str(value.text, 'quote.text')
  if (!text.trim()) throw new ProtocolError('INVALID_RECORD', '引用内容为空。')
  const origin = value.origin && typeof value.origin === 'object' ? value.origin : {}
  const anchor = value.anchor && typeof value.anchor === 'object' ? value.anchor : {}
  const role = ['user', 'assistant', 'unknown'].includes(origin.role) ? origin.role : 'unknown'
  return {
    id: str(value.id, 'quote.id', ID_MAX),
    text,
    origin: {
      role,
      model: str(origin.model, 'quote.origin.model', 300),
      sessionId: str(origin.sessionId, 'quote.origin.sessionId', 300),
      sessionTitle: str(origin.sessionTitle, 'quote.origin.sessionTitle', 500),
      messageId: str(origin.messageId, 'quote.origin.messageId', 300),
      nodeKey: str(origin.nodeKey, 'quote.origin.nodeKey', 500),
      turn: origin.turn === null || origin.turn === undefined ? null : int(origin.turn, 'quote.origin.turn'),
      seq: origin.seq === null || origin.seq === undefined ? null : int(origin.seq, 'quote.origin.seq'),
    },
    anchor: {
      start: int(anchor.start, 'quote.anchor.start'),
      end: int(anchor.end, 'quote.anchor.end'),
      exact: str(anchor.exact, 'quote.anchor.exact'),
      prefix: str(anchor.prefix, 'quote.anchor.prefix', 100),
      suffix: str(anchor.suffix, 'quote.anchor.suffix', 100),
    },
  }
}

/**
 * 校验附件元信息（内容哈希必须由 PUT blobs 先行上传）。
 *
 * @param {unknown} value
 * @param {{maxAttachments: number, maxBlobBytes: number}} limits
 * @returns {{id: string, hash: string, mime: string, size: number, name: string}[]}
 */
function attachments(value, limits) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ProtocolError('INVALID_RECORD', 'attachments 必须是数组。')
  if (value.length > limits.maxAttachments) throw new ProtocolError('INVALID_RECORD', `一条记录最多 ${limits.maxAttachments} 个附件。`)
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ProtocolError('INVALID_RECORD', '附件必须是对象。')
    const hash = str(item.hash, 'attachment.hash', 64).toLowerCase()
    if (!HASH_RE.test(hash)) throw new ProtocolError('INVALID_RECORD', '附件哈希必须是 sha256 十六进制。')
    const mime = str(item.mime, 'attachment.mime', 100)
    if (!MIME_RE.test(mime)) throw new ProtocolError('INVALID_RECORD', '附件 MIME 只支持 png/jpeg/webp/gif。')
    const size = int(item.size, 'attachment.size')
    if (size <= 0 || size > limits.maxBlobBytes) throw new ProtocolError('INVALID_RECORD', `附件大小必须介于 1 与 ${limits.maxBlobBytes} 字节。`)
    return { id: str(item.id, 'attachment.id', ID_MAX), hash, mime, size, name: str(item.name, 'attachment.name', 200) }
  })
}

/**
 * 校验并规整一条 wire 记录（写入前的最后一道闸）。
 *
 * @param {unknown} value - 请求里的 record。
 * @param {{maxTextChars: number, maxAttachments: number, maxBlobBytes: number}} limits
 * @returns {{id: string, text: string, source: string, created_at: number, updated_at: number, quote: object|null, attachments: object[], deleted_at: number|null}}
 */
export function validateRecord(value, limits) {
  if (!value || typeof value !== 'object') throw new ProtocolError('INVALID_RECORD', 'record 必须是对象。')
  const id = str(value.id, 'record.id', ID_MAX)
  if (!id.trim()) throw new ProtocolError('INVALID_RECORD', 'record.id 不能为空。')
  const text = str(value.text, 'record.text', limits.maxTextChars)
  return {
    id,
    text,
    source: SOURCES.has(value.source) ? value.source : 'ui',
    created_at: int(value.created_at, 'record.created_at'),
    updated_at: int(value.updated_at, 'record.updated_at'),
    quote: value.quote === null || value.quote === undefined ? null : quote(value.quote),
    attachments: attachments(value.attachments, limits),
    deleted_at: value.deleted_at === null || value.deleted_at === undefined ? null : int(value.deleted_at, 'record.deleted_at'),
  }
}
