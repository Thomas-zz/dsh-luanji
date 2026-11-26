/**
 * 同步协议 v1 契约测试：认证、info、ops 幂等/冲突、changes 分页、附件。
 * 全部用临时数据目录 + 随机端口的本地 HTTP 服务，不访问外网。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createLuanjiServer } from '../src/main.mjs'
import { generateToken, sha256Hex } from '../src/auth.mjs'
import { openDatabase } from '../src/db.mjs'
import { loadConfig } from '../src/config.mjs'

let base = ''
let token = ''
let close = null
let cfg = null

/** 起一个干净服务（每个测试文件共享一个，测试间用独立 recordId 隔离）。 */
test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-server-api-'))
  cfg = { ...loadConfig({ LUANJI_DATA_DIR: dataDir }), port: 0 }
  const instance = await createLuanjiServer({ config: cfg })
  base = `http://127.0.0.1:${instance.port}`
  close = instance.close
  const db = openDatabase(cfg.dbFile)
  token = generateToken()
  db.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('测试设备', sha256Hex(token), token.slice(0, 11), Date.now())
  db.close()
})

test.after(async () => { if (close) await close() })

/** 带设备 Token 的 API 调用。 */
async function call(method, pathname, body, extraHeaders = {}) {
  const headers = { 'x-luanji-protocol': '1', ...extraHeaders }
  let payload
  if (body !== undefined && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  } else payload = body
  const res = await fetch(base + pathname, { method, headers, body: payload, redirect: 'error' })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data }
}

const authHeaders = () => ({ authorization: 'Bearer ' + token })

function sampleRecord(id = randomUUID(), text = '一条笔记') {
  const now = Date.now()
  return { id, text, source: 'ui', created_at: now, updated_at: now, quote: null, attachments: [], deleted_at: null }
}

test('未认证一律 401，且不泄漏数据', async () => {
  const res = await call('GET', '/api/sync/v1/info')
  assert.equal(res.status, 401)
  assert.equal(res.data.code, 'UNAUTHORIZED')
  const ops = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: randomUUID(), baseRev: 0, kind: 'put', record: sampleRecord() })
  assert.equal(ops.status, 401)
})

test('info：协议版本、空间身份、数量与限制', async () => {
  const res = await call('GET', '/api/sync/v1/info', undefined, authHeaders())
  assert.equal(res.status, 200)
  assert.equal(res.data.protocolVersion, 1)
  assert.ok(res.data.spaceId)
  assert.ok(res.data.generation)
  assert.equal(res.data.activeCount, 0)
  assert.equal(res.data.limits.maxTextChars, 20000)
  assert.equal(res.data.limits.maxAttachments, 6)
  assert.equal(res.data.limits.maxBlobBytes, 2097152)
})

test('ops：baseRev=0 创建成功，返回 rev/seq', async () => {
  const id = randomUUID()
  const res = await call('POST', '/api/sync/v1/ops', { spaceId: (await info()).spaceId, opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, '创建') }, authHeaders())
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true)
  assert.equal(res.data.rev, 1)
  assert.ok(res.data.seq > 0)
})

async function info() {
  return (await call('GET', '/api/sync/v1/info', undefined, authHeaders())).data
}

test('ops：错误 Token/格式被拒', async () => {
  const bad = await fetch(base + '/api/sync/v1/info', { headers: { authorization: 'Bearer lj_nope' } })
  assert.equal(bad.status, 401)
  const malformed = await call('POST', '/api/sync/v1/ops', { opId: randomUUID() }, authHeaders())
  assert.ok([200, 400].includes(malformed.status))
  assert.equal(malformed.data.ok, false)
})

test('ops：baseRev 过期返回 409 + 远端当前版本', async () => {
  const id = randomUUID()
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, 'v1') }, authHeaders())
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'put', record: sampleRecord(id, 'v2') }, authHeaders())
  // 拿着过期的 baseRev=1 再写一次
  const res = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'put', record: sampleRecord(id, 'stale') }, authHeaders())
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'REV_CONFLICT')
  assert.equal(res.data.remote.rev, 2)
  assert.equal(res.data.remote.record.text, 'v2')
})

test('ops：同 opId 同请求体幂等重放（A6 服务端半边）', async () => {
  const id = randomUUID()
  const opId = randomUUID()
  const op = { opId, recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, '只此一次') }
  const first = await call('POST', '/api/sync/v1/ops', op, authHeaders())
  assert.equal(first.data.ok, true)
  const again = await call('POST', '/api/sync/v1/ops', op, authHeaders())
  assert.deepEqual(again.data, first.data)
  // 变更日志里只有一条业务修改
  const changes = await call('GET', '/api/sync/v1/changes?cursor=0&limit=1000', undefined, authHeaders())
  const mine = changes.data.changes.filter((c) => c.id === id)
  assert.equal(mine.length, 1)
})

