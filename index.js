/**
 * Host half of `dsh-luanji` — 乱记 for DSH。
 *
 * 全部本机能力：
 * 1. 纸摞存储：`~/.dsh/luanji/notes.json`（host/store.js，v3 含同步元数据）。
 * 2. 面板 API：`/dsh-luanji` 前缀路由（host/routes.js），同源 fetch。
 * 3. agent 工具：luanji（add / find）（host/tool.js），对话里让 AI 帮忙记或找回。
 * 4. 可选云端同步（默认关闭）：配置自己的 luanji-sync-server 后开启
 *    （host/sync.js，协议见 docs/sync-protocol-v1.md）。未开启时插件不联网。
 * 5. 旧版「乱记兼容」手动拉取/推送（host/cloud.js）：新版同步开启后自动停用。
 *
 * 每个注册都挂在 ctx.effect 上，热重载/卸载自动清理（同步循环一并停止）。
 *
 * @module dsh-luanji
 */

import { createStore } from './host/store.js'
import * as intelligence from './host/search.js'
import { createHandler, ROUTE } from './host/routes.js'
import { createCloudService } from './host/cloud.js'
import { createSyncService } from './host/sync.js'
import { sanitizedSyncConfig } from './host/sync-config.js'
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
  const sync = createSyncService({ store })
  const cloud = createCloudService({ config: config.cloud, store })
  const handler = createHandler(store, intelligence, {
    pkgDir: import.meta.dirname,
    cloud,
    sync,
    syncConfig: sanitizedSyncConfig,
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler,
      }),
    'dsh-luanji: /dsh-luanji api',
  )

  ctx.effect(() => ctx.tools.register(createLuanjiTool(store, intelligence, { onRecordChange: () => sync.notifyLocalChange() })), 'dsh-luanji: luanji tool')

  // 卸载/热重载时停止同步循环并取消在途请求。
  ctx.effect(() => () => sync.dispose(), 'dsh-luanji: sync engine cleanup')
}
