#!/usr/bin/env node
/**
 * 乱记个人同步服务入口：一个进程 = 一个人的数据空间。
 *
 * 组成：SQLite（数据库随服务打包）+ 附件目录 + /api/sync/v1（同步协议）
 * + /api/web/v1（手机网页登录/列表）+ 静态手机网页（web/）+ 每日一致性快照。
 *
 * 生产部署：容器内监听 0.0.0.0，宿主只把端口绑到回环，由反向代理提供 HTTPS。
 *
 * @module luanji-sync-server/main
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { openDatabase } from './db.mjs'
import { LoginThrottle, RateLimiter, pruneSessions } from './auth.mjs'
import { handleSyncApi } from './api.mjs'
import { handleWebApi } from './web-api.mjs'
import { dailySnapshot } from './backup.mjs'
import { logRequest, SECURITY_HEADERS, sendJson } from './http.mjs'

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

/** 静态网页白名单：只服务固定文件名，杜绝路径穿越。 */
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
])

/**
 * 组装完整 HTTP 服务（测试直接调用，拿到随机端口的实例）。
 *
 * @param {object} [options]
 * @param {ReturnType<typeof loadConfig>} [options.config] - 注入配置（默认读环境变量）。
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>, config: object}>}
 */
export async function createLuanjiServer(options = {}) {
  const cfg = options.config || loadConfig()
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.snapshotDir, { recursive: true })
  const db = openDatabase(cfg.dbFile)
  const limiter = new RateLimiter(cfg.rateLimitPerMinute)
  const throttle = new LoginThrottle({ windowMs: cfg.loginWindowMs, maxFailures: cfg.loginMaxFailures })
  const ctx = { db, cfg, limiter, throttle }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now()
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname.startsWith('/api/sync/v1/')) {
        if (await handleSyncApi(req, res, ctx)) return
      }
      if (url.pathname.startsWith('/api/web/v1/')) {
        if (await handleWebApi(req, res, ctx)) return
      }
      const target = STATIC_FILES.get(url.pathname)
      if (target && req.method === 'GET') return serveStatic(res, target)
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      console.error(new Date().toISOString(), 'internal error:', error instanceof Error ? error.message : error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务内部错误。' })
      else res.end()
    } finally {
      logRequest(req, res, Date.now() - startedAt)
    }
  })

  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve))
  const port = server.address().port

  // 周期任务：每日一致性快照 + 会话清理。个人规模下开销可忽略。
  let lastSnapshotDay = ''
  const housekeeping = setInterval(() => {
    try {
      pruneSessions(db)
      const now = new Date()
      if (now.getHours() >= cfg.snapshotHour && lastSnapshotDay !== now.toISOString().slice(0, 10)) {
        lastSnapshotDay = now.toISOString().slice(0, 10)
        const file = dailySnapshot(db, cfg)
        console.log(`${new Date().toISOString()} snapshot: ${file}`)
      }
    } catch (error) {
      console.error(new Date().toISOString(), 'housekeeping failed:', error instanceof Error ? error.message : error)
    }
  }, 10 * 60 * 1000)
  housekeeping.unref()

  const close = async () => {
    clearInterval(housekeeping)
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }

  return { server, port, close, config: cfg }
}

/** 服务白名单静态文件。 */
function serveStatic(res, target) {
  let bytes
  try { bytes = fs.readFileSync(path.join(WEB_DIR, target.file)) } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': target.type,
    // 个人服务无 CDN 压力：页面资源一律 no-cache，手机端总能拿到最新版本。
    'cache-control': 'no-cache',
  })
  res.end(bytes)
}

// 直接运行（node src/main.mjs）时启动服务；被 import 时不启动。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig()
  const instance = await createLuanjiServer({ config: cfg })
  console.log(`乱记同步服务已启动：http://${cfg.host}:${instance.port}（数据目录 ${cfg.dataDir}）`)
  console.log('首次使用：node src/admin.mjs token-create --name "我的 Mac" 与 password-set')
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      console.log('正在关闭…')
      instance.close().then(() => process.exit(0)).catch(() => process.exit(1))
    })
  }
}
