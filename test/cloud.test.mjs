/**
 * 云端同步：配置解析、拉取合并、推送映射与错误处理。
 *
 * 用本机 http 服务模拟「乱记兼容」数据服务（block6 的 /api/luanji/* 契约），
 * 不访问外网；记录只写临时目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../host/store.js'
import { createCloudService, normalizeCloudConfig, cloudHost } from '../host/cloud.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-cloud-'))
  return createStore({ dataDir: dir })
}

async function fakeService(handlers) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      calls.push(entry)
      const handler = handlers[`${req.method} ${req.url}`]
      if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
      const result = handler(entry, res)
      if (result === null) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, calls, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('normalizeCloudConfig：只接受 http(s)，规整请求头与超时', () => {
  assert.equal(normalizeCloudConfig(null), null)
  assert.equal(normalizeCloudConfig({ url: 'ftp://x' }), null)
  assert.equal(normalizeCloudConfig({ url: 'not-a-url' }), null)
  const token = normalizeCloudConfig({ url: 'https://zjuan.club/', token: 'abc' })
  assert.equal(token.url, 'https://zjuan.club')
  assert.equal(token.headers.Authorization, 'Bearer abc')
  assert.equal(token.timeoutMs, 15000)
  const both = normalizeCloudConfig({ url: 'https://x.test', cookie: 'a=b', headers: { 'X-Trace': '1' }, timeoutMs: 999999 })
  assert.equal(both.headers.Cookie, 'a=b')
  assert.equal(both.headers['X-Trace'], '1')
  assert.equal(both.timeoutMs, 60000)
  assert.equal(cloudHost('https://zjuan.club/api'), 'zjuan.club')
})

test('未配置时保持本地：status 仅报未配置，pull/push 抛错', async () => {
  const service = createCloudService({ config: undefined, store: tempStore() })
  assert.equal(service.configured, false)
  assert.deepEqual({ configured: service.status().configured, url: service.status().url }, { configured: false, url: '' })
  await assert.rejects(() => service.pull(), /还没有配置云端服务/)
  await assert.rejects(() => service.push(), /还没有配置云端服务/)
})

test('pull：带鉴权头拉取，跳过引用标记、附上图片、导入草稿', async () => {
  const store = tempStore()
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
  const service = await fakeService({
    'GET /api/luanji/state': () => ({
      records: [
        { id: '11111111-1111-4111-8111-111111111111', text: '第一条〔图:shot01〕', source: 'web', created_at: 1700000000000, updated_at: 1700000001000 },
        { id: '22222222-2222-4222-8222-222222222222', text: '第二条', source: 'web', created_at: 1700000002000, updated_at: 1700000002000 },
      ],
      draft: '云端草稿',
    }),
    'GET /api/luanji/images': () => ({ images: [{ id: 'shot01', data: dataUrl }] }),
  })
  try {
    const cloud = createCloudService({ config: { url: service.url, token: 'secret' }, store })
    const result = await cloud.pull()
    assert.deepEqual({ added: result.added, updated: result.updated, skipped: result.skipped, images: result.images, draft: result.draft }, { added: 2, updated: 0, skipped: 0, images: 1, draft: true })
    const first = store.get('11111111-1111-4111-8111-111111111111')
    assert.equal(first.text, '第一条')
    assert.equal(first.images.length, 1)
    assert.equal(first.images[0].id, 'shot01')
    assert.equal(first.images[0].data, dataUrl)
    assert.equal(store.state().draft, '云端草稿')
    assert.equal(store.count, 2)
    assert.equal(service.calls[0].headers.authorization, 'Bearer secret')
    const meta = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'cloud-sync.json'), 'utf8'))
    assert.equal(meta.lastResult.direction, 'pull')
    assert.ok(meta.lastPullAt > 0)
  } finally { await service.close() }
})

test('pull：同 id 只按 updated_at 更新，旧数据不覆盖本机新内容', async () => {
  const store = tempStore()
  const id = '33333333-3333-4333-8333-333333333333'
  const local = store.add({ id, text: '本机较新' })
  const service = await fakeService({
    'GET /api/luanji/state': () => ({
      records: [
        { id, text: '云端较旧', created_at: local.created_at, updated_at: local.updated_at - 1000 },
        { id: '44444444-4444-4444-8444-444444444444', text: '新的', created_at: 1, updated_at: 2 },
      ],
    }),
    'GET /api/luanji/images': () => ({ images: [] }),
  })
  try {
    const cloud = createCloudService({ config: { url: service.url }, store })
    const result = await cloud.pull()
    assert.deepEqual({ added: result.added, updated: result.updated, skipped: result.skipped }, { added: 1, updated: 0, skipped: 1 })
    assert.equal(store.get(id).text, '本机较新')
    assert.equal(store.get(id).updated_at, local.updated_at)
  } finally { await service.close() }
})

test('pull：超长正文跳过、图片端点失败不影响文字同步', async () => {
  const store = tempStore()
  const service = await fakeService({
    'GET /api/luanji/state': () => ({ records: [{ id: '55555555-5555-4555-8555-555555555555', text: 'x'.repeat(20001), created_at: 1, updated_at: 1 }, { id: '66666666-6666-4666-8666-666666666666', text: '可以收下', created_at: 1, updated_at: 1 }] }),
  })
  try {
    const cloud = createCloudService({ config: { url: service.url }, store })
    const result = await cloud.pull()
    assert.equal(result.added, 1)
    assert.equal(result.skipped, 1)
    assert.match(result.imagesWarning, /云端请求失败|云端返回/)
  } finally { await service.close() }
})

test('pull：HTTP 401 明确报错，并记录到同步元数据', async () => {
  const store = tempStore()
  const service = await fakeService({})
  try {
    const cloud = createCloudService({ config: { url: service.url }, store })
    await assert.rejects(() => cloud.pull(), /云端请求失败：not found/)
    cloud.recordError(new Error('登录已过期'))
    const meta = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'cloud-sync.json'), 'utf8'))
    assert.equal(meta.lastError, '登录已过期')
    assert.ok(meta.lastErrorAt > 0)
  } finally { await service.close() }
})

test('push：只推纯文本记录，图片写成短 id 标记，引用记录留在本机', async () => {
  const store = tempStore()
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
  const plain = store.add({ text: '要推到云端的正文', images: [{ id: 'local-image-id', data: dataUrl, name: '图' }], source: 'ui' })
  const quoted = store.add({
    text: '带着自己的想法',
    quote: { text: '被引用的原文', origin: { role: 'assistant', model: 'deepseek', sessionId: 's1', sessionTitle: '对话' }, anchor: { exact: '被引用的原文', start: 0, end: 6, prefix: '', suffix: '' } },
  })
  assert.ok(quoted.quote)
  const service = await fakeService({
    'POST /api/luanji/import': (entry) => ({ added: entry.body.records.length, updated: 0 }),
  })
  try {
    const cloud = createCloudService({ config: { url: service.url, headers: { Cookie: 'session=abc' } }, store })
    const result = await cloud.push()
    assert.equal(result.records, 1)
    assert.equal(result.images, 1)
    assert.equal(result.skippedQuoted, 1)
    assert.equal(service.calls.length, 1)
    const body = service.calls[0].body
    assert.equal(body.records.length, 1)
    assert.equal(body.records[0].id, plain.id)
    assert.match(body.records[0].text, /^要推到云端的正文\n\n〔图:[a-f0-9]{10}〕$/)
    const marker = body.records[0].text.match(/〔图:([a-f0-9]{10})〕/)[1]
    assert.equal(body.images.length, 1)
    assert.equal(body.images[0].id, marker)
    assert.equal(body.images[0].data, dataUrl)
    assert.equal(service.calls[0].headers.cookie, 'session=abc')
    const meta = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'cloud-sync.json'), 'utf8'))
    assert.equal(meta.lastResult.direction, 'push')
  } finally { await service.close() }
})

test('push：没有可推送记录时不发请求', async () => {
  const store = tempStore()
  const service = await fakeService({})
  try {
    const cloud = createCloudService({ config: { url: service.url }, store })
    const result = await cloud.push()
    assert.deepEqual({ records: result.records, added: result.added, updated: result.updated }, { records: 0, added: 0, updated: 0 })
    assert.equal(service.calls.length, 0)
  } finally { await service.close() }
})
