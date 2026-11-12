/**
 * 云同步 v1 端到端验收：真实 luanji-sync-server（临时目录 + 随机端口）×
 * 两个隔离客户端目录 + 模拟网络故障。对应交付检查表 A1–A12、A15。
 *
 * A13（v2 升级）在 host.test.mjs；A14（备份恢复）在 server/test/admin.test.mjs；
 * A16（恶意请求）在 server/test/api.test.mjs。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from '../host/store.js'
import { createSyncService } from '../host/sync.js'
import { writeSyncConfig } from '../host/sync-config.js'
import { createHandler } from '../host/routes.js'
import * as intelligence from '../host/search.js'
import { createLuanjiServer } from '../server/src/main.mjs'
import { generateToken, sha256Hex } from '../server/src/auth.mjs'
import { openDatabase } from '../server/src/db.mjs'
import { createBackupArchive, restoreFromArchive } from '../server/src/backup.mjs'
import { loadConfig } from '../server/src/config.mjs'

// ── 工具 ───────────────────────────────────────────────
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const pngBytes = Buffer.from(tinyPng.slice(tinyPng.indexOf(',') + 1), 'base64')

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

/** 客户端 = 独立数据目录 + store + 同步引擎（模拟一台设备）。 */
function makeClient(name) {
  const dir = tempDir('luanji-client-')
  const store = createStore({ dataDir: dir })
  const sync = createSyncService({ store })
  return { name, dir, store, sync }
}

/** 拦截全局 fetch（只影响本进程的同步引擎；服务端不使用 fetch）。 */
function patchFetch(wrap) {
  const original = globalThis.fetch
  globalThis.fetch = wrap(original)
  return () => { globalThis.fetch = original }
}

let base = ''
let serverHandle = null
let serverCfg = null
let token = ''
const PORT = 20000 + Math.floor(Math.random() * 20000)

/** 起服务（固定端口，支持 A3 的停机/恢复）。 */
async function startServer() {
  serverCfg = { ...loadConfig({ LUANJI_DATA_DIR: serverDataDir, LUANJI_PORT: String(PORT), LUANJI_HOST: '127.0.0.1' }) }
  const instance = await createLuanjiServer({ config: serverCfg })
  base = `http://127.0.0.1:${instance.port}`
  return instance
}

let serverDataDir = ''

test.before(async () => {
  serverDataDir = tempDir('luanji-sync-e2e-')
  serverHandle = await startServer()
  const db = openDatabase(serverCfg.dbFile)
  token = generateToken()
  db.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('e2e 设备', sha256Hex(token), token.slice(0, 11), Date.now())
  db.close()
})

test.after(async () => {
  if (serverHandle) await serverHandle.close()
})

