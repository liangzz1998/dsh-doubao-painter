#!/usr/bin/env node
/**
 * 豆包画画 · 命令行入口（也用于自测）
 *
 * 用法一（位置参数）：
 *   node tools/paint.mjs "一只戴墨镜的橘猫，赛博朋克霓虹街头"
 *   node tools/paint.mjs "把这张图改成水彩风" --ref "C:\path\ref.png" --out ".\out"
 *
 * 用法二（JSON over stdin，插件调用这个，免去命令行转义问题）：
 *   echo '{"prompt":"...","refImages":["C:\\a.png"],"outDir":"D:\\out"}' | node tools/paint.mjs --stdin-json --json
 *
 * 参数：
 *   --out <dir>      输出目录（默认 .\doubao-images）
 *   --ref <file>     参考图（可重复，图生图）
 *   --prompt <text>  提示词（也可作为位置参数）
 *   --cdp <port>     CDP 端口（默认 9225）
 *   --exe <path>     豆包主程序路径
 *   --no-new-chat    不新开对话（默认会新开，避免污染当前会话）
 *   --timeout <ms>   等待超时（默认 180000）
 *   --stdin-json     从 stdin 读 JSON 请求
 *   --json           输出 JSON
 */
import path from 'node:path'
import { DoubaoBridge, DEFAULT_APP_EXE, DEFAULT_CDP_PORT } from '../lib/bridge.mjs'

const argv = process.argv.slice(2)
const positional = []
const opts = { refs: [], out: '', cdp: DEFAULT_CDP_PORT, exe: DEFAULT_APP_EXE, newChat: true, timeout: 180000, json: false, stdinJson: false }

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  switch (a) {
    case '--out': opts.out = argv[++i]; break
    case '--ref': opts.refs.push(argv[++i]); break
    case '--prompt': opts.promptArg = argv[++i]; break
    case '--cdp': opts.cdp = Number(argv[++i]); break
    case '--exe': opts.exe = argv[++i]; break
    case '--no-new-chat': opts.newChat = false; break
    case '--timeout': opts.timeout = Number(argv[++i]); break
    case '--stdin-json': opts.stdinJson = true; break
    case '--json': opts.json = true; break
    case '-h': case '--help':
      console.log('用法: node tools/paint.mjs "<提示词>" [--ref 图片] [--out 目录] [--json]')
      console.log('   或: echo \'{"prompt":"..."}\' | node tools/paint.mjs --stdin-json --json')
      process.exit(0)
    default:
      if (a.startsWith('--')) throw new Error('未知参数: ' + a)
      positional.push(a)
  }
}

let req = {
  prompt: opts.promptArg || positional.join(' '),
  refImages: opts.refs,
  outDir: opts.out || path.resolve(process.cwd(), 'doubao-images'),
  newChat: opts.newChat,
  timeoutMs: opts.timeout,
  cdpPort: opts.cdp,
  appExe: opts.exe,
}

if (opts.stdinJson) {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw) {
    const j = JSON.parse(raw)
    req = {
      prompt: j.prompt ?? req.prompt,
      refImages: j.refImages ?? j.ref_images ?? req.refImages,
      outDir: j.outDir ?? j.out_dir ?? req.outDir,
      newChat: j.newChat ?? req.newChat,
      timeoutMs: j.timeoutMs ?? req.timeoutMs,
      cdpPort: j.cdpPort ?? req.cdpPort,
      appExe: j.appExe ?? req.appExe,
    }
  }
}

if (!req.prompt || !String(req.prompt).trim()) {
  const msg = '缺少提示词'
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }))
  else console.error(msg + '。用法: node tools/paint.mjs "<提示词>"')
  process.exit(2)
}

const bridge = new DoubaoBridge({ port: Number(req.cdpPort) || DEFAULT_CDP_PORT, appExe: req.appExe || DEFAULT_APP_EXE })
const started = Date.now()
try {
  await bridge.connect()
  const res = await bridge.generate({
    prompt: req.prompt,
    outDir: req.outDir,
    refImages: Array.isArray(req.refImages) ? req.refImages.filter(Boolean) : [],
    newChat: req.newChat !== false,
    timeoutMs: Number(req.timeoutMs) || 180000,
  })
  const ms = Date.now() - started
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ms, files: res.files, urls: res.urls, pageText: res.pageText }, null, 2))
  } else {
    console.log(`✅ 生成完成（${(ms / 1000).toFixed(1)}s）`)
    for (const f of res.files) console.log('  ' + f)
  }
} catch (e) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2))
  else console.error('❌ ' + (e?.message || e))
  process.exitCode = 1
} finally {
  bridge.close()
}
