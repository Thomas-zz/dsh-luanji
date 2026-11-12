# 乱记 · dsh-luanji

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](#安装)
[![local first](https://img.shields.io/badge/local--first-%E9%BB%98%E8%AE%A4%E4%B8%8D%E4%B8%8A%E4%BC%A0-2ea043.svg)](#数据与隐私)
[![tests](https://img.shields.io/badge/tests-node--test-brightgreen.svg)](./test)

> **一句话：** 在 DSH 里和 AI 对话时，随手把一句话、一个念头、一张图留下来。先记住，不必先起标题、选分类。
>
> **In one line:** a local-first quick-capture plugin for DeepSeek Harness. Select a sentence, save it with your own thought, find it later — no titles, no tags, no friction.

![乱记面板](docs/screenshots/panel-light.png)

## 它是什么

乱记长在你和 AI 碰撞想法的地方：左侧面板一行「乱记」，点一下弹记录便签；划选对话里的原话，直接存成一条带出处的引用。所有内容默认只在本机一个 JSON 文件里，随时导出走人；想接自己的云端数据服务时，再手动配置。

- **本地优先**：默认不联网、不需要账号，数据在 `~/.dsh/luanji/notes.json`。
- **划选即记**：选中一句话，DSH 原生浮动条上直接「记录 / 引用并记录 / 引用文本」。
- **原文与想法分开存**：引用保留来源（模型、对话、文本锚点），自己的想法单独编辑；展示时引用在上、想法在下。
- **会回来**：原句在对话里以淡底 + 下划线标记，刷新/回到对话仍能恢复；记录可「回到对话」。
- **可选云端同步**：部署自己的 luanji-sync-server 后，电脑与手机多端同步（正文、引用来源、图片完整走同一套协议）；默认关闭、默认不联网（见 [docs/sync-deployment.md](docs/sync-deployment.md) 与 [docs/sync-protocol-v1.md](docs/sync-protocol-v1.md)）。

## 界面一览

划选对话里的原话，浮动条上直接「记录 / 引用并记录 / 引用文本」：

![划选记录](docs/screenshots/selection-light.png)

引用便签：原文在上、想法在下，来源（模型 · 会话）跟着走：

![引用便签](docs/screenshots/quote-light.png)

点侧栏「乱记」行，就近弹出速记便签，先记住、不必先起标题：

![快捷便签](docs/screenshots/capture-light.png)

管理面板：搜索、编辑、导入导出，明暗两套主题：

![管理面板（暗色）](docs/screenshots/panel-dark.png)

## 入口与操作

| 入口 | 操作 |
|---|---|
| 左侧面板「乱记」 | 点整行 → 就近弹出记录便签；点行尾小按钮 → 进入乱记面板 |
| 划选对话原文 | 原生浮动条：`记录` 直接存；`引用并记录` 先写想法；`引用文本` 放回输入框（DSH 原行为） |
| 乱记面板 | 直接记录、图片、搜索、编辑/删除、导入导出、云端同步 |

| 快捷键 | 作用 |
|---|---|
| `⌘ / Ctrl + Shift + L` | 打开记录便签 |
| `⌘ / Ctrl + Enter` | 保存当前输入 |
| `Esc` | 收起便签，保留草稿 |
| `⌘ / Ctrl + K` | 在面板聚焦搜索 |

便签、面板、引用分别保留草稿；输入停止约 400 ms 后写入本机。一条记录最多 6 张图片（PNG/JPEG/WebP/GIF，单文件 ≤ 20 MB，保存前缩到最长边 1600，最多 20,000 字）。

## 安装

> 环境：DeepSeek Harness（DSH）桌面端 / web profile。插件是 Host + Client 两半的 bundle，Host 需要 `webServer` 等平台服务。

**方式一：命令行（推荐）**

```bash
git clone https://github.com/Thomas-zz/dsh-luanji.git

# macOS 桌面端的 dsh CLI 在 app 内：
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 安装到你的 profile（link 方式，改代码即生效）
"$DSH" plugin --profile desktop add "$PWD/dsh-luanji"
```

然后重启 DSH 桌面端（Host 改动需要重启；`client.js` 改动保存后热更新）。

**方式二：插件管理器**

设置 → 插件 → 从本地目录安装 `dsh-luanji`，并确认 profile 的 `dsh.profile.bundles` 包含该 bundle。

**数据文件**

```
~/.dsh/luanji/notes.json        # 记录 + 引用 + 草稿 + 同步状态（v3）
~/.dsh/luanji/notes.json.bak    # 上一次写入前的备份
~/.dsh/luanji/notes.json.v2.bak # 从 v2 升级到 v3 时的完整旧格式备份（一次性）
~/.dsh/luanji/sync-credentials.json  # 云同步私密配置（0600；只有开启同步并保存后才有）
```

卸载：设置 → 插件里禁用/移除，或 `"$DSH" plugin --profile <profile> remove dsh-luanji`。

## 多端同步（可选，默认关闭）

默认完全本地、不联网。需要电脑和手机多端同步时：

1. **部署服务**：在自己的服务器上用 compose 一键部署 luanji-sync-server
   （一容器 = 一个人：API + 手机网页 + SQLite + 附件目录），见
   **[docs/sync-deployment.md](docs/sync-deployment.md)**；没有服务器经验可复制
   [docs/sync-deploy-prompt.md](docs/sync-deploy-prompt.md) 里的 AI 部署提示词。
2. **连接插件**：乱记面板 → 「云端同步 · 配置自己的服务器」→ 填服务地址 + 设备 Token →
   测试连接（只读）→ 启用同步并合并。地址与密钥保存在 Host 私密配置（0600），
   不进页面、不进导出包。
3. **手机**：浏览器打开服务地址，用部署时设置的手机口令登录——查看、搜索、
   新建、编辑、图片、删除/恢复，与桌面走同一套版本与冲突规则。

同步规则要点（详见 **[docs/sync-protocol-v1.md](docs/sync-protocol-v1.md)**）：

- 正文、引用来源、图片完整同步；草稿与设备设置不跨设备。
- 保存本地立即成功，断网不影响编辑；恢复后自动补传。
- 同一条两边都改过 → 冲突面板保留本机 / 云端 / 两份，不按时间覆盖。
- 删除走墓碑：旧设备上线不会复活已确认删除的记录。
- 服务重建/从备份恢复会要求重新合并，不会拿旧游标跳数据。
- 限制：一条记录最多 6 张图、单附件 2 MiB、附件总量默认 5 GiB（服务端可配）。
- 内容在自有服务器上服务端可读（无端到端加密），请如实知悉。

### 旧版「乱记兼容」云端（已停用为新同步让路）

早期版本支持手动拉取/推送「乱记兼容」数据服务（`config.cloud`，见
[docs/cloud-sync.md](docs/cloud-sync.md)）。新版同步开启后该入口自动停用，
两套协议不会同时写同一份数据；已有配置建议迁移到上面的新版同步。

## 数据与兼容

- v3 格式把 `records`（自己的内容）和 `quotes`（原始引用 + 来源）分开（`quoteId` 关联），另有 `drafts` 与 `sync`（同步元数据：绑定空间、游标、待办操作、冲突——与业务数据同一次原子写入）。
- v1/v2 旧数据自动升级，升级前保留完整 v2 备份；损坏文件永远不会被空库覆盖。
- 写入先写临时文件、`fsync`，再原子替换；单写入 Host 锁防止两个进程互相覆盖。
- 导入支持旧版文字记录与导出文件；导出 JSON 含图片，不含设备凭据、游标与在途操作。
- 搜索覆盖正文、引用原文、模型名和对话名，是文字/模糊匹配，不是语义搜索。

## 开发与验证

```bash
npm install               # 首次会同时安装 server/ 依赖（同步端到端测试需要）
npm test                  # 51 tests：store / routes / cloud / 同步端到端（A1-A13、A15）
npm run test:server       # 27 tests：luanji-sync-server 契约（协议/幂等/分页/附件/web/备份恢复）
npm run lint              # 全部源码 Node 语法检查
node test/dev-server.mjs 8129   # 隔离开发页（不碰真实笔记目录）
```

- [同步协议 v1](docs/sync-protocol-v1.md) · [部署指南](docs/sync-deployment.md) · [备份与恢复](docs/sync-backup-restore.md) · [AI 部署提示词](docs/sync-deploy-prompt.md)
- [产品与交互决策](docs/product-capture.md)
- [旧版云端同步设计（已停用）](docs/cloud-sync.md)
- [2026-11-05 记录与找回验证](docs/verification-20261105.md)
- [2026-11-10 同步功能交付验证](docs/verification-sync-20261110.md)
- [2026-11-06 界面改版验证](docs/verification-20261106.md)
- [2026-11-06 云端同步验证](docs/verification-cloud-sync.md)

主要文件：`client.js` 交互与主题；`host/store.js` 记录数据（v3 含同步元数据）；`host/sync.js` 同步引擎；`host/sync-config.js` 私密配置；`host/routes.js` 本机 API；`host/search.js` 搜索；`host/tool.js` agent 工具；`server/` 可独立部署的 luanji-sync-server（含手机网页）；`test/` 测试与隔离开发页。插件安装不需要 server/ 的依赖。

## 许可

[MIT](LICENSE)