/** 直连服务（模拟手机网页/其他设备的 API 行为）。 */
async function api(method, pathname, body) {
  const headers = { authorization: 'Bearer ' + token, 'x-luanji-protocol': '1' }
  let payload
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(base + pathname, { method, headers, body: payload })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function wireRecord(id, text) {
  const now = Date.now()
  return { id, text, source: 'web', created_at: now, updated_at: now, quote: null, attachments: [], deleted_at: null }
}

/** 服务端当前全部记录（经 changes 重放）。 */
async function serverRecords() {
  const map = new Map()
  let cursor = 0
  for (;;) {
    const res = await api('GET', `/api/sync/v1/changes?cursor=${cursor}&limit=100`)
    for (const change of res.data.changes) map.set(change.id, { ...change.record, rev: change.rev })
    cursor = res.data.nextCursor
    if (!res.data.hasMore) return map
  }
}

// ── A1：全新安装、未配置，无同步网络请求 ────────────────
test('A1 未配置时不联网，本地一切可用', async () => {
  const calls = []
  const restore = patchFetch((original) => async (...args) => { calls.push(String(args[0])); return original(...args) })
  try {
    const client = makeClient('A1')
    const record = client.store.add({ text: '本地第一条', images: [{ data: tinyPng, name: '图' }] })
    assert.ok(record)
    assert.equal(client.store.all().length, 1)
    const status = client.sync.status()
    assert.equal(status.configured, false)
    assert.equal(status.enabled, false)
    assert.equal(status.phase, 'off')
    await client.sync.testConnection()
    assert.equal(calls.length, 0, '未配置时不应有任何网络请求（含测试连接）')
  } finally { restore() }
})

// ── A2：仅测试连接，两边业务内容不变 ────────────────────
test('A2 测试连接只读：不上传、不修改', async () => {
  const client = makeClient('A2')
  client.store.add({ text: '只在本机' })
  writeSyncConfig(client.dir, { url: base, token, deviceName: 'A2' })
  const result = await client.sync.testConnection()
  assert.equal(result.ok, true)
  assert.equal(result.localCount, 1)
  assert.equal(typeof result.activeCount, 'number')
  // 服务端没有收到任何写、变更日志为空
  const records = await serverRecords()
  assert.equal(records.size, 0)
  // 本机内容不变、未绑定
  assert.equal(client.sync.status().bound, false)
  assert.equal(client.store.count, 1)
})

test('A2 测试连接的错误分类：地址不可达 / 认证失败 / 证书占位', async () => {
  const dead = await makeClient('A2-dead')
  writeSyncConfig(dead.dir, { url: 'http://127.0.0.1:1', token: 'lj_x', deviceName: 'dead' })
  const unreachable = await dead.sync.testConnection()
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.kind, 'network')

  const badTokenClient = makeClient('A2-badtoken')
  writeSyncConfig(badTokenClient.dir, { url: base, token: 'lj_wrong', deviceName: 'bad' })
  const auth = await badTokenClient.sync.testConnection()
  assert.equal(auth.ok, false)
  assert.equal(auth.kind, 'auth')

  const httpsClient = makeClient('A2-https')
  const httpsResult = await httpsClient.sync.testConnection({ url: 'https://notes.example.com', token: 'lj_x' })
  assert.equal(httpsResult.ok, false)
  assert.ok(['network', 'cert', 'http'].includes(httpsResult.kind))
})

// ── A3：离线编辑 → 恢复服务 → 其他设备收到且无重复 ──────
test('A3 电脑离线编辑再联网：本地立即可用，恢复后同步且无重复', async () => {
  const client = makeClient('A3')
  writeSyncConfig(client.dir, { url: base, token, deviceName: 'A3' })
  const enabled = await client.sync.enable({ url: base, token, deviceName: 'A3' })
  assert.equal(enabled.info.protocolVersion, 1)
  assert.equal(client.sync.status().enabled, true)

  // 停机：本地保存立即成功，同步进入等待网络
  await serverHandle.close()
  client.store.add({ text: '离线时写的一条' })
  assert.equal(client.store.count, 1) // 本地保存不受联网失败影响
  const offline = await client.sync.syncNow()
  assert.equal(['waiting', 'attention'].includes(offline.phase), true)
  assert.match(offline.lastError, /无法连接|不可达/)
  assert.equal(offline.pendingOps, 1) // 未同步内容保留

  // 恢复服务（同一数据目录、同一端口）
  serverHandle = await startServer()
  const online = await client.sync.syncNow()
  assert.equal(online.pendingOps, 0)
  const records = await serverRecords()
  assert.equal(records.size, 1)
  assert.equal([...records.values()][0].text, '离线时写的一条')

  // 另一台设备开启同步后收到，且只有一份
  const peer = makeClient('A3-peer')
  await peer.sync.enable({ url: base, token, deviceName: 'peer' })
  assert.equal(peer.store.count, 1)
  assert.equal(peer.store.all()[0].text, '离线时写的一条')
})

