#!/usr/bin/env node
/**
 * 视频取用工具 —— 直接借用豆包 video-extract 技能里的脚本。
 *
 * 能做的：解析在线视频（B站/YouTube/TikTok等 20 个平台）、下载 mp4、自动转出 mp3、拿元数据。
 * 不消耗豆包对话额度、不用开豆包 UI —— 用的是豆包自带沙箱 Python + 它本地的技能脚本。
 *
 * 用法：
 *   node tools/video.mjs info "<url>"                 # 只要元数据（标题/时长/播放/封面…）
 *   node tools/video.mjs download "<url>"             # 下载 mp4 + mp3 到当前目录
 *   node tools/video.mjs download "<url>" --out D:\videos
 *   node tools/video.mjs download "<url>" --json      # 机器可读
 *
 * 局限：转写（逐字稿）依赖飞书妙记，需要 lark-cli 授权，未授权时会失败——
 *       但 mp3 已经下到本地，接 whisper 之类就能补。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const DOUBAO_UD = path.join(LOCAL, 'Doubao', 'User Data')
const SKILL_DIR = path.join(DOUBAO_UD, 'Default', '.doubao', 'agent_mode', 'workspace', '.skills', 'doubao-video-extract')
const SCRIPT = path.join(SKILL_DIR, 'scripts', 'minutes', 'social_video_to_minutes.py')
const DOWNLOADS = path.join(SKILL_DIR, 'downloads')
const SANDBOX_BASES = path.join(DOUBAO_UD, 'sandbox_runtime', 'bases')

function findSandboxPython() {
  try {
    for (const d of fs.readdirSync(SANDBOX_BASES)) {
      const p = path.join(SANDBOX_BASES, d, 'python', 'python.exe')
      try { if (fs.statSync(p).isFile()) return p } catch { /* next */ }
    }
  } catch { /* ignore */ }
  return null
}

function ensureReady() {
  for (const [label, p] of [['豆包技能目录', SKILL_DIR], ['video-extract 脚本', SCRIPT]]) {
    if (!fs.existsSync(p)) throw new Error(`找不到${label}：${p}\n（需要本机装豆包客户端并至少用过一次视频提取）`)
  }
  const py = findSandboxPython()
  if (!py) throw new Error('找不到豆包沙箱的 python.exe（sandbox_runtime/bases/*/python/python.exe）')
  return py
}

/** 跑一次技能脚本，stdout 是 JSON。 */
function runScript(py, args, { cwd = SKILL_DIR } = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONPATH: SKILL_DIR }
  const r = spawnSync(py, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  const stdout = (r.stdout || '').trim()
  let json = null
  try { json = JSON.parse(stdout) } catch {
    // 脚本可能打印多行，取最后一个完整 JSON
    const idx = stdout.lastIndexOf('\n{')
    if (idx >= 0) { try { json = JSON.parse(stdout.slice(idx + 1)) } catch { /* ignore */ } }
  }
  return { status: r.status, stdout, stderr: r.stderr, json }
}

function pickFiles(before, after) {
  const fresh = []
  for (const [name, st] of Object.entries(after)) {
    if (!before[name] || before[name] !== st) fresh.push(name)
  }
  return fresh
}

function snapshotDownloads() {
  const snap = {}
  try {
    for (const n of fs.readdirSync(DOWNLOADS)) {
      const p = path.join(DOWNLOADS, n)
      try { snap[n] = fs.statSync(p).mtimeMs } catch { /* ignore */ }
    }
  } catch { /* 目录还没有 */ }
  return snap
}

function copyOut(names, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const copied = []
  for (const n of names) {
    const src = path.join(DOWNLOADS, n)
    if (!fs.existsSync(src)) continue
    const dst = path.join(outDir, n)
    fs.copyFileSync(src, dst)
    copied.push(dst)
  }
  return copied
}

function cmdInfo(url, opts) {
  if (!url) throw new Error('用法：info "<视频链接>"')
  const py = ensureReady()
  const r = runScript(py, [url, '--check', '--json'])
  if (opts.json) { console.log(JSON.stringify(r.json ?? { raw: r.stdout }, null, 2)); return }
  const d = r.json?.data || {}
  console.log(JSON.stringify(d, null, 2).slice(0, 2000))
  console.log(r.status === 0 ? '\n✅ 可解析' : '\n⚠️ 解析可能有问题（看上面的 success/error）')
}

function cmdDownload(url, opts) {
  if (!url) throw new Error('用法：download "<视频链接>" [--out 目录] [--json]')
  const py = ensureReady()
  const before = snapshotDownloads()
  const r = runScript(py, [url, '--media-mode', 'video'])
  const after = snapshotDownloads()
  const fresh = pickFiles(before, after)
  // 脚本会把 mp3 一起转出来，但重复下载时它的 mtime 可能没变；
  // 用「同前缀」把同一视频的 mp4/mp3 都捎上。
  const prefixes = new Set(fresh.map((n) => n.replace(/\.[^.]+$/, '')))
  let allNames = [...fresh]
  try {
    if (prefixes.size) {
      const extra = fs.readdirSync(DOWNLOADS).filter((n) => [...prefixes].some((p) => n.startsWith(p)))
      allNames = [...new Set([...fresh, ...extra])]
    }
  } catch { /* ignore */ }
  const outDir = path.resolve(opts.out || process.cwd())
  const copied = copyOut(allNames, outDir)
  const result = {
    ok: r.status === 0,
    url,
    downloads: allNames,
    files: copied,
    meta: r.json?.data?.video_info ?? r.json?.data?.metadata ?? null,
    stderr: r.stderr ? r.stderr.slice(-800) : '',
  }
  if (opts.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (r.status !== 0) {
    console.error('❌ 下载失败')
    console.error(r.stderr?.slice(-1200) || r.stdout?.slice(-1200))
    process.exitCode = 1
    return
  }
  console.log(`✅ 下载完成（${allNames.length} 个文件）`)
  for (const f of copied) console.log('  ' + f)
  if (result.meta) {
    const m = result.meta
    console.log(`\n${m.title || ''}`)
    if (m.duration) console.log(`时长 ${m.duration}s · 播放 ${m.stat?.view ?? '?'} · 点赞 ${m.stat?.like ?? '?'}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const opts = { json: false, out: '' }
  const pos = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '-h' || a === '--help') { cmdHelp(); return }
    else pos.push(a)
  }
  const url = pos[0]
  try {
    if (cmd === 'info') cmdInfo(url, opts)
    else if (cmd === 'download') cmdDownload(url, opts)
    else { cmdHelp(); process.exitCode = 2 }
  } catch (e) {
    console.error('❌ ' + (e?.message || e))
    process.exitCode = 1
  }
}

function cmdHelp() {
  console.log(`视频取用（借用豆包的 video-extract 技能脚本）

用法:
  node tools/video.mjs info "<url>"                  元数据
  node tools/video.mjs download "<url>" [--out 目录] [--json]

支持: B站 / YouTube / TikTok / 快手 / 微博 / X / Instagram / 抖音等 20 个平台
产物: mp4 + 自动转出的 mp3
备注: 转写需要飞书妙记授权，未授权会失败；mp3 在本地，接 whisper 即可`)
}

main()
