# 备份与恢复

原则：**同步不是备份**。两台设备互相同步时，一边的误删会忠实地传播到另一边；
备份让你能回到过去。先验证恢复一次，再依赖它。

## 服务端有什么

| 内容 | 位置（数据卷内） |
| --- | --- |
| SQLite 数据库（记录/变更日志/幂等回执/凭据哈希） | `/data/luanji.sqlite` |
| 附件文件（内容哈希寻址） | `/data/blobs/` |
| 每日一致性快照（默认保留 7 份） | `/data/snapshots/` |

快照一律用 `VACUUM INTO` 生成——**不要直接复制正在写入的数据库文件**。

## 自动快照

服务运行期间每天（默认凌晨 3 点，`LUANJI_SNAPSHOT_HOUR`）生成一份一致性快照并清理过期快照。
快照只是数据库：附件在 `/data/blobs`，不受快照窗口影响。

## 手动备份（数据库 + 附件）

```bash
docker compose -f server/compose.yaml exec luanji-sync \
  node src/admin.mjs backup --out /tmp/luanji-$(date +%F).tar.gz
docker cp luanji-sync:/tmp/luanji-….tar.gz ./            # 取出容器
gpg -c ./luanji-….tar.gz                                  # 加密后复制到独立位置
```

建议节奏：每日自动快照兜底 + 每周（或大量记图后）手动完整备份到**与服务不同的机器/位置**。

裸跑部署把 `docker compose … exec luanji-sync` 换成在 `server/` 目录直接运行
`node src/admin.mjs …`（`LUANJI_DATA_DIR` 指向数据目录）。

## 恢复

```bash
docker compose -f server/compose.yaml down        # 1. 停服务
docker run --rm -v /var/lib/docker/volumes/…_luanji-data/_data:/data \
  -v "$PWD:/host" node:24-bookworm-slim \
  node -e "/* 见下 */"                             # 3. 解包（或用一次性容器装 tar）
```

实际操作用一次性容器执行管理命令最简单：

```bash
# 2. 把备份放到宿主机某路径，如 /srv/restore/luanji-….tar.gz
docker run --rm -it \
  -v luanji-dsh-luanji_luanji-data:/data \
  -v /srv/restore:/restore \
  node:24-bookworm-slim bash -c "cd /app && \
    # 用仓库固定版本的管理命令恢复（也可以 git clone 后挂载）
    curl -fsSL https://github.com/Thomas-zz/dsh-luanji/archive/refs/tags/v<版本>.tar.gz | tar xz --strip-components=1 -C /tmp && \
    cp -r /tmp/server/src /tmp/server/migrations /app/ 2>/dev/null; \
    node /app/src/admin.mjs restore --in /restore/luanji-….tar.gz"
```

`restore` 会：

1. 解包并**先校验**备份库可打开、结构完整（坏备份不会碰现有数据）；
2. 把现有数据整体挪到 `/data/pre-restore-<时间戳>/`（可手动找回）；
3. 放入恢复的数据库与附件；
4. **更换 generation**。

裸跑部署直接 `node src/admin.mjs restore --in <备份文件>` 即可，然后重启服务。

## 恢复之后客户端会发生什么

generation 已变 → 每台客户端在下一轮同步时停止增量并提示“需要重新合并”；
到插件同步设置里点重新合并即可（双方内容合并、差异进冲突面板，不会静默丢数据）。
这是设计行为：**不能拿旧游标跳过恢复期间的数据**。

## 验证恢复（建议每次演练）

```bash
# 服务端：记录/附件可读
LUANJI_DATA_DIR=/data node src/admin.mjs snapshot && ls -la /data/snapshots
# 抽查 API：info 数量合理；changes cursor=0 重放含历史墓碑
curl -s -H "Authorization: Bearer <token>" https://notes.example.com/api/sync/v1/info
# 客户端：手机网页能登录、能看到恢复点之前的记录；桌面重新合并后无重复副本
```

## 空服务重建 / 换 generation

清空数据目录重新部署后，直接 `node src/admin.mjs space-rotate` 换掉 generation
（新库初始化时也会生成新的 spaceId/generation；只有“把旧库文件放回来”的场景必须显式轮换）。
