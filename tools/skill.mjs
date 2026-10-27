#!/usr/bin/env node
/**
 * 豆包技能调用器 —— 绕过 UI，直接用豆包客户端里那套技能脚本。
 *
 * 背景：豆包把 112 个技能放在
 *   %LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.skills\<名字>\
 * 每个技能 = SKILL.md（说明书）+ scripts/（Python 工具集）+ references/。
 * 其中的脚本大多能在本地直接跑（用豆包自带的沙箱 Python），不需要 UI、不消耗对话额度。
 *
 * 用法：
 *   node tools/skill.mjs list                      # 列出所有技能
 *   node tools/skill.mjs list --json               # 机器可读
 *   node tools/skill.mjs read doubao-video-extract # 看 SKILL.md
 *   node tools/skill.mjs scripts pdf               # 看这个技能有哪些脚本
 *   node tools/skill.mjs run doubao-video-extract scripts/minutes/social_video_to_minutes.py -- "<url>" --media-mode video
 *
 * 注意：
 *   - 走沙箱 Python（豆包自带），已设 UTF-8，避免 GBK 炸中文。
 *   - 需要云端认证的技能（生图/媒体处理/飞书）跑不通，脚本会自己报错——那些只能走豆包 UI。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const DOUBAO_UD = path.join(LOCAL, 'Doubao', 'User Data')
const SKILL_ROOT = path.join(DOUBAO_UD, 'Default', '.doubao', 'agent_mode', 'workspace', '.skills')
const SANDBOX_BASES = path.join(DOUBAO_UD, 'sandbox_runtime', 'bases')

/** 找沙箱里的 python.exe（豆包自己那套，依赖都在里面）。 */
function findSandboxPython() {
  const cands = []
  try {
    for (const d of fs.readdirSync(SANDBOX_BASES)) {
      cands.push(path.join(SANDBOX_BASES, d, 'python', 'python.exe'))
    }
  } catch { /* 没有就算了 */ }
  cands.push(path.join(LOCAL, 'Doubao', 'sandbox', 'python', 'python.exe'))
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* next */ }
  }
  return null
}

/** 读技能目录列表。 */
function listSkills() {
  if (!fs.existsSync(SKILL_ROOT)) return []
  const out = []
  for (const name of fs.readdirSync(SKILL_ROOT)) {
    const dir = path.join(SKILL_ROOT, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch { continue }
    const mdPath = path.join(dir, 'SKILL.md')
    let desc = ''
    let descEn = ''
    try {
      const md = fs.readFileSync(mdPath, 'utf8')
      const m = md.match(/^---\n([\s\S]*?)\n---/)
      if (m) {
        const dl = m[1].match(/description:\s*(.+)/)
        if (dl) desc = dl[1].trim().slice(0, 120)
      }
    } catch { /* 没说明书 */ }
    const scriptsDir = path.join(dir, 'scripts')
    let scriptCount = 0
    try {
      scriptCount = countFiles(scriptsDir, '.py')
    } catch { /* ignore */ }
    out.push({ name, hasSkillMd: fs.existsSync(mdPath), scripts: scriptCount, desc })
  }
  out.sort((a, b) => b.scripts - a.scripts || a.name.localeCompare(b.name))
  return out
}

function countFiles(dir, ext) {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name), ext)
    else if (e.name.endsWith(ext)) n++
  }
  return n
}

function resolveSkill(name) {
  if (!name) throw new Error('缺技能名（先 `node tools/skill.mjs list` 看有哪些）')
  const dir = path.join(SKILL_ROOT, name)
  if (!fs.existsSync(dir)) {
    const all = listSkills().map((s) => s.name)
    const near = all.filter((n) => n.includes(name) || name.includes(n)).slice(0, 5)
    throw new Error(`没有这个技能：${name}` + (near.length ? `\n相近的：${near.join(', ')}` : ''))
  }
  return dir
}

function cmdList(args) {
  const json = args.includes('--json')
  const rows = listSkills()
  if (json) { console.log(JSON.stringify(rows, null, 2)); return }
  console.log(`共 ${rows.length} 个技能（* = 带脚本，可直接跑）\n`)
  for (const r of rows) {
    const tag = r.scripts > 0 ? `*${r.scripts}`.padEnd(4) : ' -  '
    console.log(`${tag} ${r.name.padEnd(42)} ${r.desc.slice(0, 60)}`)
  }
  console.log('\n*N = 带 N 个 Python 脚本；没脚本的技能只能靠豆包 agent 跑。')
}

function cmdRead(args) {
  const name = args[0]
  const dir = resolveSkill(name)
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  console.log(md)
}

function cmdScripts(args) {
  const name = args[0]
  const dir = resolveSkill(name)
  const sdir = path.join(dir, 'scripts')
  if (!fs.existsSync(sdir)) { console.log('这个技能没有 scripts 目录'); return }
  const rows = []
  const walk = (d, prefix = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.join(prefix, e.name)
      if (e.isDirectory()) walk(path.join(d, e.name), rel)
      else if (e.name.endsWith('.py')) rows.push({ rel: rel.replace(/\\/g, '/'), size: fs.statSync(path.join(d, e.name)).size })
    }
  }
  walk(sdir)
  rows.sort((a, b) => b.size - a.size)
  for (const r of rows) console.log(`${String(Math.round(r.size / 1024)).padStart(5)}KB  scripts/${r.rel}`)
  const refDir = path.join(dir, 'references')
  if (fs.existsSync(refDir)) {
    console.log('\nreferences/:')
    for (const f of fs.readdirSync(refDir).slice(0, 20)) console.log('  ' + f)
  }
}

function cmdRun(args) {
  const name = args[0]
  const script = args[1]
  if (!script) throw new Error('用法：run <技能名> <脚本相对路径> -- [脚本参数...]')
  const dir = resolveSkill(name)
  const scriptPath = path.join(dir, script)
  if (!fs.existsSync(scriptPath)) throw new Error('脚本不存在：' + scriptPath)
  const sep = args.indexOf('--')
  const passthrough = sep >= 0 ? args.slice(sep + 1) : args.slice(2)
  const py = findSandboxPython()
  if (!py) throw new Error('找不到豆包沙箱的 python.exe（sandbox_runtime/bases/*/python/python.exe）')
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONPATH: dir,
  }
  console.error(`[skill] cwd=${dir}\n[skill] ${path.basename(py)} ${script} ${passthrough.join(' ')}`)
  const r = spawnSync(py, [scriptPath, ...passthrough], { cwd: dir, env, stdio: 'inherit' })
  if (r.error) throw r.error
  process.exitCode = r.status ?? 1
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (!cmd || cmd === '-h' || cmd === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*/, ''))
      return
    }
    switch (cmd) {
      case 'list': cmdList(rest); break
      case 'read': cmdRead(rest); break
      case 'scripts': cmdScripts(rest); break
      case 'run': cmdRun(rest); break
      default:
        console.error('未知命令：' + cmd + '\n可用：list / read / scripts / run')
        process.exitCode = 2
    }
  } catch (e) {
    console.error('❌ ' + (e?.message || e))
    process.exitCode = 1
  }
}

main()