// ── A4：手机（第二客户端 API）创建/修改/删除，旧设备不复活 ─
test('A4 手机增改删传播，旧设备上线不复活已确认删除', async () => {
  const desktop = makeClient('A4')
  await desktop.sync.enable({ url: base, token, deviceName: 'desktop' })
  // 此刻 desktop 已同步（A3 的 1 条）
  const before = desktop.store.count

  // 手机创建 + 修改
  const id = randomUUID()
  let res = await api('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: 0, kind: 'put', record: wireRecord(id, '手机创建') })
  assert.equal(res.data.ok, true, JSON.stringify(res.data))
  const rev1 = res.data.rev
  res = await api('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: rev1, kind: 'put', record: wireRecord(id, '手机修改') })
  assert.equal(res.data.ok, true)
  await desktop.sync.syncNow()
  assert.equal(desktop.store.count, before + 1)
  assert.equal(desktop.store.get(id).text, '手机修改')

  // 手机删除；desktop 拉取后从 UI 消失（get 保留墓碑供同步用）
  res = await api('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: id, baseRev: res.data.rev, kind: 'delete' })
  assert.equal(res.data.ok, true)
  await desktop.sync.syncNow()
  assert.ok(!desktop.store.all().some((r) => r.id === id), '已删除记录不应出现在 UI')

  // 旧设备（尚未同步过删除的第三台）上线：不会复活已确认删除
  const stale = makeClient('A4-stale')
  await stale.sync.enable({ url: base, token, deviceName: 'stale' })
  assert.ok(!stale.store.all().some((r) => r.id === id))
  // 而且它不会把墓碑再次上传成新记录（无 pending put）
  assert.equal(stale.sync.status().pendingOps, 0)
})

// ── A5：同一条并发修改，双方版本可找回，其余继续同步 ────
test('A5 并发修改同一条：冲突双方保留，其他记录不受影响', async () => {
  const a = makeClient('A5a'), b = makeClient('A5b')
  await a.sync.enable({ url: base, token, deviceName: 'A' })
  const shared = a.store.add({ text: '共同基础' })
  await a.sync.syncNow()
  await b.sync.enable({ url: base, token, deviceName: 'B' })
  assert.equal(b.store.get(shared.id).text, '共同基础')

  // A 先改并同步
  a.store.update(shared.id, 'A 的修改')
  await a.sync.syncNow()
  // B 在没拉取 A 的修改前也改同一条
  b.store.update(shared.id, 'B 的修改')
  b.store.add({ text: 'B 顺手记的另一条' })
  await b.sync.syncNow()

  // B 端冲突进面板：本地与远端两个版本都在
  const conflicts = b.store.conflicts()
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].local.record.text, 'B 的修改')
  assert.equal(conflicts[0].remote.record.text, 'A 的修改')
  // 其余记录继续同步
  assert.equal(b.sync.status().pendingOps, 0, '冲突不阻塞其他记录')
  const serverMap = await serverRecords()
  assert.equal(serverMap.get(shared.id).text, 'A 的修改')
  assert.equal(serverMap.has(b.store.all().find((r) => r.text === 'B 顺手记的另一条').id), true)

  // B 选择「保留两份」：远端内容回原 ID，本地版本成为新记录并上传
  await b.sync.resolveConflict(shared.id, 'both')
  await new Promise((resolve) => setTimeout(resolve, 50))
  await b.sync.syncNow()
  assert.equal(b.store.get(shared.id).text, 'A 的修改')
  const copy = b.store.all().find((r) => r.text === 'B 的修改')
  assert.ok(copy, '本地版本以新 ID 保留')
  assert.notEqual(copy.id, shared.id)
  const finalMap = await serverRecords()
  assert.equal(finalMap.get(shared.id).text, 'A 的修改')
  assert.equal(finalMap.get(copy.id).text, 'B 的修改')
})

// ── A6：服务器提交后响应丢失，同 opId 重试不重复 ────────
test('A6 提交成功但响应丢失：重试同一 opId 只产生一次业务修改', async () => {
  const client = makeClient('A6')
  await client.sync.enable({ url: base, token, deviceName: 'A6' })
  client.store.add({ text: '只会出现一次的记录' })
  assert.equal(client.sync.status().pendingOps, 1)

  let dropped = false
  const restore = patchFetch((original) => async (input, init) => {
    const url = String(input)
    if (!dropped && init?.method === 'POST' && url.endsWith('/api/sync/v1/ops')) {
      // 服务端已处理，但把响应“丢”在读取阶段
      await original(input, init)
      dropped = true
      throw Object.assign(new Error('simulated connection drop'), { cause: { code: 'ECONNRESET' } })
    }
    return original(input, init)
  })
  try {
    const failed = await client.sync.syncNow()
    assert.equal(failed.pendingOps, 1, '响应丢失后操作仍在队列')
    assert.ok(failed.lastError)
  } finally { restore() }

  // 恢复后重试：同 opId 原样重放，服务端只落一次
  await client.sync.syncNow()
  assert.equal(client.sync.status().pendingOps, 0)
  const map = await serverRecords()
  const hits = [...map.values()].filter((r) => r.text === '只会出现一次的记录')
  assert.equal(hits.length, 1)
})

// ── A7：上传期间继续打字，新内容不被旧 ACK 标为完成 ─────
test('A7 上传过程中继续编辑：新旧内容都保留并先后同步', async () => {
  const client = makeClient('A7')
  await client.sync.enable({ url: base, token, deviceName: 'A7' })
  const record = client.store.add({ text: '第一版' })
  assert.equal(client.sync.status().pendingOps, 1)

  // 拦住 ops 响应直到测试放行
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const restore = patchFetch((original) => async (input, init) => {
    const res2 = await original(input, init)
    if (init?.method === 'POST' && String(input).endsWith('/api/sync/v1/ops')) await gate
    return res2
  })
  try {
    const inflight = client.sync.syncNow()
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 在途期间继续打字（新操作入队，不动旧操作快照）
    client.store.update(record.id, '上传期间继续打字的新内容')
    assert.equal(client.sync.status().pendingOps, 2)
    const during = JSON.parse(fs.readFileSync(path.join(client.dir, 'notes.json'), 'utf8'))
    assert.equal(during.records.find((r) => r.id === record.id).text, '上传期间继续打字的新内容', '新编辑立即可见')
    release()
    await inflight
    // 旧 ACK 只确认旧操作；新内容不被旧响应标为完成（队列清空 = 两个操作都各自确认过）
    const after = JSON.parse(fs.readFileSync(path.join(client.dir, 'notes.json'), 'utf8'))
    assert.equal(after.records.find((r) => r.id === record.id).text, '上传期间继续打字的新内容', '本地新内容未被旧响应清掉')
  } finally { restore() }

  await client.sync.syncNow()
  assert.equal(client.sync.status().pendingOps, 0)
  const map = await serverRecords()
  assert.equal(map.get(record.id).text, '上传期间继续打字的新内容')
  assert.equal(client.store.get(record.id).text, '上传期间继续打字的新内容')
})

// ── A8：附件上传/下载失败 → 待处理可重试，正文引用不丢 ──
test('A8 附件失败进入待下载状态，可重试且正文引用不丢', async () => {
  const a = makeClient('A8a'), b = makeClient('A8b')
  await a.sync.enable({ url: base, token, deviceName: 'A8a' })
  const quote = { text: '被引用的原话', origin: { role: 'assistant', model: 'M', sessionId: 's' }, anchor: { exact: '被引用的原话', start: 0, end: 6 } }
  const record = a.store.add({ text: '带图和引用的一条', images: [{ data: tinyPng, name: '小图' }], quote })
  await a.sync.syncNow()

  // B 拉取时图片下载被掐断
  const restore = patchFetch((original) => async (input, init) => {
    if (String(input).includes('/api/sync/v1/blobs/') && (!init || init.method === 'GET' || init.method === undefined)) {
      // PUT（上传）放行，GET（下载）失败一次
      if (init?.method === 'PUT') return original(input, init)
      throw Object.assign(new Error('blob download blocked'), { cause: { code: 'ECONNRESET' } })
    }
    return original(input, init)
  })
  try {
    await b.sync.enable({ url: base, token, deviceName: 'A8b' })
    const got = b.store.get(record.id)
    assert.ok(got, '记录本体（正文+引用）先落地')
    assert.equal(got.text, '带图和引用的一条')
    assert.equal(got.quote.text, '被引用的原话')
    assert.equal(got.images.length, 1)
    assert.equal(got.images[0].data, '', '附件处于明确待下载状态')
    assert.equal(b.store.missingBlobs()[Object.keys(b.store.missingBlobs())[0]] ? Object.keys(b.store.missingBlobs()).length : 0, 1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, 'notes.json'), 'utf8')).sync.missingBlobs !== undefined, true)
  } finally { restore() }

  // 网络恢复后重试下载成功，数据回填
  await b.sync.retryBlobs()
  await b.sync.syncNow()
  const filled = b.store.get(record.id)
  assert.equal(filled.images[0].data, tinyPng)
  assert.equal(Object.keys(b.store.missingBlobs()).length, 0)
})