test('ops：同 opId 不同请求体被拒绝', async () => {
  const id = randomUUID()
  const opId = randomUUID()
  const first = await call('POST', '/api/sync/v1/ops', { opId, recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, 'A') }, authHeaders())
  assert.equal(first.data.ok, true)
  const clash = await call('POST', '/api/sync/v1/ops', { opId, recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, 'B') }, authHeaders())
  assert.equal(clash.status, 409)
  assert.equal(clash.data.code, 'OP_BODY_MISMATCH')
})

test('ops：删除链路（成功 → 已删除 → 不存在）与墓碑进变更日志', async () => {
  const id = randomUUID()
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id) }, authHeaders())
  const del = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'delete' }, authHeaders())
  assert.equal(del.data.ok, true)
  assert.equal(del.data.rev, 2)
  const again = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 2, kind: 'delete' }, authHeaders())
  assert.equal(again.data.ok, false)
  assert.equal(again.data.code, 'ALREADY_DELETED')
  const missing = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: randomUUID(), baseRev: 3, kind: 'delete' }, authHeaders())
  assert.equal(missing.data.ok, false)
  assert.equal(missing.data.code, 'NOT_FOUND')
  // 墓碑在变更日志里（cursor=0 重放包含已删除）
  const changes = await call('GET', '/api/sync/v1/changes?cursor=0&limit=1000', undefined, authHeaders())
  const tombstone = changes.data.changes.findLast((c) => c.id === id)
  assert.equal(tombstone.op, 'delete')
  assert.ok(tombstone.record.deleted_at > 0)
  // 墓碑之上可以复活（put 带 baseRev=墓碑 rev）
  const revive = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 2, kind: 'put', record: sampleRecord(id, '复活') }, authHeaders())
  assert.equal(revive.data.ok, true)
  assert.equal(revive.data.rev, 3)
})

test('ops：墓碑后拿旧 baseRev=0 的 put 不复活旧记录', async () => {
  const id = randomUUID()
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id) }, authHeaders())
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'delete' }, authHeaders())
  // 另一台旧设备重新“创建”同 ID
  const staleCreate = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, '旧设备复活') }, authHeaders())
  assert.equal(staleCreate.status, 409)
  assert.equal(staleCreate.data.code, 'REV_CONFLICT')
})

test('ops：引用完整保存与回放（origin/anchor 全字段）', async () => {
  const id = randomUUID()
  const now = Date.now()
  const record = {
    id, text: '我的想法', source: 'selection', created_at: now, updated_at: now,
    quote: {
      id: randomUUID(), text: '被引用的原文',
      origin: { role: 'assistant', model: 'DeepSeek V3.2', sessionId: 's-1', sessionTitle: '一次讨论', messageId: 'm-9', nodeKey: 'assistant-2', turn: 3, seq: 42 },
      anchor: { start: 10, end: 17, exact: '被引用的原文', prefix: '前', suffix: '后' },
    },
    attachments: [], deleted_at: null,
  }
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, authHeaders())
  const changes = await call('GET', '/api/sync/v1/changes?cursor=0&limit=1000', undefined, authHeaders())
  const applied = changes.data.changes.findLast((c) => c.id === id)
  assert.deepEqual(applied.record.quote, record.quote)
  assert.equal(applied.record.source, 'selection')
})

test('ops：附件未上传给结构化 BLOB_MISSING，不当成成功', async () => {
  const id = randomUUID()
  const hash = createHash('sha256').update('not-uploaded').digest('hex')
  const record = { ...sampleRecord(id), attachments: [{ id: randomUUID(), hash, mime: 'image/png', size: 11, name: '图.png' }] }
  const res = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, authHeaders())
  assert.equal(res.data.ok, false)
  assert.equal(res.data.code, 'BLOB_MISSING')
  assert.deepEqual(res.data.missing, [hash])
})

test('ops：记录校验拒绝超长与非法字段', async () => {
  const long = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: randomUUID(), baseRev: 0, kind: 'put', record: sampleRecord(randomUUID(), 'x'.repeat(20001)) }, authHeaders())
  assert.equal(long.status, 400)
  assert.equal(long.data.code, 'INVALID_RECORD')
  const badKind = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: randomUUID(), baseRev: 0, kind: 'patch', record: sampleRecord() }, authHeaders())
  assert.equal(badKind.status, 400)
})

test('ops：spaceId/generation 不匹配返回 SPACE_CHANGED', async () => {
  const id = randomUUID()
  const res = await call('POST', '/api/sync/v1/ops', { spaceId: randomUUID(), opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id) }, authHeaders())
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'SPACE_CHANGED')
  const changes = await call('GET', '/api/sync/v1/changes?cursor=0&generation=wrong', undefined, authHeaders())
  assert.equal(changes.status, 409)
  assert.equal(changes.data.code, 'SPACE_CHANGED')
})

