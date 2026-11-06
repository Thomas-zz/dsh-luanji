#!/usr/bin/env node
/**
 * 手动同步「乱记兼容」云端服务的命令行入口。
 *
 * 面板里也能做（配置 cloud.url 之后出现「从云端拉取 / 推到云端」）；这个脚本
 * 用于首次把服务器上的旧数据搬进本机，或在没有界面时排查连接。
 *
 * 用法：
 *   LUANJI_CLOUD_URL=https://zjuan.club \
 *   LUANJI_CLOUD_COOKIE='session=...' \
 *   node scripts/sync-now.mjs
 *
 *   LUANJI_CLOUD_URL=... LUANJI_CLOUD_TOKEN=... node scripts/sync-now.mjs --push
 *   node scripts/sync-now.mjs --data-dir /path/to/luanji --dry-run
 *
 * 环境变量：
 *   LUANJI_CLOUD_URL      数据服务根地址（必填）
 *   LUANJI_CLOUD_TOKEN    Bearer token（可选）
 *   LUANJI_CLOUD_COOKIE   会话 Cookie（可选，二选一）
 *   LUANJI_DATA_DIR       本机笔记目录，默认 ~/.dsh/luanji
 *
 * 只做增量合并：同 id 以 updated_at 较新者为准；带引用的记录只留在本机。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createStore, defaultDataDir } from '../host/store.js'
import { createCloudService } from '../host/cloud.js'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dataDir = arg('--data-dir', process.env.LUANJI_DATA_DIR || defaultDataDir())
const url = process.env.LUANJI_CLOUD_URL || ''
const token = process.env.LUANJI_CLOUD_TOKEN || ''
const cookie = process.env.LUANJI_CLOUD_COOKIE || ''
const push = process.argv.includes('--push')
const dryRun = process.argv.includes('--dry-run')

if (!url) {
  console.error('缺少 LUANJI_CLOUD_URL。示例：LUANJI_CLOUD_URL=https://zjuan.club LUANJI_CLOUD_COOKIE="..." node scripts/sync-now.mjs')
  process.exit(2)
}

const store = createStore({ dataDir })
const cloud = createCloudService({ config: { url, token, cookie }, store })

console.log(`本机：${dataDir}（${store.count} 条）`)
console.log(`云端：${url}`)

try {
  if (push) {
    if (dryRun) {
      const payload = store.exportForCloud()
      console.log(`[dry-run] 可推送 ${payload.records.length} 条正文、${payload.images.length} 张图；跳过 ${payload.skippedQuoted} 条引用记录。`)
    } else {
      const result = await cloud.push()
      console.log(`推送完成：正文 ${result.records} 条，图片 ${result.images} 张，云端新增 ${result.added}、更新 ${result.updated}；跳过 ${result.skippedQuoted} 条引用记录。`)
    }
  } else {
    const result = await cloud.pull()
    console.log(`拉取完成：本机新增 ${result.added} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条；收下图片 ${result.images} 张${result.draft ? '，并入云端草稿' : ''}。`)
    if (result.imagesWarning) console.log(`注意：图片端点失败，只同步了文字（${result.imagesWarning}）。`)
  }
  console.log(`现在本机共 ${store.count} 条。`)
} catch (error) {
  cloud.recordError(error instanceof Error ? error : new Error(String(error)))
  console.error('同步失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}

// 确保测试/脚本退出前不挂住事件循环（fetch 的 keep-alive）。
process.exit(process.exitCode || 0)
