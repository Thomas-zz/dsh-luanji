/**
 * 管理命令与备份恢复：Token 创建/撤销、快照、备份归档、恢复 + generation 轮换。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLuanjiServer } from '../src/main.mjs'
import { generateToken, sha256Hex, verifyPassword } from '../src/auth.mjs'
import { openDatabase, getMeta, META_KEYS } from '../src/db.mjs'
import { loadConfig } from '../src/config.mjs'
import { createBackupArchive, restoreFromArchive } from '../src/backup.mjs'

const SERVER_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

/** 在隔离数据目录里准备一个带数据的库。 */
async function seededServer(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const cfg = { ...loadConfig({ LUANJI_DATA_DIR: dataDir }), port: 0 }
  const instance = await createLuanjiServer({ config: cfg })
  const token = generateToken()
  const db = openDatabase(cfg.dbFile)
  db.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('测试', sha256Hex(token), token.slice(0, 11), Date.now())
  const id = randomUUID()
  const now = Date.now()
  const record = { id, text: '要备份的记录', source: 'ui', created_at: now, updated_at: now, quote: null, attachments: [], deleted_at: null }
  db.prepare(`INSERT INTO records (id, text, source, quote_json, attachments_json, created_at, updated_at, deleted_at, rev)
              VALUES (?, ?, ?, NULL, '[]', ?, ?, NULL, 1)`).run(id, record.text, 'ui', now, now)
  db.prepare('INSERT INTO changes (id, op, rev, record_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'put', 1, JSON.stringify(record), now)
  db.close()
  return { instance, cfg, token, recordId: id }
}

test('备份 → 空目录恢复：数据可读、generation 已轮换（A14 服务端半边）', async () => {
  const source = await seededServer('luanji-admin-backup-')
  try {
    const db = openDatabase(source.cfg.dbFile)
    const archive = path.join(os.tmpdir(), 'luanji-backup-' + randomUUID() + '.tar.gz')
    const result = createBackupArchive(db, source.cfg, archive)
    assert.ok(result.bytes > 0)
    db.close()

    // 恢复到一个全新的数据目录
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-admin-restore-'))
    const targetCfg = { ...loadConfig({ LUANJI_DATA_DIR: targetDir }) }
    const restored = restoreFromArchive(archive, targetCfg)
    assert.equal(restored.records, 1)
    assert.notEqual(restored.rotatedGeneration, undefined)

    const targetDb = openDatabase(targetCfg.dbFile)
    const row = targetDb.prepare('SELECT * FROM records WHERE id = ?').get(source.recordId)
    assert.equal(row.text, '要备份的记录')
    const generation = getMeta(targetDb, META_KEYS.generation)
    assert.equal(generation, restored.rotatedGeneration)
    targetDb.close()
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
  } finally {
    await source.instance.close()
    fs.rmSync(source.cfg.dataDir, { recursive: true, force: true })
  }
})

test('CLI：token-create / token-list / token-revoke / space-rotate', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-admin-cli-'))
  const env = { ...process.env, LUANJI_DATA_DIR: dataDir }
  const run = (args) => execFileSync('node', [path.join(SERVER_DIR, 'src/admin.mjs'), ...args], { env, cwd: SERVER_DIR }).toString()

  const created = run(['token-create', '--name', '我的 Mac'])
  const token = created.trim().split('\n').pop()
  assert.match(token, /^lj_/)
  const list = run(['token-list'])
  assert.match(list, /我的 Mac/)
  assert.match(list, /有效/)

  const revoked = run(['token-revoke', '--prefix', token.slice(0, 11)])
  assert.match(revoked, /已撤销 1 个/)
  const listAfter = run(['token-list'])
  assert.match(listAfter, /已撤销/)

  const rotated = run(['space-rotate'])
  assert.match(rotated, /generation 已更换/)
  const db = openDatabase(path.join(dataDir, 'luanji.sqlite'))
  const spaceId = getMeta(db, META_KEYS.spaceId)
  assert.ok(spaceId)
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('CLI：password-set --stdin 后可校验登录口令', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-admin-pwd-'))
  const env = { ...process.env, LUANJI_DATA_DIR: dataDir }
  execFileSync('node', [path.join(SERVER_DIR, 'src/admin.mjs'), 'password-set', '--stdin'], { env, input: 'a-long-password\n', cwd: SERVER_DIR })
  const db = openDatabase(path.join(dataDir, 'luanji.sqlite'))
  assert.equal(verifyPassword(db, 'a-long-password'), true)
  assert.equal(verifyPassword(db, 'wrong'), false)
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('CLI：口令太短被拒绝', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-admin-pwd2-'))
  const env = { ...process.env, LUANJI_DATA_DIR: dataDir }
  assert.throws(() => execFileSync('node', [path.join(SERVER_DIR, 'src/admin.mjs'), 'password-set', '--stdin'], { env, input: 'short\n', cwd: SERVER_DIR }), /至少 8 位/)
  fs.rmSync(dataDir, { recursive: true, force: true })
})
