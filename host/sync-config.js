/**
 * 同步私密配置：服务地址 + 设备 Token + 设备名。
 *
 * Token 只在 Host 侧使用，权限 0600 的私有配置文件保存（不回传页面、不写日志、
 * 不进导出包）；读取状态只能得到 hasToken，替换必须整体重填。
 *
 * @module dsh-luanji/host/sync-config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本机调试地址（http 只允许这些 host）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * 校验服务地址：必须是 http(s)；https 之外的 http 只允许本机回环。
 * @param {string} raw
 * @returns {{url: string, host: string} | {error: string}}
 */
export function validateSyncUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  let parsed
  try { parsed = new URL(value) } catch { return { error: '服务地址格式不正确。' } }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: '服务地址必须是 http(s)。' }
  if (parsed.username || parsed.password) return { error: '不要把凭据写进地址。' }
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) {
    return { error: '云端同步要求 HTTPS。本机开发调试可用 http://127.0.0.1 或 http://localhost。' }
  }
  return { url: value, host: parsed.host }
}

function configFile(dataDir) {
  return path.join(dataDir, 'sync-credentials.json')
}

/**
 * 读取私密配置。
 * @param {string} dataDir
 * @returns {{url: string, host: string, token: string, deviceName: string, hasToken: boolean} | null}
 */
export function readSyncConfig(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) return null
    const token = typeof raw.token === 'string' ? raw.token : ''
    return {
      url: url.replace(/\/+$/, ''),
      host: (() => { try { return new URL(url).host } catch { return '' } })(),
      token,
      deviceName: typeof raw.deviceName === 'string' && raw.deviceName.trim() ? raw.deviceName.trim() : defaultDeviceName(),
      hasToken: token.length > 0,
    }
  } catch {
    return null
  }
}

/**
 * 保存私密配置（token 留空表示保留现有值）。文件权限 0600，原子替换。
 *
 * @param {string} dataDir
 * @param {{url: string, token?: string, deviceName: string}} input
 */
export function writeSyncConfig(dataDir, input) {
  const check = validateSyncUrl(input.url)
  if (check.error) throw new Error(check.error)
  const existing = readSyncConfig(dataDir)
  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : (existing?.token || '')
  const next = {
    url: check.url,
    token,
    deviceName: String(input.deviceName || existing?.deviceName || defaultDeviceName()).trim().slice(0, 80),
    savedAt: Date.now(),
  }
  const file = configFile(dataDir)
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return readSyncConfig(dataDir)
}

/**
 * 脱敏视图（给页面/状态接口）：只有 hasToken，不回传明文。
 * @param {string} dataDir
 */
export function sanitizedSyncConfig(dataDir) {
  const config = readSyncConfig(dataDir)
  if (!config) return null
  return { url: config.url, host: config.host, deviceName: config.deviceName, hasToken: config.hasToken }
}

/** 默认设备名（自动填写，可改）。 */
export function defaultDeviceName() {
  return os.hostname() || '我的设备'
}