// ── A9：首次两边都有数据 → 去重、保留差异、重跑不重复 ──
test('A9 首次双边合并：同 ID 同内容去重，不同内容保留两份，重跑稳定', async () => {
  const sameId = randomUUID()
  const diffId = randomUUID()
  // 云端先有两条（sameId 用固定时间戳，方便本机造出“同 ID 同内容”的真实同源数据）
  const sameStamp = Date.now()
  const sameWire = { ...wireRecord(sameId, '两边一样的内容'), created_at: sameStamp, updated_at: sameStamp }
  await api('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: sameId, baseRev: 0, kind: 'put', record: sameWire })
  await api('POST', '/api/sync/v1/ops', { opId: randomUUID(), recordId: diffId, baseRev: 0, kind: 'put', record: wireRecord(diffId, '云端的版本') })

  const client = makeClient('A9')
  // 用 importMany 注入与远端字节一致的记录（add 会生成新时间戳）
  client.store.importMany({ records: [{ id: sameId, text: '两边一样的内容', source: 'web', created_at: sameStamp, updated_at: sameStamp }] })
  assert.equal(client.store.get(sameId).id, sameId)
  client.store.add({ id: diffId, text: '本机的版本' })
  client.store.add({ text: '只在本机的一条' })
  const localIds = new Set(client.store.all().map((r) => r.id))
  const remoteNew = [...(await serverRecords()).values()].filter((r) => !r.deleted_at && !localIds.has(r.id)).length
  const expectedCount = client.store.count + remoteNew + 1 // +1 = 同 ID 差异的本地副本

  const enabled = await client.sync.enable({ url: base, token, deviceName: 'A9' })
  // 同 ID 同内容去重；同 ID 不同内容：远端回原 ID + 本地复制新 ID；只在本机的上传
  assert.equal(client.store.get(sameId).text, '两边一样的内容')
  assert.equal(client.store.get(diffId).text, '云端的版本')
  const localCopy = client.store.all().find((r) => r.text === '本机的版本')
  assert.ok(localCopy, '本地差异版本以新 ID 保留')
  assert.notEqual(localCopy.id, diffId)
  assert.equal(client.store.count, expectedCount)

  const map = await serverRecords()
  assert.equal(map.get(sameId).text, '两边一样的内容')
  assert.equal(map.get(diffId).text, '云端的版本')
  assert.equal(map.get(localCopy.id).text, '本机的版本')
  assert.equal(map.has(client.store.all().find((r) => r.text === '只在本机的一条').id), true)
  assert.equal(enabled.summary.conflicts, 0)

  // 重跑（关闭→再开启）：不新增重复或冲突副本
  const afterFirst = client.store.count
  client.sync.disable()
  await client.sync.enable({ url: base, token, deviceName: 'A9' })
  assert.equal(client.store.count, afterFirst, '重跑后记录数不变（无重复副本）')
  assert.equal(client.store.conflicts().length, 0)
})

// ── A10：服务恢复（generation 变化）→ 检测、不复用游标 ──
test('A10 服务从备份恢复：generation 变化被检测，游标不复用', async () => {
  const client = makeClient('A10')
  await client.sync.enable({ url: base, token, deviceName: 'A10' })
  client.store.add({ text: '恢复前写的' })
  await client.sync.syncNow()
  assert.equal(client.sync.status().phase, 'synced')

  // 停服务 → 备份 → 恢复（会轮换 generation）→ 重启
  await serverHandle.close()
  const db = openDatabase(serverCfg.dbFile)
  const archive = path.join(os.tmpdir(), 'luanji-e2e-restore-' + randomUUID() + '.tar.gz')
  createBackupArchive(db, serverCfg, archive)
  db.close()
  restoreFromArchive(archive, serverCfg)
  serverHandle = await startServer()
  fs.rmSync(archive, { force: true })

  // 客户端发现 generation 变化 → 停止增量、要求重新合并
  // （服务刚重启，首次请求可能撞上陈旧连接：像退避重试一样多试两次）
  let attention
  for (let attempt = 0; attempt < 3; attempt++) {
    attention = await client.sync.syncNow()
    if (attention.phase !== 'waiting') break
  }
  assert.equal(attention.phase, 'attention')
  assert.equal(attention.attention.code, 'SPACE_CHANGED')
  assert.equal(attention.pendingOps, 0, '警示状态下不继续自动上传')

  // 手动「重新合并」后恢复正常，且数据完好
  client.store.add({ text: '恢复后才写的一条' })
  await client.sync.enable({ url: base, token, deviceName: 'A10' })
  assert.equal(client.sync.status().phase, 'synced')
  assert.equal(client.store.all().some((r) => r.text === '恢复前写的'), true)
  assert.equal(client.store.all().some((r) => r.text === '恢复后才写的一条'), true)
  const map = await serverRecords()
  assert.equal([...map.values()].some((r) => r.text === '恢复后才写的一条'), true)
})

// ── A11：密钥失效 / 容量满：清楚提示，本地可用，不高频重试 ─
test('A11 密钥撤销：明确警示、本地继续可用、无自动高频重试', async () => {
  const revokedToken = generateToken()
  const db = openDatabase(serverCfg.dbFile)
  db.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('将被撤销', sha256Hex(revokedToken), revokedToken.slice(0, 11), Date.now())
  db.close()

  const client = makeClient('A11')
  await client.sync.enable({ url: base, token: revokedToken, deviceName: 'A11' })
  assert.equal(client.sync.status().enabled, true)

  // 撤销密钥
  const db2 = openDatabase(serverCfg.dbFile)
  db2.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?').run(Date.now(), sha256Hex(revokedToken))
  db2.close()

  const calls = []
  const restore = patchFetch((original) => async (...args) => { calls.push(String(args[0])); return original(...args) })
  try {
    const status = await client.sync.syncNow()
    assert.equal(status.phase, 'attention')
    assert.equal(status.attention.code, 'UNAUTHORIZED')
    assert.match(status.lastError, /密钥|认证/)
    // 自动循环已停：等 1.5 秒不再有新请求（不高频重试）
    const count = calls.length
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(calls.length, count, '警示后无自动重试')
  } finally { restore() }

  // 本地仍然完全可用
  client.store.add({ text: '密钥失效期间的本地记录' })
  assert.equal(client.store.count >= 1, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(client.dir, 'notes.json'), 'utf8')).sync.pending.length, 1)

  // 换回有效密钥后手动同步恢复
  writeSyncConfig(client.dir, { url: base, token, deviceName: 'A11' })
  const healed = await client.sync.syncNow()
  assert.equal(healed.phase === 'synced' || healed.pendingOps === 0, true)
})

