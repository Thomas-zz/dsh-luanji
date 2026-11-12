# 部署乱记同步服务（luanji-sync-server）

适用：一台你自己的服务器（2 核 / 4GB 内存即可，已有 Docker 与反向代理的机器直接复用）。
一个容器服务一个人：API + 手机网页 + SQLite + 附件目录，全部数据在一个持久化卷里。

> 前提约定：HTTPS 与鉴权必需；API 端口只发布到宿主机回环，由反向代理对外。
> 公开仓库不要包含服务器地址、个人笔记、密钥或生产配置。

## 1. 部署（compose）

```bash
git clone https://github.com/Thomas-zz/dsh-luanji.git
cd dsh-luanji
git checkout <固定版本 tag>          # 用固定版本，不要漂在 main 上
docker compose -f server/compose.yaml up -d --build
docker compose -f server/compose.yaml ps   # 确认 healthy
```

可选：`cp server/.env.example server/.env` 按需调整限制（默认值见文件注释）。

无 Docker 的机器也可以裸跑（Node ≥ 20）：

```bash
cd server && npm install --omit=dev
LUANJI_DATA_DIR=/srv/luanji LUANJI_HOST=127.0.0.1 LUANJI_PORT=8390 node src/main.mjs
```

## 2. 生成凭据（一次性）

```bash
# 桌面/设备 Token：只显示这一次，立即复制到私密位置
docker compose -f server/compose.yaml exec luanji-sync \
  node src/admin.mjs token-create --name "我的 Mac"

# 手机登录口令（交互输入，不回显；至少 8 位）
docker compose -f server/compose.yaml exec luanji-sync \
  node src/admin.mjs password-set
```

- Token 服务端只存哈希；撤销：`token-list` 找到前缀后 `token-revoke --prefix lj_xxxxxxxx`。
- 手机口令与设备 Token 相互独立；撤销 Token 不影响手机登录，反之亦然。

## 3. 反向代理（HTTPS）

Nginx 示例（复用现有实例，独立 server 块，不动其他站点）：

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;          # 换成你的域名
    # 证书沿用你现有的证书管理方式（如 certbot / acme）
    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    client_max_body_size 8m;                # 单附件 2 MiB + 头部余量

    location / {
        proxy_pass http://127.0.0.1:8390;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
```

上传内容不会被当作 HTML 执行（附件仅限图片 MIME + nosniff）；
`location` 不要把附件目录映射成静态站点。

验证：`curl -s https://notes.example.com/api/sync/v1/info` 应返回
`{"ok":false,"code":"UNAUTHORIZED",…}`（未认证 = 服务与鉴权都在工作）。

## 4. 连接客户端

- **DSH 插件**：乱记面板 → 云端同步 · 配置自己的服务器 → 填服务地址与 Token →
  测试连接（只读，不上传）→ 启用同步并合并。密钥保存在本机 Host 私密配置，不进页面。
- **手机**：浏览器打开 `https://notes.example.com`，用第 2 步的口令登录。
  建议加到主屏幕；本期为在线入口，不承诺离线编辑。

## 5. 日常运维

| 事项 | 命令 / 说明 |
| --- | --- |
| 查看设备 | `… exec luanji-sync node src/admin.mjs token-list` |
| 撤销设备 | `… exec luanji-sync node src/admin.mjs token-revoke --prefix lj_xxxxxxxx` |
| 每日快照 | 自动（默认凌晨 3 点，保留 7 份，`LUANJI_SNAPSHOT_HOUR` 可调） |
| 手动备份 | `… exec luanji-sync node src/admin.mjs backup --out /tmp/luanji.tar.gz` 后复制出容器 |
| 恢复 | 见 [sync-backup-restore.md](sync-backup-restore.md)（先停服务，恢复后自动换 generation） |
| 升级版本 | `git fetch && git checkout <新tag> && docker compose -f server/compose.yaml up -d --build`（迁移自动执行） |
| 资源参考 | 2026-11 目标机器 2C/4GB/根盘余 42GB：单容器内存占用约 60–120MB，SQLite 个人规模 < 100MB |

## 6. 安全清单

- [ ] 对外只有 HTTPS（443），8390 端口仅回环（compose 默认已如此）
- [ ] Token 与口令不在聊天、日志、代码仓库中出现
- [ ] 手机口令 ≥ 8 位；登录限速默认开启
- [ ] 备份加密后存放在与服务不同的位置
- [ ] 恢复演练至少做过一次再依赖它（同步不是备份）
- [ ] 升级前先 `backup` 一份

## 7. 常见问题

- **测试连接报“地址不可达”**：检查域名解析、防火墙、compose 是否 healthy。
- **报“证书校验失败”**：证书过期或链不全；不要关闭 TLS 校验。
- **报“认证失败”**：Token 被撤销或复制不完整；重新 `token-create`。
- **手机登录被限速**：15 分钟后再试（`LUANJI_LOGIN_*` 可调）。
- **附件报 QUOTA_EXCEEDED**：本地内容不受影响；清理或调大 `LUANJI_QUOTA_BYTES`。
- **想换一台全新服务器**：旧空间导出（插件里导出 JSON）→ 新服务启用 → 重新合并；
  或直接恢复备份归档（记得它会触发所有客户端重新合并）。
