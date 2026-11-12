/**
 * 乱记面板用的本机 HTTP API：`/dsh-luanji` 前缀路由。
 *
 * 面板与宿主同源，直接 fetch；所有操作只读写本机 JSON 文件，不联网
 * （云同步由 host/sync.js 在用户显式开启后进行）。
 *
 *   GET  /state            全部记录（拼接引用）、分入口草稿、总数、schemaVersion
 *   POST /notes            新增一条记录          { id?, text?, images?, quote?, draftKey? }
 *   PUT  /notes/:id        编辑自己的内容        { text, images? }
 *   DELETE /notes/:id      删除一条记录（同步开启后走墓碑）
 *   PUT  /draft            草稿存本机            { key, draft }，兼容旧版 { text }
 *   GET  /search?q=        文字模糊搜索（想法、原话、模型、对话名）
 *   GET  /flip             随机一条（保留的乱记偶遇接口）
 *   GET  /export           导出（整份记录 JSON 下载，不带同步状态与凭据）
 *   POST /import           导入（并入导出文件）   { records } 或 Web 版导出对象
 *   GET  /cloud            旧版「乱记兼容」云端状态（未配置时只报 configured:false）
 *   POST /cloud/pull       从旧云端拉取并并入本机（新同步开启后停用）
 *   POST /cloud/push       推到旧云端（新同步开启后停用）
 *
 * 云同步 v1（见 docs/sync-protocol-v1.md；全部本机接口，不是公网管理 API）：
 *   GET  /sync             同步状态（脱敏：只有 hasToken，不回传密钥）
 *   POST /sync/config      保存连接（地址 + 密钥 + 设备名；密钥留空 = 保留现有）
 *   POST /sync/test        测试连接（只读 GET /info，不上传任何记录）
 *   POST /sync/enable      启用同步并合并（先做本地完整备份）
 *   POST /sync/disable     关闭同步（停止网络操作，数据与待办保留）
 *   POST /sync/now         立即同步
 *   GET  /sync/conflicts   冲突列表（双方内容）
 *   POST /sync/conflicts/:recordId/resolve   { choice: local|remote|both }
 *   POST /sync/attachments/retry             重试待下载附件
 *
 * 本机写接口的授权边界：同源 + 自定义头 x-luanji（跨站表单无法携带自定义头，
 * 从根上挡 CSRF）；Origin 存在时还必须与 Host 同源。
 *
 * 另有一个同源开发页（GET /__dev__）：用假的 slots 环境直接渲染 client 半，
 * 改 client.js 后刷新即可看效果；仅 options.development 显式开启，正式宿主不提供。
 *
 * @module dsh-luanji/host/routes
 */

import fs from 'node:fs'
import path from 'node:path'

/** 前缀路由挂载点。 */
export const ROUTE = '/dsh-luanji'

/** 同步写接口的自定义头（跨站表单带不了自定义头 → CSRF 挡在浏览器侧）。 */
const CLIENT_HEADER = 'x-luanji'

/**
 * 组装 HTTP Handler。
 *
 * @param {object} store - host/store.js 的记录实例。
 * @param {object} intelligence - host/search.js 的 { search, pickForFlip }。
 * @param {object} [options]
 * @param {string} [options.pkgDir] - 插件包目录（__dev__ 页读 client.js 用）。
 * @param {object} [options.cloud] - 旧版云端服务（host/cloud.js）。
 * @param {object} [options.sync] - 新版同步引擎（host/sync.js）。
 * @param {object} [options.syncConfig] - 私密配置脱敏读取（host/sync-config.js）。
 * @returns {object} `ctx.webServer.register` 的 handler。
 */
