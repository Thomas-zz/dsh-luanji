# 验证记录：2026-11-06 · 乱记 0.5.0 云端同步

实现目录：`/Users/zhangzhiyuan/Documents/zzy/code/dsh-luanji`。本轮新增可选云端同步（Host 半 + 面板 UI + CLI），默认安装仍然完全本地。

## 实现

- `host/cloud.js`：配置解析（`url` / `token` / `cookie` / `headers` / `timeoutMs` / `paths`）、带超时和响应上限的请求、拉取合并、推送映射、`cloud-sync.json` 元数据。
- `host/store.js`：`importRemote()`（按 id + `updated_at` 合并，摘掉 `〔图:id〕` 标记、附云端图片、跳过超长正文、只在本地草稿为空时并入云端草稿）与 `exportForCloud()`（只推无引用记录；图片生成 4–16 位短 id 并写成 `〔图:id〕`）。
- `host/routes.js` / `index.js`：`GET /cloud`、`POST /cloud/pull`、`POST /cloud/push`；未配置时只报 `configured:false`，不联网。
- `client.js`：配置后管理面板出现「云端 · host / 上次拉取 / 从云端拉取 / 推到云端」；未配置时只在页脚提示「云端未配置（可选）」。
- `scripts/sync-now.mjs`：无界面时的拉取/推送 CLI，与面板共用同一合并逻辑。

## 自动化

`npm test`：32 / 32 通过。

- 存储、搜索、工具、HTTP 路由（原有 24 项）。
- 新增 8 项云端测试：配置规整（http(s)、鉴权头、超时夹取）；未配置时保持本地；拉取鉴权头、`〔图:id〕` 标记转图片、导入草稿；同 id 只按 `updated_at` 覆盖；超长正文跳过、图片端点失败不影响文字；401 报错并写元数据；推送只发无引用记录、图片短 id 与标记、Cookie 透传、无记录时不发请求。

## 真实服务器拉取（zjuan.club）

通过服务器上的乱记 API（`/api/luanji/state`、`/api/luanji/images`，管理员会话）真实拉取：

- 云端口径：9 条记录、1 张图片、草稿为空。
- 合并到本机 `~/.dsh/luanji/notes.json`：原有 3 条「只有引用」的记录保留，新增 9 条正文记录，共 12 条；`〔图:nicyhp〕` 标记已摘除，图片作为该记录的图片保存。
- 写入前备份：`notes.json.pre-cloud-20261106131754`；store 同时保留 `notes.json.bak`。
- 元数据 `cloud-sync.json`：`lastPullAt`、结果 `{added:9, updated:0, skipped:0, images:1, draft:false}`。
- 凭据只用于本次拉取，临时文件已删除；插件配置/仓库中没有写入会话 Cookie。

## 面板验证（隔离 profile + 本机假服务）

- 未配置：面板不出现云同步条，页脚显示「记录保存在本机 · 云端未配置（可选）」；插件正常加载。
- 配置 `cloud.url + token`：出现「云端 · 127.0.0.1:8139 / 尚未拉取」，拉取后提示「云端拉取完成：新增 2 条，更新 0 条」，列表刷新、`上次拉取` 时间更新。
- 假服务校验了 `Authorization: Bearer test-token`，未带 token 时返回 401；插件把 401 显示为可读错误。

## 已知限制

- 拉取使用服务器现有的管理员会话 Cookie，会过期；长期配置建议在数据服务上加 Bearer token 入口（`cloud.token` 已支持）。
- 云端模型只有正文：带引用的记录不推送；删除不同步；没有自动轮询，每次同步都是手动触发。
- 同步接口按 block6 的 `/api/luanji/*` 约定实现，`cloud.paths` 可改路径；只接受 `http(s)`，关闭跨源重定向，单次响应上限 64 MB。
- 桌面端 Host 半更新后需要重启 DSH 才出现云同步条；本机数据不依赖重启（`notes.json` 已更新，面板刷新即可看到新记录）。
