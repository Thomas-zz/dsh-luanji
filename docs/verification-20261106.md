# 验证记录：2026-11-06 · 乱记 0.3 → 0.4（原生划选动作条 + 提示条居中）

实现目录：`/Users/zhangzhiyuan/Documents/zzy/code/dsh-luanji`。本轮只改 Client 半（`client.js`、`test/fixture.html`、文档），Host 未动。

## 改动对照

1. **入口位置**：从 `sidebar.footer.action`（左下角）迁到 `sidebar.panellist`，order 5，排在「插件」下面、「自动化任务」上面。整行仍由 DSH 外壳渲染，插件只提供 16px 图标。
2. **点击反馈**：在文档捕获阶段拦截该行的点击，改为打开记录便签，不切换当前主面板；`⌘ / Ctrl + Shift + L` 同效。
3. **详情按钮**：行尾 38px 是进面板热区（视觉上是行尾 24px 小按钮），点击直接 `selectPanel('luanji')` 打开管理面板；折叠成图标轨道（行宽 < 120px）时热区失效、图标隐藏，点图标仍打开便签。便签标题栏另有一个「面板」入口，供键盘用户使用。
4. **引用层级**：便签、记录卡片、管理面板中引用块一律在上、自己的想法在下；引用头「引用 · 来源 · 会话名」单行截断。
5. **划选动作条（本轮重做）**：不再额外浮一层。改为注册 `uiConversation.interactions` 的 `luanji` 动作，在 DSH 原生 text-interaction 浮层里渲染**一排**按钮：`记录 / 引用并记录 / 引用文本`，外观直接使用原生令牌（`--dsw-alias-button-floating-fill`、`--dsw-elevation-panel`、`--dsw-font-xs-13`、999px 圆角）。`引用文本` 调用原生 `inputActions.insertQuote`，保留 DSH 原有行为。选中一句话只出现这一排。
6. **面板展示**：单列卡片 + 品牌图标区 + 条数 + 搜索胶囊；引用块带左侧强调色竖线；记录操作悬停显示；明暗两套表面、描边、阴影分开调。
7. **提示条（本轮重做）**：不再用 viewport 的 `left: 50%`，改为**对齐对话输入框（`[data-composer-seat]`）的横向中心**，并浮在输入框上方 12px。用 `position: fixed` 的居中容器包裹，避免和页面滚动/侧栏宽度产生偏移。
8. **兼容**：DSH 字体、圆角、边框、locale 文案、键盘、`prefers-reduced-motion` 均沿用。

### 关于「改造原生引用按钮」

先尝试直接把 `conversation.chat.text-interaction` 的 `quote` 键换成乱记的渲染器。该键已被 `@deepseek-ai/dsh-message-quotes` 占用，重复注册会让 message-quotes 启动失败（Web boot 报 `1 entry did not activate`），宿主没有提供「替换」语义，所以放弃这条路。

最终方案：注册独立 interaction id `luanji`，在原生浮层里渲染自己的动作排。DSH 的 `dispatch()` 按注册顺序找第一个 `open()` 的 handler 并返回它，本 profile 下乱记的 handler 先注册，因此原生 `引用文本` handler 不会打开，只出现乱记这一排；即使顺序变化，也只会出现其中一层，不会叠两层。

## 自动化

- `npm test`：24 / 24 通过（存储、搜索、工具、HTTP、导入导出、坏文件、v1 迁移等）。
- `node --check client.js` 通过。

## 真实 DSH Web 验收

独立 profile `luanji-web-test`（笔记目录指向临时目录，未触碰真实 `~/.dsh/luanji/notes.json`），端口 8138，真实 DSH Web 0.2.2-rc.1，使用 ego-browser 操作。

入口与面板（沿用上一轮结论，回归通过）：

- 左侧列表顺序为 新会话 / 插件 / **乱记** / 自动化任务 / 更多；「乱记」行在「插件」下面。折叠侧栏后小按钮隐藏、行尾留白收回。
- 点整行：便签出现在行右侧，`main` 面板不变；输入文字后保存，落盘、提示「已记录 / 撤销」、便签关闭；刷新后记录仍在。
- 点行尾 38px 区域：直接进入管理面板（`aria-current=page`），焦点落到面板；折叠成图标轨道时点图标仍打开便签。
- 便签位置跟随侧栏行；1291 ↔ 420 缩放重排；窄窗口变为底部卡片。
- 管理面板：卡片列表、引用在上、长引用展开/收起、悬停操作、删除后原句标记消失。
- 原句持久标记（CSS Custom Highlight API）刷新后恢复。

本轮新增 / 重做项：

- 划选一段 AI 消息后，**只有一层**浮动条：`记录 / 引用并记录 / 引用文本`；原来的 DSH「引用文本」胶囊和乱记独立动作条不再同时出现。
- 真实鼠标点击「记录」：选区在 mousedown 时不被清空（容器 `onPointerDown` 阻止默认），保存成功、提示出现、浮层收起。
- 「引用并记录」：打开带原文的便签，原文在输入框上方。
- 「引用文本」：把原文插入对话输入框（原生 `insertQuote` 行为保留）。
- 提示条：落盘后测量——提示条中心 `x = 782`，输入框 seat 中心 `x = 782`（1291 宽窗口）；提示条底边 653，输入框顶边 665（间距 12px）。明暗两套均验证。
- 暗色 / 亮色 / 420 窄窗口下动作排均不横向溢出。

截图说明：现场截图含真实对话内容，未随公开仓库发布；本地文档目录保留原图。


## 已知限制

- **动作条顺序依赖宿主**：乱记的 interaction 必须比 `message-quotes` 先注册，才能抢到这次划选。当前 profile 已验证成立；若未来 DSH 调整插件激活顺序，原生引用会先打开，乱记动作条不出现（不会出现两层，只是少了乱记入口）。升级 DSH 后值得回归一次。
- 不能直接占用 `quote` 键替换原生渲染器（会让 message-quotes 启动失败）。
- 「引用文本」按钮依赖 slot props 里的 `inputActions.insertQuote`；宿主若移除该 API，按钮会自动隐藏（`typeof ... === 'function'` 判断）。
- `sidebar.panellist` 每一行由 DSH 外壳渲染成一个 `<button>`；行尾热区用捕获阶段 click 的 `clientX` 判定（右侧 38px），行尾小按钮只是装饰、不嵌套交互控件。若 DSH 改动行布局宽度/内边距，38px 热区需要复核。
- 提示条按输入框 seat 居中；管理面板（无输入框）里回退为 viewport 底部居中。
- 桌面端到端点击仍需在 DSH Desktop 内确认；Web 端已用同一份 client/host 代码验收。
