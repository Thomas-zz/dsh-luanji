/**
 * 服务配置：全部来自环境变量，个人部署只需要数据目录。
 *
 * 生产环境建议 HTTPS 反向代理在前；API 端口默认只在容器网络/回环可见。
 *
 * @module luanji-sync-server/config
 */

import path from 'node:path'

/** 环境变量整数读取：缺省/非法时回落默认值。 */
function intEnv(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * 组装运行配置。
 *
 * @param {NodeJS.ProcessEnv} [env] - 环境变量（测试可注入）。
 * @returns {{
 *   dataDir: string, dbFile: string, blobDir: string, snapshotDir: string,
 *   host: string, port: number,
 *   maxTextChars: number, maxAttachments: number, maxBlobBytes: number, quotaBytes: number,
 *   maxBodyBytes: number, maxOpsBodyBytes: number, changesPageSize: number, changesPageBytes: number,
 *   sessionTtlMs: number, loginWindowMs: number, loginMaxFailures: number,
 *   rateLimitPerMinute: number, snapshotHour: number, snapshotKeep: number,
 * }}
 */
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.LUANJI_DATA_DIR || './data')
  return {
    dataDir,
    dbFile: path.join(dataDir, 'luanji.sqlite'),
    blobDir: path.join(dataDir, 'blobs'),
    snapshotDir: path.join(dataDir, 'snapshots'),
    host: env.LUANJI_HOST || '0.0.0.0',
    port: intEnv(env.LUANJI_PORT, 8390),
    // 记录限制：与插件端、README 保持一致（docs/sync-protocol-v1.md 为准）。
    maxTextChars: intEnv(env.LUANJI_MAX_TEXT_CHARS, 20000),
    maxAttachments: intEnv(env.LUANJI_MAX_ATTACHMENTS, 6),
    maxBlobBytes: intEnv(env.LUANJI_MAX_BLOB_BYTES, 2097152),
    quotaBytes: intEnv(env.LUANJI_QUOTA_BYTES, 5 * 1024 * 1024 * 1024),
    // 请求体上限：ops 走 JSON（附件只带元信息），上限远小于 blob 上传。
    maxBodyBytes: intEnv(env.LUANJI_MAX_BODY_BYTES, 4 * 1024 * 1024),
    maxOpsBodyBytes: intEnv(env.LUANJI_MAX_OPS_BODY_BYTES, 2 * 1024 * 1024),
    changesPageSize: Math.min(200, intEnv(env.LUANJI_CHANGES_PAGE_SIZE, 100)),
    changesPageBytes: intEnv(env.LUANJI_CHANGES_PAGE_BYTES, 1024 * 1024),
    sessionTtlMs: intEnv(env.LUANJI_SESSION_TTL_HOURS, 24 * 30) * 3600 * 1000,
    loginWindowMs: intEnv(env.LUANJI_LOGIN_WINDOW_MINUTES, 15) * 60 * 1000,
    loginMaxFailures: intEnv(env.LUANJI_LOGIN_MAX_FAILURES, 10),
    rateLimitPerMinute: intEnv(env.LUANJI_RATE_LIMIT_PER_MINUTE, 300),
    snapshotHour: Math.min(23, intEnv(env.LUANJI_SNAPSHOT_HOUR, 3)),
    snapshotKeep: intEnv(env.LUANJI_SNAPSHOT_KEEP, 7),
  }
}