test('A11 附件配额满：QUOTA_EXCEEDED 明确提示，正文仍可同步', async () => {
  const quotaDir = tempDir('luanji-quota-')
  const quota = 2 * pngBytes.length - 1
  const quotaCfg = { ...loadConfig({ LUANJI_DATA_DIR: quotaDir, LUANJI_QUOTA_BYTES: String(quota) }) }
  const quotaServer = await createLuanjiServer({ config: { ...quotaCfg, port: 0 } })
  const quotaDb = openDatabase(quotaCfg.dbFile)
  const quotaToken = generateToken()
  quotaDb.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('配额测试', sha256Hex(quotaToken), quotaToken.slice(0, 11), Date.now())
  quotaDb.close()
  try {
    const client = makeClient('A11-quota')
    const quotaBase = `http://127.0.0.1:${quotaServer.port}`
    await client.sync.enable({ url: quotaBase, token: quotaToken, deviceName: 'quota' })
    // 第一张图恰好占满配额
    client.store.add({ text: '占满配额的图', images: [{ data: tinyPng, name: '图' }] })
    await client.sync.syncNow()
    // 第二张是不同内容的图，必然超配额（内容哈希不同，不会命中去重）
    const otherPng = 'data:image/png;base64,' + Buffer.concat([pngBytes, Buffer.from('x')]).toString('base64')
    client.store.add({ text: '第二张图会失败', images: [{ data: otherPng, name: '图2' }] })
    const status = await client.sync.syncNow()
    assert.equal(status.phase, 'attention')
    assert.equal(status.attention.code, 'QUOTA_EXCEEDED')
    assert.match(status.lastError, /配额|容量/)
    // 本地内容完好
    assert.equal(client.store.count >= 2, true)
  } finally {
    await quotaServer.close()
    fs.rmSync(quotaDir, { recursive: true, force: true })
  }
})

