# 乱记同步协议 v1

版本：1（`protocolVersion: 1`）· 状态：已实现（server/ + host/sync.js + 手机网页共用）

一个同步服务实例服务**一个人的数据空间**。客户端（DSH 插件、手机网页）只绑定本协议，
不绑定 SQLite；实现兼容协议的其他服务也可以接入，但必须满足本文的幂等、版本与空间身份约束。

- 基地址：如 `https://notes.example.com`，全部接口在 `/api/sync/v1/` 下。
- 传输：HTTPS 必需（本机开发例外：`http://127.0.0.1` / `http://localhost`）。
  请求不跟随跨源重定向，凭据不放在 URL。
- 认证（二选一）：
  - 设备 Token：`Authorization: Bearer lj_…`（部署时管理命令生成，服务端只存哈希）；
  - 手机网页会话：`lj_session` Cookie（Secure / HttpOnly / SameSite=Strict），
    写操作另需 `X-CSRF-Token` 头。
- 协议版本头：客户端带 `X-Luanji-Protocol: 1`；服务端见到不兼容版本返回 501。

## 数据模型（wire 记录）

```json
{
  "id": "uuid",                     // 客户端生成的稳定 ID（≤150 字符）
  "text": "我的想法",               // ≤ 20000 字
  "source": "ui",                   // ui | agent | web | selection | dsh
  "created_at": 1790000000000,      // epoch 毫秒（业务时间，不参与冲突判定）
  "updated_at": 1790000000000,
  "quote": {                        // 不可变引用；可为 null
    "id": "quote-uuid",
    "text": "被引用的原文",
    "origin": {"role":"assistant","model":"模型名","sessionId":"…","sessionTitle":"…","messageId":"…","nodeKey":"…","turn":1,"seq":42},
    "anchor": {"start":0,"end":7,"exact":"被引用的原文","prefix":"…","suffix":"…"}
  },
  "attachments": [                  // ≤ 6 个；内容先经 blobs 上传
    {"id":"image-uuid","hash":"sha256-hex-64","mime":"image/png","size":12345,"name":"图片.png"}
  ],
  "deleted_at": null                // 非 null = 墓碑（软删除）
}
```

服务端另有单调递增的 `rev`（每条记录独立）与 `seq`（全局变更日志序号），
与业务时间分开，**不参与冲突胜负判断**。

默认限制（服务端可配）：正文 20000 字、每条 6 个附件、单附件 2 MiB、
附件总量 5 GiB（`QUOTA_EXCEEDED` 时本地内容保留，服务端返回明确错误）。

## 接口

### GET /api/sync/v1/info

只读。认证后返回协议版本、稳定空间身份与数量：

```json
{"ok":true,"protocolVersion":1,"spaceId":"uuid","generation":"uuid","activeCount":128,
 "limits":{"maxTextChars":20000,"maxAttachments":6,"maxBlobBytes":2097152,"quotaBytes":5368709120}}
```

- `spaceId`：数据空间身份，正常情况下终身不变；客户端绑定它。
- `generation`：空间“世代”。服务重建或从备份恢复后**必须更换**；
  客户端发现变化即停止增量同步并要求重新合并（拿旧游标继续跑会跳过恢复期间的数据）。

### POST /api/sync/v1/ops

提交一个操作（首期一次一条）。请求体：

```json
{"spaceId":"uuid","generation":"uuid","opId":"uuid","recordId":"uuid",
 "baseRev":0,"kind":"put","record":{ …上面 wire 记录… }}
```

- `baseRev=0` 代表创建；更新/删除必须携带所知 `rev`；`kind=delete` 不带 `record`。
- `opId` 在空间内唯一；**网络不确定时始终用原 opId + 原请求体重试**，不能重新生成。
- 幂等：opId 回执、records 当前版本、changes 不可变快照在同一数据库事务中写入。
  同 opId 同请求体 → 原样重放结果；同 opId 不同请求体 → 409 `OP_BODY_MISMATCH`。
- 冲突解决（保留本机/云端/两份）是**新的 opId**，基于最新远端 rev；再次冲突继续保留双方。

成功（200）：

```json
{"ok":true,"opId":"…","recordId":"…","rev":3,"seq":120}
```

结构化非成功结果（不当成成功，客户端按码处理）：

| HTTP | code | 含义与客户端动作 |
| --- | --- | --- |
| 409 | `REV_CONFLICT` | baseRev 过期；响应含 `remote:{rev, record}`，进冲突面板 |
| 200 | `NOT_FOUND` | 更新/删除的记录不存在；操作视为已达成，出队 |
| 200 | `ALREADY_DELETED` | 删除目标已是墓碑；操作视为已达成，出队 |
| 200 | `BLOB_MISSING` | 附件尚未上传，响应含 `missing:[hash]`；先 PUT blobs 再用**同一 opId**重试 |
| 400 | `INVALID_RECORD` | 记录不合法（超长、字段缺失等）；该操作永远无法接受，出队并明示 |
| 409 | `SPACE_CHANGED` | spaceId/generation 不匹配；停止增量同步，重新合并 |
| 409 | `OP_BODY_MISMATCH` | 同 opId 请求体不一致；停止并重新合并 |
| 401 | `UNAUTHORIZED` | 凭据无效；停止自动重试，等用户处理 |

