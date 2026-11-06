/**
 * 乱记 client 半开发服务器：`node test/dev-server.mjs [port]`
 *
 * 不依赖 DSH，直接复用真实的 store / search / routes 在本机起一个同源环境：
 *   /dsh-luanji/*   真实 API（数据在 $TMP 的临时目录，不碰 ~/.dsh/luanji）
 *   /               开发页（CDN React + 假 __ModuleLoader__/slots + 真实 API）
 *
 * 改 client.js 后刷新页面即可看效果。默认端口 8129。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createStore } from '../host/store.js'
import * as intelligence from '../host/search.js'
import { createHandler } from '../host/routes.js'

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const port = Number(process.argv[2]) || 8129

// 临时数据目录：开发服务器不碰真实数据。
const dataDir = process.env.LUANJI_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-dev-'))
const store = createStore({ dataDir })
const handler = createHandler(store, intelligence, { pkgDir, development: true })

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    // 与 host/routes.js 的 __dev__ 页相同，但 client.js 从 /client.js 取。
    res.end(DEV_PAGE)
    return
  }
  if (url.pathname === '/client.js') {
    const code = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(code)
    return
  }
  if (url.pathname.startsWith('/dsh-luanji/')) {
    void handler(req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`luanji dev server: http://127.0.0.1:${port}/  (数据在 ${dataDir})`)
})

const DEV_PAGE = fs.readFileSync(path.join(pkgDir, 'test/fixture.html'), 'utf8')