// ── A12：关闭同步、重启 → 不联网、数据与待办保留 ────────
test('A12 关闭同步并重启：无新网络操作，未确认操作保留', async () => {
  const client = makeClient('A12')
  await client.sync.enable({ url: base, token, deviceName: 'A12' })
  const baseCount = client.store.count
  client.store.add({ text: '关闭前的最后一条' })
  client.sync.disable()
  client.store.add({ text: '关闭后写的一条' }) // 关闭期间仍可记录

  const calls = []
  const restore = patchFetch((original) => async (...args) => { calls.push(String(args[0])); return original(...args) })
  let reopened
  try {
    // 模拟重启：重新打开同一目录
    reopened = { name: 'A12', dir: client.dir, store: createStore({ dataDir: client.dir }), sync: null }
    reopened.sync = createSyncService({ store: reopened.store })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(calls.length, 0, '重启后未开启同步不联网')
    const disk = JSON.parse(fs.readFileSync(path.join(client.dir, 'notes.json'), 'utf8'))
    assert.equal(disk.sync.enabled, false)
    assert.equal(disk.sync.pending.length, 2, '两条未同步操作都保留')
    assert.equal(reopened.store.count, baseCount + 2)
  } finally { restore() }

  // 重新开启相同空间后能正确追赶
  await reopened.sync.enable({ url: base, token, deviceName: 'A12' })
  const map = await serverRecords()
  assert.equal([...map.values()].some((r) => r.text === '关闭前的最后一条'), true)
  assert.equal([...map.values()].some((r) => r.text === '关闭后写的一条'), true)
})