墓碑之上可以复活：`kind=put` 携带墓碑的 rev 即恢复记录（`deleted_at` 置空、rev+1）。
`baseRev=0` 的 put 撞上已存在记录（含墓碑）按 `REV_CONFLICT` 处理——旧设备不能复活已确认删除。

### GET /api/sync/v1/changes?cursor=0&limit=100&upperBound=…&spaceId=…&generation=…

分页拉取不可变变更日志。响应：

```json
{"ok":true,"spaceId":"uuid","generation":"uuid","upperBound":120,
 "nextCursor":100,"hasMore":true,
 "changes":[{"seq":101,"id":"uuid","op":"put","rev":3,"record":{…完整快照…}}]}
```

- **分页轮次**：首次请求（不带 `upperBound`）在同一一致性读中确定上界
  （当前最大 seq）；后续页必须携带同一 `upperBound`，轮次结束后才能开始新一轮。
  轮次期间的新数据留到下一轮，不会被半路混入。
- `nextCursor` 由实际返回的变更确定；`hasMore` 表示本轮还有未拉取的变更。
- 页大小同时受条数（默认 100，上限 200）与字节（默认 1 MiB）约束。
- 变更日志**首版不清理**：`cursor=0` 可重放整个库（含墓碑），
  首次同步/重新合并由此完成，也让已删除数据参与初始化、避免旧记录复活。
- 客户端处理变更与推进游标必须在**同一次本地原子提交**里完成；
  有未上传本地修改的记录暂存远端版本，不允许被拉取静默覆盖。
- 上传接口的成功 seq 不能直接当作全局拉取游标（会跳过其他设备的变化）。

### PUT /api/sync/v1/blobs/:hash

上传附件。`:hash` 必须是内容 sha256（64 位十六进制，同时杜绝路径穿越）；
请求体为原始字节，`Content-Type` 给出图片 MIME（png/jpeg/webp/gif）。
超限返回 413 `PAYLOAD_TOO_LARGE`；总量超配额返回 413 `QUOTA_EXCEEDED`；
哈希不符返回 400 `INVALID_HASH`。重复上传同内容幂等（`deduplicated:true`）。

附件先上传、成功后再提交引用它的记录操作。

### GET /api/sync/v1/blobs/:hash

鉴权下载附件（设备 Token 或网页会话均可）。哈希寻址，内容不可变，
带 `ETag` 与长缓存头；仅限图片 MIME，永不作为 HTML 执行。

## 错误码总表

`UNAUTHORIZED` · `PROTOCOL_UNSUPPORTED` · `SPACE_CHANGED` · `REV_CONFLICT` ·
`INVALID_RECORD` · `INVALID_HASH` · `BLOB_MISSING` · `NOT_FOUND` ·
`ALREADY_DELETED` · `OP_BODY_MISMATCH` · `PAYLOAD_TOO_LARGE` · `QUOTA_EXCEEDED` ·
`RATE_LIMITED`

4xx 中需要用户介入的错误（认证、空间、配额）客户端停止无意义重试；
网络错误与暂时性 5xx 按 5s → 5min 指数退避加抖动重试。
API 整体限速默认 300 次/分钟（每凭据），超限 429 + `Retry-After: 30`。

## 客户端行为约定（v1 已实现）

- 同步默认关闭；本地保存立即成功，联网失败不影响继续编辑。
- 保存后 2 秒防抖触发；开启期间每 30 秒一轮；失败指数退避；单设备单循环，无 WebSocket。
- 上传使用冻结的操作快照：请求期间的新编辑排为新操作，旧确认只确认旧操作。
- 删除保留墓碑；首版不清理墓碑/幂等回执/变更日志。
- 冲突：baseRev 识别，不按设备时间排序；未解决的冲突只暂停该条，其余记录继续同步。
- 首次合并：同 ID 同内容去重；同 ID 不同内容且无共同基线 → 远端保留原 ID、
  本地复制成新 UUID（映射持久化，重跑不产生重复副本）；墓碑对撞进删除冲突。
- 密钥只存在 Host 侧私密配置（0600），不回传页面、不写日志、不进导出包。
- 草稿与设备设置不跨设备同步。

## 手机网页接口（同源会话）

手机网页复用同一 ops / changes / blobs 接口（Cookie + CSRF），另有两个只读便利接口：

- `POST /api/web/v1/login` `{password}` → 设置会话 Cookie，返回 `{csrf}`；
  登录失败限速（默认 15 分钟内 10 次）。
- `GET /api/web/v1/session` → 会话有效时返回 `{csrf}`（页面刷新后取回令牌）。
- `GET /api/web/v1/records?q=&offset=&limit=` / `GET /api/web/v1/records/:id`
  → 列表（SQLite 文本搜索：正文 + 引用原文）与详情，含服务端 rev 供编辑作 baseRev。

## 部署端管理命令

`node src/admin.mjs …`：`token-create` / `token-list` / `token-revoke` /
`password-set` / `snapshot` / `backup` / `restore` / `space-rotate`。
备份与恢复（含 generation 轮换）见 [sync-backup-restore.md](sync-backup-restore.md)。
