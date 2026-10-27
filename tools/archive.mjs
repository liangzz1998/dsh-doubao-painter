#!/usr/bin/env node
/**
 * 手动归档：把「最近」里最新的一条对话拖进 DSH 项目。
 *
 * 出图本身走普通对话（20 来秒），归档是单独一步——自动拖偶尔会因为刚生成完
 * 界面还在刷新而落空，这个命令用来补一刀。
 *
 * 用法：
 *   node tools/archive.mjs
 *   node tools/archive.mjs --project "DSH 和豆包的秘密画室"
 *   node tools/archive.mjs --json
 */
import { DoubaoBridge, DEFAULT_APP_EXE, DEFAULT_CDP_PORT, DEFAULT_PROJECT_NAME } from '../lib/bridge.mjs'

const argv = process.argv.slice(2)
let project = DEFAULT_PROJECT_NAME
let json = false
let cdp = DEFAULT_CDP_PORT
let exe = DEFAULT_APP_EXE

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--project') project = argv[++i]
  else if (a === '--json') json = true
  else if (a === '--cdp') cdp = Number(argv[++i])
  else if (a === '--exe') exe = argv[++i]
  else if (a === '-h' || a === '--help') {
    console.log('用法: node tools/archive.mjs [--project 项目名] [--json]')
    process.exit(0)
  } else throw new Error('未知参数: ' + a)
}

const bridge = new DoubaoBridge({ port: cdp, appExe: exe, projectName: project })
try {
  await bridge.connect()
  await bridge.ensureProject()
  const name = await bridge.moveLatestConversationToProject()
  if (json) console.log(JSON.stringify({ ok: !!name, moved: name }))
  else console.log(name ? `✅ 已归档：${name}` : '⚠️ 没找到可拖的对话（可能「最近」里没有新对话，或豆包界面改版了）')
  if (!name) process.exitCode = 1
} catch (e) {
  if (json) console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }))
  else console.error('❌ ' + (e?.message || e))
  process.exitCode = 1
} finally {
  bridge.close()
}