// ── A15：导出到另一个空安装：业务完整、不带凭据与游标 ──
test('A15 导出 → 空安装导入：业务内容完整，无凭据/游标/在途操作', async () => {
  const source = makeClient('A15')
  await source.sync.enable({ url: base, token, deviceName: 'A15' })
  const quote = { text: '导出时保留的引用', origin: { role: 'user', sessionId: 's15' }, anchor: { exact: '导出时保留的引用', start: 0, end: 9 } }
  source.store.add({ text: '要搬走的正文', images: [{ data: tinyPng, name: '图' }], quote })
  await source.sync.syncNow()

  const exported = source.store.exportAll()
  assert.equal(exported.sync, undefined, '导出不带同步状态')
  assert.ok(!JSON.stringify(exported).includes(token), '导出不包含设备凭据')

  const dest = makeClient('A15-dest')
  const result = dest.store.importMany(exported)
  assert.ok(result.added >= 1)
  const imported = dest.store.all().find((r) => r.text === '要搬走的正文')
  assert.equal(imported.images[0].data, tinyPng)
  assert.equal(imported.quote.text, '导出时保留的引用')
  // 新安装未绑定任何空间，无待同步操作
  assert.equal(dest.sync.status().bound, false)
  assert.equal(dest.sync.status().pendingOps, 0)
})

