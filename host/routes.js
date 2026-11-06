/**
 * 乱记面板用的本机 HTTP API：`/dsh-luanji` 前缀路由。
 *
 * 面板与宿主同源，直接 fetch；所有操作只读写本机 JSON 文件，不联网。
 *
 *   GET  /state            全部记录（拼接引用）、分入口草稿、总数、schemaVersion
 *   POST /notes            新增一条记录          { id?, text?, images?, quote?, draftKey? }
 *   PUT  /notes/:id        编辑自己的内容        { text, images? }
 *   DELETE /notes/:id      删除一条记录
 *   PUT  /draft            草稿存本机            { key, draft }，兼容旧版 { text }
 *   GET  /search?q=        文字模糊搜索（想法、原话、模型、对话名）
 *   GET  /flip             随机一条（保留的乱记偶遇接口）
 *   GET  /export           导出（整份记录 JSON 下载）
 *   POST /import           导入（并入导出文件）   { records } 或 Web 版导出对象
 *   GET  /cloud            可选云端服务状态（未配置时只报 configured:false）
 *   POST /cloud/pull       从云端拉取并并入本机
 *   POST /cloud/push       把本机纯文本记录推到云端
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

/**
 * 组装 HTTP handler。
 *
 * @param {object} store - host/store.js 的记录实例。
 * @param {object} intelligence - host/search.js 的 { search, pickForFlip }。
 * @param {object} [options]
 * @param {string} [options.pkgDir] - 插件包目录（__dev__ 页读 client.js 用）。
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

    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 前缀路由里 pathname 仍带前缀，剥掉后按 REST 段分。
      const routePath = url.pathname.replace(new RegExp('^' + ROUTE), '') || '/'
      const [, resource, id] = routePath.split('/')

      if (req.method === 'GET' && routePath === '/state') {
        return send(200, { ok: true, ...store.state() })
      }

      if (req.method === 'POST' && routePath === '/notes') {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        const record = store.add({ ...body, source: body.quote ? 'selection' : body.source === 'agent' ? 'agent' : 'ui' })
        return send(200, { ok: true, record, count: store.count })
      }

      if (req.method === 'PUT' && resource === 'notes' && id) {
        const body = await readBody()
        if (!body) return send(400, { ok: false, error: '请求体不是合法 JSON。' })
        return send(200, { ok: true, record: store.update(decodeURIComponent(id), body) })
      }

      if (req.method === 'DELETE' && resource === 'notes' && id) {
        return send(200, { ok: true, record: store.remove(decodeURIComponent(id)) })
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
        return send(200, { ok: true, ...result })
      }

      // ── 可选云端服务：默认不配置，不联网 ────────────────────────────
      if (req.method === 'GET' && routePath === '/cloud') {
        if (!options.cloud) return send(200, { ok: true, cloud: { configured: false, url: '' } })
        return send(200, { ok: true, cloud: options.cloud.status() })
      }
      if (req.method === 'POST' && (routePath === '/cloud/pull' || routePath === '/cloud/push')) {
        if (!options.cloud) return send(400, { ok: false, error: '云端服务未配置。在插件配置里填 cloud.url 后再试。' })
        try {
          const result = routePath.endsWith('/pull') ? await options.cloud.pull() : await options.cloud.push()
          return send(200, { ok: true, result, cloud: options.cloud.status() })
        } catch (error) {
          options.cloud.recordError(error instanceof Error ? error : new Error(String(error)))
          return send(502, { ok: false, error: error instanceof Error ? error.message : String(error), cloud: options.cloud.status() })
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

