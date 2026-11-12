#!/usr/bin/env node
/**
 * 管理命令行：设备 Token、手机口令、快照、备份与恢复。
 *
 * 用法（在 server/ 目录或容器内）：
 *   node src/admin.mjs token-create --name "我的 Mac"
 *   node src/admin.mjs token-list
 *   node src/admin.mjs token-revoke --prefix lj_ab12cd34
 *   node src/admin.mjs password-set            # 交互输入（回显关闭）
 *   node src/admin.mjs password-set --stdin    # 从 stdin 读一行（脚本用）
 *   node src/admin.mjs snapshot                # 立即做一次一致性快照
 *   node src/admin.mjs backup --out /secure/luanji-$(date +%F).tar.gz
 *   node src/admin.mjs restore --in /secure/luanji-2026-11-09.tar.gz   # 先停服务
 *   node src/admin.mjs space-rotate            # 手动更换 generation（客户端将重新合并）
 *
 * Token 只在创建时显示一次；不在对话/日志里打印秘密。
 *
 * @module luanji-sync-server/admin
 */

import readline from 'node:readline'
import { loadConfig } from './config.mjs'
import { openDatabase, rotateGeneration } from './db.mjs'
import { generateToken, setPassword, sha256Hex } from './auth.mjs'
import { createBackupArchive, dailySnapshot, restoreFromArchive } from './backup.mjs'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** 交互式隐藏输入读口令。 */
function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('设置手机登录口令（至少 8 位，输入不回显）: ', { hideEchoBack: true }, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function readStdinLine() {
  const rl = readline.createInterface({ input: process.stdin })
  const line = await new Promise((resolve) => rl.once('line', resolve))
  rl.close()
  return String(line).trim()
}

const command = process.argv[2] || ''
const cfg = loadConfig()

try {
  if (command === 'token-create') {
    const name = arg('--name', '未命名设备')
    const db = openDatabase(cfg.dbFile)
    const token = generateToken()
    const info = db.prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)').run(name, sha256Hex(token), token.slice(0, 11), Date.now())
    db.close()
    console.log(`已创建设备 Token（id=${info.lastInsertRowid}，名称「${name}」）。`)
    console.log('Token 只显示这一次，请立即复制到私密位置：')
    console.log(token)
  } else if (command === 'token-list') {
    const db = openDatabase(cfg.dbFile)
    const rows = db.prepare('SELECT id, name, prefix, created_at, revoked_at, last_used_at FROM tokens ORDER BY id').all()
    db.close()
    if (!rows.length) console.log('还没有设备 Token。')
    for (const row of rows) {
      const state = row.revoked_at ? `已撤销 (${new Date(row.revoked_at).toISOString()})` : '有效'
      const used = row.last_used_at ? `最近使用 ${new Date(row.last_used_at).toISOString()}` : '从未使用'
      console.log(`#${row.id} ${row.prefix}… 「${row.name}」 ${state} · ${used}`)
    }
  } else if (command === 'token-revoke') {
    const prefix = arg('--prefix')
    const id = arg('--id')
    if (!prefix && !id) throw new Error('需要 --prefix lj_xxxxxxxx 或 --id <编号>。')
    const db = openDatabase(cfg.dbFile)
    const result = prefix
      ? db.prepare('UPDATE tokens SET revoked_at = ? WHERE prefix = ? AND revoked_at IS NULL').run(Date.now(), prefix)
      : db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), Number(id))
    db.close()
    console.log(`已撤销 ${result.changes} 个设备 Token。`)
  } else if (command === 'password-set') {
    const password = process.argv.includes('--stdin') ? await readStdinLine() : await promptPassword()
    const db = openDatabase(cfg.dbFile)
    try { setPassword(db, password) } finally { db.close() }
    console.log('手机登录口令已保存（scrypt 哈希）。')
  } else if (command === 'snapshot') {
    const db = openDatabase(cfg.dbFile)
    const file = dailySnapshot(db, cfg)
    db.close()
    console.log(`一致性快照已生成：${file}`)
  } else if (command === 'backup') {
    const out = arg('--out')
    if (!out) throw new Error('需要 --out <备份 tar.gz 路径>。')
    const db = openDatabase(cfg.dbFile)
    const result = createBackupArchive(db, cfg, out)
    db.close()
    console.log(`备份完成：${result.file}（${(result.bytes / 1024 / 1024).toFixed(2)} MiB，含数据库快照与附件）。`)
    console.log('请尽快把它加密复制到独立位置；恢复用：node src/admin.mjs restore --in <文件>')
  } else if (command === 'restore') {
    const input = arg('--in')
    if (!input) throw new Error('需要 --in <备份 tar.gz 路径>。')
    const result = restoreFromArchive(input, cfg)
    console.log(`恢复完成：记录 ${result.records} 条、附件 ${result.blobs} 个。`)
    console.log(`generation 已更换为 ${result.rotatedGeneration}；客户端会检测到变化并要求重新合并。`)
    if (result.previous) console.log(`原有数据已挪到 ${result.previous}（确认无误后可删除）。`)
    console.log('现在可以重新启动服务。')
  } else if (command === 'space-rotate') {
    const db = openDatabase(cfg.dbFile)
    const generation = rotateGeneration(db)
    db.close()
    console.log(`generation 已更换为 ${generation}。所有客户端将停止增量同步并要求重新合并。`)
  } else {
    console.log('乱记同步服务管理命令。用法见文件头部注释：token-create / token-list / token-revoke / password-set / snapshot / backup / restore / space-rotate')
    process.exitCode = 2
  }
} catch (error) {
  console.error('命令失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
