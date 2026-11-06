/**
 * Host half of `dsh-luanji` — 乱记 for DSH。
 *
 * 三件事，全部只在本机：
 * 1. 纸摞存储：`~/.dsh/luanji/notes.json`（host/store.js）。
 * 2. 面板 API：`/dsh-luanji` 前缀路由（host/routes.js），同源 fetch。
 * 3. agent 工具：luanji（add / find）（host/tool.js），对话里让 AI 帮忙记或找回。
 * 4. 可选云端：配置 cloud.url 后，面板里可手动从自己的「乱记兼容」服务拉取/推送
 *    （host/cloud.js）。默认不配置，插件不联网。
 *
 * 每个注册都挂在 ctx.effect 上，热重载/卸载自动清理。
 *
 * @module dsh-luanji
 */

import { createStore } from './host/store.js'
import * as intelligence from './host/search.js'
import { createHandler, ROUTE } from './host/routes.js'
import { createCloudService } from './host/cloud.js'
import { createLuanjiTool } from './host/tool.js'

/** Plugin identity (cordis fiber 命名；与 cordis.patch.yml 的 name 一致)。 */
export const name = '@dsh-external/dsh-luanji'

/** Host services this row needs before it can activate. */
export const inject = ['webServer', 'tools']

/**
 * Activate the plugin on a Host context.
 *
 * @param {import('cordis').Context & {webServer: object, tools: object}} ctx - Host plugin context.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const store = createStore({ dataDir: config.dataDir })
  const cloud = createCloudService({ config: config.cloud, store })
  const handler = createHandler(store, intelligence, { pkgDir: import.meta.dirname, cloud })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler,
      }),
    'dsh-luanji: /dsh-luanji api',
  )

  ctx.effect(() => ctx.tools.register(createLuanjiTool(store, intelligence)), 'dsh-luanji: luanji tool')
}