test('changes：分页上界固定、游标推进、hasMore 正确', async () => {
  // 本测试专用的 id 前缀，避免与其它测试数据混淆
  const prefix = randomUUID()
  for (let i = 0; i < 7; i++) {
    const id = prefix + '-' + i
    const res = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: sampleRecord(id, '分页 ' + i) }, authHeaders())
    assert.equal(res.data.ok, true, JSON.stringify(res.data))
  }
  // 新分页轮次：第一页确定 upperBound
  const page1 = await call('GET', '/api/sync/v1/changes?cursor=0&limit=3', undefined, authHeaders())
  assert.equal(page1.data.changes.length, 3)
  assert.equal(page1.data.hasMore, true)
  const upper = page1.data.upperBound
  // 分页期间写入新数据：不应出现在本轮
  await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: prefix + '-late', baseRev: 0, kind: 'put', record: sampleRecord(prefix + '-late', '迟到') }, authHeaders())
  const page2 = await call('GET', `/api/sync/v1/changes?cursor=${page1.data.nextCursor}&limit=3&upperBound=${upper}`, undefined, authHeaders())
  assert.equal(page2.data.upperBound, upper)
  assert.ok(page2.data.changes.every((c) => c.seq <= upper))
  assert.ok(!page2.data.changes.some((c) => c.id === prefix + '-late'))
  // 推进到本轮末尾
  let cursor = page2.data.nextCursor
  let guard = 0
  while (true) {
    const page = await call('GET', `/api/sync/v1/changes?cursor=${cursor}&limit=100&upperBound=${upper}`, undefined, authHeaders())
    cursor = page.data.nextCursor
    if (!page.data.hasMore) break
    if (++guard > 10) throw new Error('分页未收敛')
  }
  assert.equal(cursor, upper)
  // 下一轮从 upperBound 之后开始，能看到迟到数据
  const next = await call('GET', `/api/sync/v1/changes?cursor=${cursor}&limit=100`, undefined, authHeaders())
  assert.ok(next.data.changes.some((c) => c.id === prefix + '-late'))
})

test('blobs：哈希校验、幂等、超限与下载', async () => {
  const bytes = Buffer.from('png-ish-bytes-0123456789')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const put = await fetch(base + '/api/sync/v1/blobs/' + hash, { method: 'PUT', headers: { ...authHeaders(), 'content-type': 'image/png' }, body: bytes })
  assert.equal(put.status, 200)
  assert.equal((await put.json()).ok, true)
  // 幂等
  const again = await fetch(base + '/api/sync/v1/blobs/' + hash, { method: 'PUT', headers: { ...authHeaders(), 'content-type': 'image/png' }, body: bytes })
  assert.equal((await again.json()).deduplicated, true)
  // 内容不符
  const wrong = await call('PUT', '/api/sync/v1/blobs/' + hash, Buffer.from('different'), authHeaders())
  assert.equal(wrong.status, 400)
  assert.equal(wrong.data.code, 'INVALID_HASH')
  // 超单文件上限
  const huge = Buffer.alloc(2097153, 1)
  const hugeHash = createHash('sha256').update(huge).digest('hex')
  const tooLarge = await call('PUT', '/api/sync/v1/blobs/' + hugeHash, huge, authHeaders())
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.data.code, 'PAYLOAD_TOO_LARGE')
  // 下载
  const get = await fetch(base + '/api/sync/v1/blobs/' + hash, { headers: authHeaders() })
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes)
  // 未认证下载
  const anon = await fetch(base + '/api/sync/v1/blobs/' + hash)
  assert.equal(anon.status, 401)
  // 附件上传后引用成功
  const id = randomUUID()
  const record = { ...sampleRecord(id), attachments: [{ id: randomUUID(), hash, mime: 'image/png', size: bytes.length, name: '图.png' }] }
  const res = await call('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, authHeaders())
  assert.equal(res.data.ok, true, JSON.stringify(res.data))
})

test('安全：未知路径 404、协议头不兼容 501、不泄漏内部细节', async () => {
  const unknown = await call('GET', '/api/sync/v1/whatever', undefined, authHeaders())
  assert.equal(unknown.status, 404)
  const future = await call('GET', '/api/sync/v1/info', undefined, { ...authHeaders(), 'x-luanji-protocol': '2' })
  assert.equal(future.status, 501)
  assert.equal(future.data.code, 'PROTOCOL_UNSUPPORTED')
  const traversal = await fetch(base + '/api/sync/v1/blobs/..%2f..%2fetc%2fpasswd', { headers: authHeaders() })
  assert.equal(traversal.status, 404)
})
