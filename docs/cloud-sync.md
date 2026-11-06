# 本地 + 云端：可选的数据服务

乱记默认**只读写本机**：`~/.dsh/luanji/notes.json`，不联网、不需要账号。云端是可选能力——你可以在插件配置里指向**自己的「乱记兼容」数据服务**，然后在面板里手动拉取 / 推送。

这一版不做自动后台同步，也不替用户选服务；配置了就出现同步入口，没配置就完全不出网。

## 配置

在 DSH profile 的 `cordis.patch.yml` 里覆写插件配置（和 `dataDir` 同一层）：

```yaml
- id: dsh-luanji
  name: '@dsh-external/dsh-luanji'
  config:
    cloud:
      url: https://zjuan.club        # 你的数据服务根地址（https 推荐）
      # 三种认证方式任选其一：
      # token: '粘贴一个长期 token'     # → Authorization: Bearer <token>
      # cookie: 'ADMIN_SESSION=...'    # → Cookie: <值>（浏览器里复制会话）
      # headers:
      #   X-Api-Key: '...'
      timeoutMs: 15000
```

- `token` / `cookie` / `headers` 可以同时存在，最终会合并进请求头。
- `paths` 可覆盖端点路径（默认见下方契约），例如 `paths: { state: '/api/luanji/state' }`。
- 配置里包含凭据时请把文件权限设为 `600`，不要提交到仓库。
- 配置改完需要重新加载插件（Host 半）或重启 DSH；面板里会多出「云端 · host」一行和两个同步按钮。

### 用 zjuan.club（block6）作为数据服务

block6 的乱记 API 用的是管理员会话 Cookie，不是长期 token：

1. 在 `https://zjuan.club` 登录管理员；
2. 浏览器开发者工具 → Application → Cookies → 找到会话 Cookie（服务端 `ADMIN_COOKIE` 对应的名字），复制成 `name=value`；
3. 填进 `cloud.cookie`。

会话过期后同步会报「云端请求失败：需要登录乱记」，重新复制 Cookie 即可。想要长期配置，建议在自己的数据服务上加一个 Bearer token 入口（见文末「服务端建议」）。

## 数据契约

任何实现下列三个端点的服务都可以接入（block6 的 `/api/luanji/*` 是参考实现）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/luanji/state` | `{ records: [{ id, text, source, created_at, updated_at }], draft?: string }` |
| `GET` | `/api/luanji/images` | `{ images: [{ id, data }] }`（可选；失败时只同步文字） |
| `POST` | `/api/luanji/import` | body `{ records, images }` → `{ added, updated }` |

- 所有请求都会带上配置里的认证头。
- `id` 是稳定的字符串（block6 用 UUID）；`created_at` / `updated_at` 是毫秒时间戳。
- 图片是 data URL；block6 约定正文里用 `〔图:<id>〕` 标记图片位置。

## 合并规则

拉取（云端 → 本机）：

- 按 `id` 去重：本机没有就新增；两边都有时，只有云端 `updated_at` 更新才覆盖，**不会删掉本机更晚的修改**。
- 正文里的 `〔图:id〕` 标记会被摘掉，并把对应云端图片挂到这条记录上（最多 6 张）。
- 超过本机 20,000 字的记录跳过并在结果里计数。
- 云端草稿只在本机草稿为空时并入。
- 带引用的本机记录不会因为云端同 id 更新而丢失引用。

推送（本机 → 云端）：

- 只推送**没有引用**的记录正文；引用（原话、来源、文本锚点）留在本机，因为当前云端模型只有纯文本。
- 本机图片会生成 4–16 位短 id，并以 `〔图:<id>〕` 标记附在正文末尾一起上传。
- 云端 import 按 `id` upsert，`updated_at` 较旧的不会覆盖云端。

两边都不做的事：**删除不同步**（没有墓碑）；自动轮询 / 实时同步。每次同步都是你手动点的一下。

## 命令行

首次搬数据或排查连接时，可以不走面板：

```bash
cd dsh-luanji

# 拉取（默认写 ~/.dsh/luanji）
LUANJI_CLOUD_URL=https://zjuan.club \
LUANJI_CLOUD_COOKIE='name=value' \
node scripts/sync-now.mjs

# 先看看会推什么，不真正推送
LUANJI_CLOUD_URL=... LUANJI_CLOUD_COOKIE='...' node scripts/sync-now.mjs --push --dry-run

# 推到云端 / 指定其他笔记目录
LUANJI_CLOUD_URL=... LUANJI_CLOUD_TOKEN=... node scripts/sync-now.mjs --push --data-dir /path/to/luanji
```

脚本使用和面板相同的合并逻辑；写入本机前由 store 自动保留 `notes.json.bak`。

## 服务端建议

- 给插件单独发一个 Bearer token（只读/读写分开更好），避免会话 Cookie 过期；
- 图片端点可以是可选的，插件在它失败时仍能同步文字；
- 如果服务端要多端同步，建议补上 `deleted_at` 墓碑和 `updated_at` 的单调钟，才能把「删除」也同步出去。

## 安全边界

- 默认不出网；只有配置了 `cloud.url` 才会请求。
- 请求只允许 `http(s)`，并关闭跨源重定向；单次响应上限 64 MB，超时默认 15 秒。
- 凭据以明文存在 DSH 的配置里，插件不会回传或展示它们（`GET /dsh-luanji/cloud` 只返回地址与同步时间）。
- 云端能看到什么取决于你的服务：推送到 block6 的是纯文本 + 图片，引用来源不会上传。
