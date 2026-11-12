/**
 * 一致性快照、备份与恢复。
 *
 * 铁律：
 *  - 不直接复制正在写入的数据库文件，一律 `VACUUM INTO`；
 *  - 备份 = 数据库快照 + 附件目录，打成单个 tar.gz；
 *  - 恢复完成后必须更换 generation（客户端将停止增量同步并重新合并）。
 *
 * @module luanji-sync-server/backup
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase, rotateGeneration } from './db.mjs'

/** 单引号 SQL 字符串转义（VACUUM INTO 路径）。 */
function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * 生成数据库一致性快照（VACUUM INTO）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} outFile - 快照输出路径。
 */
export function snapshotDatabase(db, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const tmp = outFile + '.tmp'
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  db.exec(`VACUUM INTO ${sqlString(tmp)}`)
  fs.renameSync(tmp, outFile)
}

/**
 * 每日快照维护：生成当天快照并按保留数量清理旧的。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{snapshotDir: string, snapshotKeep: number}} cfg
 * @returns {string} 快照路径
 */
export function dailySnapshot(db, cfg) {
  const name = `luanji-${new Date().toISOString().slice(0, 10)}.sqlite`
  const file = path.join(cfg.snapshotDir, name)
  snapshotDatabase(db, file)
  const files = fs.readdirSync(cfg.snapshotDir).filter((f) => /^luanji-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort()
  for (const old of files.slice(0, Math.max(0, files.length - cfg.snapshotKeep))) {
    try { fs.unlinkSync(path.join(cfg.snapshotDir, old)) } catch { /* 清理失败不影响运行 */ }
  }
  return file
}

/**
 * 打包完整备份（数据库一致性快照 + blobs 目录）为 tar.gz。
 * 依赖系统 tar（部署文档已注明）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{dataDir: string, blobDir: string, snapshotDir: string}} cfg
 * @param {string} outFile - 输出 tar.gz 路径。
 * @returns {{file: string, bytes: number}}
 */
export function createBackupArchive(db, cfg, outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  const staging = path.join(cfg.snapshotDir, 'backup-staging')
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    snapshotDatabase(db, path.join(staging, 'luanji.sqlite'))
    if (fs.existsSync(cfg.blobDir)) {
      execFileSync('tar', ['-czf', outFile, '-C', staging, 'luanji.sqlite', '-C', cfg.dataDir, 'blobs'], { stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      execFileSync('tar', ['-czf', outFile, '-C', staging, 'luanji.sqlite'], { stdio: ['ignore', 'ignore', 'pipe'] })
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return { file: path.resolve(outFile), bytes: fs.statSync(outFile).size }
}

/**
 * 从备份归档恢复到数据目录，并更换 generation。
 *
 * @param {string} archive - tar.gz 备份路径。
 * @param {object} cfg - 服务配置。
 * @returns {{rotatedGeneration: string, records: number, blobs: number}}
 */
export function restoreFromArchive(archive, cfg) {
  const archiveFile = path.resolve(archive)
  if (!fs.existsSync(archiveFile)) throw new Error(`备份文件不存在：${archiveFile}`)
  const staging = path.join(cfg.dataDir, `.restore-${Date.now()}`)
  fs.mkdirSync(staging, { recursive: true })
  try {
    execFileSync('tar', ['-xzf', archiveFile, '-C', staging], { stdio: ['ignore', 'ignore', 'pipe'] })
    const dbFile = path.join(staging, 'luanji.sqlite')
    if (!fs.existsSync(dbFile)) throw new Error('备份里缺少 luanji.sqlite，不是有效的乱记备份。')
    // 先校验备份库可打开、结构完整，再动现有数据。
    const check = openDatabase(dbFile)
    const records = Number(check.prepare('SELECT COUNT(*) AS c FROM records').get().c)
    const blobs = Number(check.prepare('SELECT COUNT(*) AS c FROM blobs').get().c)
    check.close()

    // 现有数据整体挪到一旁（可手动找回），再放入恢复内容。
    const previous = path.join(cfg.dataDir, `pre-restore-${Date.now()}`)
    fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true })
    for (const name of ['luanji.sqlite', 'luanji.sqlite-wal', 'luanji.sqlite-shm']) {
      const from = path.join(cfg.dataDir, name)
      if (fs.existsSync(from)) {
        fs.mkdirSync(previous, { recursive: true })
        fs.renameSync(from, path.join(previous, name))
      }
    }
    fs.renameSync(dbFile, cfg.dbFile)
    const blobStaging = path.join(staging, 'blobs')
    if (fs.existsSync(blobStaging)) {
      fs.rmSync(cfg.blobDir, { recursive: true, force: true })
      fs.renameSync(blobStaging, cfg.blobDir)
    }

    // 恢复后必须换 generation：客户端发现变化即停止增量同步、走重新合并。
    const db = openDatabase(cfg.dbFile)
    let generation
    try { generation = rotateGeneration(db) } finally { db.close() }
    return { rotatedGeneration: generation, records, blobs, previous }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
