#!/usr/bin/env node
/**
 * 确保 server/ 依赖已安装（sync.test.mjs 会真实启动同步服务）。
 * 纯本地安装路径不受影响：不装 server 依赖时插件本身完全可用，
 * 只是 npm test 的同步端到端用例需要它。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const marker = path.join(root, 'server', 'node_modules', 'better-sqlite3')

if (fs.existsSync(marker)) process.exit(0)

console.log('[ensure-server-deps] 安装 server/ 依赖（同步测试需要 luanji-sync-server）…')
try {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: process.env,
  })
} catch (error) {
  console.error('[ensure-server-deps] 安装失败：' + (error instanceof Error ? error.message : error))
  console.error('同步端到端测试将无法运行；插件本地功能不受影响。')
  process.exit(1)
}
