-- 乱记同步服务初始结构。
-- 约定见 docs/sync-protocol-v1.md：
--  * records 保存当前版本和软删除状态；
--  * changes 保存不可变的变更快照（墓碑也是完整快照）；
--  * operation_receipts 与数据变更同事务写入，靠主键落实幂等。

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,      -- sha256(token)
  prefix     TEXT NOT NULL DEFAULT '',  -- 展示与撤销用（前 8 字符），不构成秘密
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

-- 手机登录口令（单人，仅一条）。scrypt 哈希存储。
CREATE TABLE IF NOT EXISTS phone_auth (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  password     TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id               TEXT PRIMARY KEY,
  text             TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'ui',
  quote_json       TEXT,                 -- 完整引用或 NULL
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,              -- 墓碑时间；NULL = 未删除
  rev              INTEGER NOT NULL      -- 服务端单调版本
);

CREATE TABLE IF NOT EXISTS changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,
  op          TEXT NOT NULL,             -- 'put' | 'delete'
  rev         INTEGER NOT NULL,
  record_json TEXT NOT NULL,             -- 不可变完整快照（含墓碑）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_id ON changes (id, seq);

CREATE TABLE IF NOT EXISTS operation_receipts (
  op_id       TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,            -- 请求体哈希：同 opId 不同内容拒绝
  result_json TEXT NOT NULL,             -- 原始结果，重试原样返回
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  hash       TEXT PRIMARY KEY,           -- sha256 十六进制
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
