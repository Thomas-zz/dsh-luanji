/**
 * 手机网页 API 契约：登录限速、会话 Cookie、CSRF、列表搜索、
 * 以及「手机编辑走同一 ops 协议」的闭环。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLuanjiServer } from '../src/main.mjs'
import { generateToken, setPassword, sha256Hex } from '../src/auth.mjs'
import { openDatabase } from '../src/db.mjs'
import { loadConfig } from '../src/config.mjs'

let base = ''
let close = null
let cookie = ''
let csrf = ''
let cfg = null

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-server-web-'))
  cfg = { ...loadConfig({ LUANJI_DATA_DIR: dataDir }), port: 0 }
  const instance = await createLuanjiServer({ config: cfg })
  base = `http://127.0.0.1:${instance.port}`
  close = instance.close
  const db = openDatabase(cfg.dbFile)
  setPassword(db, 'correct-horse-9')
  db.close()
})

test.after(async () => { if (close) await close() })

async function web(method, pathname, body, headers = {}) {
  const options = { method, headers: { ...headers, cookie } , redirect: 'error' }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const res = await fetch(base + pathname, options)
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data, res }
}

test('静态页与安全头', async () => {
  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  const missing = await fetch(base + '/../etc/passwd')
  assert.notEqual(missing.status, 200)
})

test('未登录访问列表 401；口令错误 401；登录后可读', async () => {
  const anon = await web('GET', '/api/web/v1/records')
  assert.equal(anon.status, 401)
  const bad = await web('POST', '/api/web/v1/login', { password: 'wrong-pass' })
  assert.equal(bad.status, 401)
  const ok = await web('POST', '/api/web/v1/login', { password: 'correct-horse-9' })
  assert.equal(ok.status, 200)
  assert.ok(ok.data.csrf)
  assert.match(cookie, /^lj_session=/)
  assert.match(ok.res.headers.get('set-cookie'), /HttpOnly/)
  assert.match(ok.res.headers.get('set-cookie'), /SameSite=Strict/)
  csrf = ok.data.csrf
  const list = await web('GET', '/api/web/v1/records')
  assert.equal(list.status, 200)
})

test('会话写 ops 必须带 CSRF 头', async () => {
  const id = randomUUID()
  const now = Date.now()
  const record = { id, text: '手机写的一条', source: 'web', created_at: now, updated_at: now, quote: null, attachments: [], deleted_at: null }
  const blocked = await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record })
  assert.equal(blocked.status, 403)
  const allowed = await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, { 'x-csrf-token': csrf })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.data.ok, true)
})

test('列表：搜索与详情（正文/引用文本命中）', async () => {
  const ids = [randomUUID(), randomUUID()]
  for (const [index, id] of ids.entries()) {
    const now = Date.now()
    const record = {
      id, text: index === 0 ? '埃塞俄比亚的咖啡豆' : '别的记录', source: 'web', created_at: now, updated_at: now,
      quote: index === 1 ? { id: randomUUID(), text: '引用里的关键词所在句', origin: { role: 'assistant', model: 'M' }, anchor: { start: 0, end: 3, exact: '引用里的' } } : null,
      attachments: [], deleted_at: null,
    }
    const res = await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, { 'x-csrf-token': csrf })
    assert.equal(res.data.ok, true)
  }
  const hitText = await web('GET', '/api/web/v1/records?q=' + encodeURIComponent('咖啡豆'))
  assert.equal(hitText.data.total, 1)
  assert.equal(hitText.data.records[0].id, ids[0])
  const hitQuote = await web('GET', '/api/web/v1/records?q=' + encodeURIComponent('关键词'))
  assert.equal(hitQuote.data.total, 1)
  assert.equal(hitQuote.data.records[0].id, ids[1])
  const detail = await web('GET', '/api/web/v1/records/' + ids[0])
  assert.equal(detail.data.record.text, '埃塞俄比亚的咖啡豆')
  assert.ok(detail.data.record.rev >= 1)
  const none = await web('GET', '/api/web/v1/records/' + randomUUID())
  assert.equal(none.status, 404)
})

test('手机删除 → 旧 baseRev 编辑得到冲突（不静默覆盖）', async () => {
  const id = randomUUID()
  const now = Date.now()
  const record = { id, text: '共同基础', source: 'web', created_at: now, updated_at: now, quote: null, attachments: [], deleted_at: null }
  await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record }, { 'x-csrf-token': csrf })
  const del = await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'delete' }, { 'x-csrf-token': csrf })
  assert.equal(del.data.ok, true)
  const stale = await web('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 1, kind: 'put', record: { ...record, text: '旧版本复活' } }, { 'x-csrf-token': csrf })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.code, 'REV_CONFLICT')
  // 删除后不再出现在列表
  const list = await web('GET', '/api/web/v1/records?q=' + encodeURIComponent('共同基础'))
  assert.equal(list.data.total, 0)
})

test('登录失败限速：窗口内连续失败后 429', async () => {
  cookie = '' // 不带会话
  let limited = false
  for (let i = 0; i < 15; i++) {
    const res = await web('POST', '/api/web/v1/login', { password: 'nope-nope' })
    if (res.status === 429) { limited = true; break }
  }
  assert.equal(limited, true)
})

test('session：刷新后取回 CSRF 令牌；未登录 401', async () => {
  // 前面测试的会话可能因限速测试被清空：重新登录
  cookie = ''
  const login = await web('POST', '/api/web/v1/login', { password: 'correct-horse-9' })
  assert.equal(login.status, 429, '限速窗口内应仍被拒绝（验证限速持续生效）')
  // 直接构造一个新会话（绕过限速，验证 session 端点本身）
  const { createSession } = await import('../src/auth.mjs')
  const db = openDatabase(cfg.dbFile)
  const session = createSession(db, 3600_000)
  db.close()
  cookie = 'lj_session=' + session.id
  const restored = await web('GET', '/api/web/v1/session')
  assert.equal(restored.status, 200)
  assert.equal(restored.data.csrf, session.csrf)
  const anon = await web('GET', '/api/web/v1/session')
  cookie = ''
  const anonResult = await web('GET', '/api/web/v1/session')
  assert.equal(anonResult.status, 401)
})
