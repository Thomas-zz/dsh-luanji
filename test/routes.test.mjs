/**
 * routes.js 集成自测：模拟 req/res，把 HTTP 面完整打一遍。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStore } from '../host/store.js'
import * as intelligence from '../host/search.js'
import { createHandler } from '../host/routes.js'
import { apply } from '../index.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-routes-'))
  return createStore({ dataDir: dir })
}

/** 极简 req/res 桩。 */
function mockReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
  } else {
    queueMicrotask(() => req.emit('end'))
  }
  return req
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
      return this
    },
    end(chunk) {
      this.body = chunk ?? ''
      this.done = true
      this.resolve()
    },
  }
  res.promise = new Promise((resolve) => {
    res.resolve = resolve
  })
  return res
}

async function call(handler, method, url, body) {
  const req = mockReq(method, url, body)
  const res = mockRes()
  await handler(req, res)
  await res.promise
  return res
}

test('宿主配置可隔离笔记目录供真实 Web 集成验证', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-host-config-'))
  let handler
  const ctx = { effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler } }, tools: { register() {} } }
  apply(ctx, { dataDir })
  const response = await call(handler, 'POST', '/dsh-luanji/notes', { text: '隔离验收' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'notes.json'), 'utf8')).records[0].text, '隔离验收')
})

test('state / notes / draft 全链路', async () => {
  const store = tempStore()
  const handler = createHandler(store, intelligence)

  let res = await call(handler, 'GET', '/dsh-luanji/state')
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).count, 0)

  res = await call(handler, 'POST', '/dsh-luanji/notes', { text: '第一张', source: 'ui' })
  const record = JSON.parse(res.body).record
  assert.equal(record.text, '第一张')

  res = await call(handler, 'PUT', '/dsh-luanji/notes/' + record.id, { text: '第一张（续）' })
  assert.equal(JSON.parse(res.body).record.text, '第一张（续）')

  res = await call(handler, 'PUT', '/dsh-luanji/draft', { text: '半句话' })
  assert.equal(JSON.parse(res.body).draft, '半句话')

  res = await call(handler, 'GET', '/dsh-luanji/state')
  const state = JSON.parse(res.body)
  assert.equal(state.count, 1)
  assert.equal(state.draft, '半句话')
  assert.equal(state.records[0].text, '第一张（续）')

  res = await call(handler, 'DELETE', '/dsh-luanji/notes/' + record.id)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(store.count, 0)
})

test('search / flip / export / import', async () => {
  const store = tempStore()
  const handler = createHandler(store, intelligence)

  await call(handler, 'POST', '/dsh-luanji/notes', { text: '把 dsh 插件做成乱记的样子' })
  await call(handler, 'POST', '/dsh-luanji/notes', { text: '买咖啡豆' })

  const search = await call(handler, 'GET', '/dsh-luanji/search?q=' + encodeURIComponent('dsh 插件'))
  assert.equal(JSON.parse(search.body).records.length, 1)

  const flip = await call(handler, 'GET', '/dsh-luanji/flip')
  assert.ok(JSON.parse(flip.body).record)

  const exported = await call(handler, 'GET', '/dsh-luanji/export')
  assert.match(exported.headers['content-disposition'], /luanji-notes\.json/)
  const payload = JSON.parse(exported.body)
  assert.equal(payload.records.length, 2)

  // 带回：模拟乱记 Web 版导出（多一张新纸 + 更新旧纸）
  const web = {
    v: 2,
    records: [
      ...payload.records,
      { id: 'web-1', text: '网页版记的一句话', created_at: 1, updated_at: 2, source: 'web' },
    ],
  }
  const imported = await call(handler, 'POST', '/dsh-luanji/import', web)
  const result = JSON.parse(imported.body)
  assert.equal(result.added, 1)
  assert.equal(result.count, 3)
})

test('坏请求与 404', async () => {
  const store = tempStore()
  const handler = createHandler(store, intelligence)

  const empty = await call(handler, 'POST', '/dsh-luanji/notes', { text: '' })
  assert.equal(empty.statusCode, 500)
  assert.match(JSON.parse(empty.body).error, /先写一下/)

  const missing = await call(handler, 'GET', '/dsh-luanji/nope')
  assert.equal(missing.statusCode, 404)
})

test('引用记录 HTTP 闭环：协议、独立来源、图片草稿和提交清理', async () => {
  const store = tempStore(), handler = createHandler(store, intelligence)
  const initial = JSON.parse((await call(handler, 'GET', '/dsh-luanji/state')).body)
  assert.equal(initial.schemaVersion, 2)
  const quote = { text: '被划选的原句', origin: { role: 'assistant', model: '模型 A', sessionId: 'session-a', nodeKey: 'a', seq: 15 }, anchor: { exact: '被划选的原句', start: 0, end: 7 } }
  await call(handler, 'PUT', '/dsh-luanji/draft', { key: 'quote', draft: { text: '自己的想法', quote } })
  const res = JSON.parse((await call(handler, 'POST', '/dsh-luanji/notes', { id: 'stable-request', text: '自己的想法', quote, draftKey: 'quote' })).body)
  assert.equal(res.record.quote.origin.model, '模型 A')
  assert.equal(res.record.quote.origin.seq, 15)
  assert.equal(res.record.source, 'selection')
  assert.equal(store.state().drafts.quote.quote, null)
  const again = JSON.parse((await call(handler, 'POST', '/dsh-luanji/notes', { id: 'stable-request', quote })).body)
  assert.equal(again.record.id, res.record.id)
  assert.equal(store.count, 1)
})

test('开发页面不在普通宿主模式暴露', async () => {
  const handler = createHandler(tempStore(), intelligence, { pkgDir: process.cwd() })
  const response = await call(handler, 'GET', '/dsh-luanji/__dev__')
  assert.equal(response.statusCode, 404)
})