// ── 本机设置接口：脱敏 + CSRF 边界 ──────────────────────
test('本机 /sync 接口：状态脱敏、写操作要求客户端头', async () => {
  const client = makeClient('routes')
  writeSyncConfig(client.dir, { url: base, token, deviceName: 'routes' })
  const handler = createHandler(client.store, intelligence, { sync: client.sync, syncConfig: () => ({ url: base, host: '127.0.0.1', deviceName: 'routes', hasToken: true }) })

  // 直接调 handler（模拟 DSH 前缀路由）而不是真实端口
  const invoke = async (method, url2, body, headers = {}) => {
    const EventEmitter = (await import('node:events')).EventEmitter
    const req = new EventEmitter()
    req.method = method
    req.url = url2
    req.headers = headers
    queueMicrotask(() => { if (body !== undefined) req.emit('data', JSON.stringify(body)); req.emit('end') })
    const res = { statusCode: 0, headers: {}, body: '', writeHead(code, h) { this.statusCode = code; this.headers = h || {}; return this }, end(chunk) { this.body = chunk ?? ''; this.done = true; this.resolve?.() } }
    res.promise = new Promise((resolve) => { res.resolve = resolve })
    await handler(req, res)
    await res.promise
    return res
  }

  const status = JSON.parse((await invoke('GET', '/dsh-luanji/sync')).body)
  assert.equal(status.sync.configured, true)
  assert.equal(status.sync.savedConfig.hasToken, true)
  assert.equal(status.sync.savedConfig.token, undefined)
  assert.equal(JSON.stringify(status).includes(token), false, '状态不回传密钥')

  const blocked = await invoke('POST', '/dsh-luanji/sync/test', { url: base }, { 'x-luanji': '0' })
  assert.equal(blocked.statusCode, 403)

  const allowed = await invoke('POST', '/dsh-luanji/sync/test', { url: base }, { 'x-luanji': '1' })
  assert.equal(allowed.statusCode, 200)
  assert.equal(JSON.parse(allowed.body).result.ok, true)
})

// ── 旧版 cloud 在新同步开启后停用 ───────────────────────
test('新版同步开启后，旧版 cloud 手动拉取/推送停用', async () => {
  const client = makeClient('cloudguard')
  await client.sync.enable({ url: base, token, deviceName: 'guard' })
  const { createCloudService } = await import('../host/cloud.js')
  const cloud = createCloudService({ config: { url: base }, store: client.store })
  const handler = createHandler(client.store, intelligence, { sync: client.sync, cloud })
  const EventEmitter = (await import('node:events')).EventEmitter
  const invoke = async (method, url2) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url2
    req.headers = { 'x-luanji': '1' }
    queueMicrotask(() => req.emit('end'))
    const res = { statusCode: 0, headers: {}, body: '', writeHead(code, h) { this.statusCode = code; this.headers = h || {}; return this }, end(chunk) { this.body = chunk ?? ''; this.resolve?.() } }
    res.promise = new Promise((resolve) => { res.resolve = resolve })
    await handler(req, res)
    await res.promise
    return res
  }
  const blocked = await invoke('POST', '/dsh-luanji/cloud/pull')
  assert.equal(blocked.statusCode, 400)
  assert.match(JSON.parse(blocked.body).error, /新版云端同步已开启/)
})