export function createHandler(store, intelligence, options = {}) {
  const pkgDir = options.pkgDir || ''
  return async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    /** 读请求体并 JSON.parse，坏请求返回 null。 */
    const readBody = () =>
      new Promise((resolve) => {
        let raw = '', oversized = false
        req.on('data', (chunk) => {
          if (oversized) return
          raw += chunk
          if (raw.length > 24 * 1024 * 1024) { oversized = true; raw = ''; resolve(null) }
        })
        req.on('end', () => {
          if (oversized) return
          try {
            resolve(JSON.parse(raw || '{}'))
          } catch {
            resolve(null)
          }
        })
        req.on('error', () => resolve(null))
      })

    /** 本机写接口的来源校验：自定义头 + Origin 同源（存在时）。 */
    const writeAllowed = () => {
      if (req.headers[CLIENT_HEADER] !== '1') return false
      const origin = req.headers.origin
      if (origin && origin !== 'null') {
        try {
          const host = req.headers.host || ''
          if (new URL(String(origin)).host !== host) return false
        } catch {
          return false
        }
      }
      return true
    }

    /** 本地记录变更后通知同步引擎（2 秒防抖由引擎处理）。 */
    const notifySync = () => { try { options.sync?.notifyLocalChange() } catch { /* 引擎不在也不影响本地 */ } }

    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 前缀路由里 pathname 仍带前缀，剥掉后按 REST 段分。
      const routePath = url.pathname.replace(new RegExp('^' + ROUTE), '') || '/'
      const [, resource, id, subResource] = routePath.split('/')
      // 本机写接口统一来源校验：跨站表单带不了自定义头，从根上挡 CSRF。
      if (req.method !== 'GET' && !routePath.startsWith('/__dev__') && !writeAllowed()) {
        return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
      }

      if (req.method === 'GET' && routePath === '/state') {
        return send(200, { ok: true, ...store.state() })
      }

      if (req.method === 'POST' && routePath === '/notes') {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        const record = store.add({ ...body, source: body.quote ? 'selection' : body.source === 'agent' ? 'agent' : 'ui' })
        notifySync()
        return send(200, { ok: true, record, count: store.count })
      }

      if (req.method === 'PUT' && resource === 'notes' && id) {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        const record = store.update(decodeURIComponent(id), body)
        notifySync()
        return send(200, { ok: true, record })
      }

      if (req.method === 'DELETE' && resource === 'notes' && id) {
        const record = store.remove(decodeURIComponent(id))
        notifySync()
        return send(200, { ok: true, record })
      }

      if (req.method === 'PUT' && routePath === '/draft') {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        return send(200, { ok: true, draft: store.saveDraft(body.key ? body.draft : body.text, body.key) })
      }

      if (req.method === 'GET' && routePath === '/search') {
        const q = url.searchParams.get('q') ?? ''
        if (!q.trim()) return send(200, { ok: true, records: [], query: q })
        const hits = intelligence.search(store.all(), q)
        return send(200, { ok: true, records: hits.map((hit) => hit.record), query: q })
      }

      if (req.method === 'GET' && routePath === '/flip') {
        const exclude = (url.searchParams.get('exclude') ?? '').split(',').filter(Boolean)
        const record = intelligence.pickForFlip(store.all(), { excludeIds: exclude })
        return send(200, { ok: true, record })
      }

      if (req.method === 'GET' && routePath === '/export') {
        const payload = JSON.stringify(store.exportAll(), null, 2)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="luanji-notes.json"',
        })
        return res.end(payload)
      }

      if (req.method === 'POST' && routePath === '/import') {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        const result = store.importMany(body)
        notifySync()
        return send(200, { ok: true, ...result })
      }

      // ── 旧版「乱记兼容」云端：默认不配置；新版同步开启后停用 ────────
      if (req.method === 'GET' && routePath === '/cloud') {
        const newSyncActive = options.sync ? options.sync.status().enabled : false
        const base = options.cloud ? options.cloud.status() : { configured: false, url: '' }
        return send(200, { ok: true, cloud: { ...base, superseded: newSyncActive } })
      }
      if (req.method === 'POST' && (routePath === '/cloud/pull' || routePath === '/cloud/push')) {
        if (!options.cloud) return send(400, { ok: false, error: '云端服务未配置。在插件配置里填 cloud.url 后再试。' })
        if (options.sync?.status().enabled) {
          return send(400, { ok: false, error: '新版云端同步已开启，旧版手动拉取/推送已停用（两套协议不能同时写同一份数据）。' })
        }
        try {
          const result = routePath.endsWith('/pull') ? await options.cloud.pull() : await options.cloud.push()
          return send(200, { ok: true, result, cloud: options.cloud.status() })
        } catch (error) {
          options.cloud.recordError(error instanceof Error ? error : new Error(String(error)))
          return send(502, { ok: false, error: error instanceof Error ? error.message : String(error), cloud: options.cloud.status() })
        }
      }

      // ── 云同步 v1：本机设置/状态/触发/冲突接口 ─────────────────────
      if (resource === 'sync') {
        if (!options.sync) return send(404, { ok: false, error: '同步引擎不可用。' })
        const sync = options.sync

        if (req.method === 'GET' && !id) {
          const status = sync.status()
          const saved = options.syncConfig?.(store.dataDir) || null
          return send(200, {
            ok: true,
            sync: { ...status, savedConfig: saved },
          })
        }

        if (req.method === 'POST' && routePath === '/sync/config') {
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          const body = await readBody()
          if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
          const { writeSyncConfig } = await import('./sync-config.js')
          try {
            const config = writeSyncConfig(store.dataDir, {
              url: String(body.url || ''),
              token: typeof body.token === 'string' ? body.token : '',
              deviceName: String(body.deviceName || ''),
            })
            return send(200, { ok: true, sync: { ...sync.status(), savedConfig: { url: config.url, host: config.host, deviceName: config.deviceName, hasToken: config.hasToken } } })
          } catch (error) {
            return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        if (req.method === 'POST' && routePath === '/sync/test') {
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          const body = await readBody()
          if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
          const result = await sync.testConnection({
            url: typeof body.url === 'string' && body.url ? body.url : undefined,
            token: typeof body.token === 'string' && body.token ? body.token : undefined,
          })
          return send(200, { ok: true, result })
        }

        if (req.method === 'POST' && routePath === '/sync/enable') {
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          const body = await readBody()
          if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
          try {
            const result = await sync.enable({
              url: String(body.url || ''),
              token: typeof body.token === 'string' ? body.token : '',
              deviceName: String(body.deviceName || ''),
            })
            return send(200, { ok: true, result, sync: sync.status() })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return send(400, { ok: false, error: message, sync: sync.status() })
          }
        }

        if (req.method === 'POST' && (routePath === '/sync/disable' || routePath === '/sync/now')) {
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          try {
            const result = routePath === '/sync/disable' ? sync.disable() : await sync.syncNow()
            return send(200, { ok: true, sync: result })
          } catch (error) {
            return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        if (req.method === 'GET' && routePath === '/sync/conflicts') {
          return send(200, { ok: true, conflicts: store.conflicts() })
        }

        if (req.method === 'POST' && resource === 'sync' && id === 'conflicts' && subResource) {
          // /sync/conflicts/:recordId/resolve
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          const parts = routePath.split('/')
          if (parts[4] !== 'resolve') return send(404, { ok: false, error: 'not found' })
          const recordId = decodeURIComponent(parts[3] || '')
          const body = await readBody()
          if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
          if (!['local', 'remote', 'both'].includes(body.choice)) return send(400, { ok: false, error: 'choice 只能是 local / remote / both。' })
          try {
            const status = await sync.resolveConflict(recordId, body.choice)
            return send(200, { ok: true, sync: status })
          } catch (error) {
            return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        if (req.method === 'POST' && routePath === '/sync/attachments/retry') {
          if (!writeAllowed()) return send(403, { ok: false, error: '缺少本机客户端标识头，拒绝写入。' })
          const status = await sync.retryBlobs()
          return send(200, { ok: true, sync: status })
        }
      }

      // ── 同源开发页：假 slots 环境 + 真实 API，浏览器里调 UI 用 ──────────
      if (req.method === 'GET' && routePath === '/__dev__' && pkgDir && options.development) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(fs.readFileSync(path.join(pkgDir, 'test/fixture.html'), 'utf8'))
      }
      if (req.method === 'GET' && routePath === '/__dev__/client.js' && pkgDir && options.development) {
        const code = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(code)
      }

      return send(404, { ok: false, error: 'not found: ' + routePath })
    } catch (error) {
      return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
