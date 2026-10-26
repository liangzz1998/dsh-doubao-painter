/**
 * 找一个「真 node」来跑子进程脚本。
 *
 * 为什么需要这一步：DSH 桌面端的主进程是 Electron，process.execPath 指向
 * DeepSeek Harness.exe —— 它不带 ELECTRON_RUN_AS_NODE 的时候根本跑不了 JS 脚本。
 * 所以按 DSH_NODE → DSH 自带运行时 → PATH → Program Files 的顺序探一遍，
 * 并且用「写文件证明」的方式验证（Electron 进程退出码 0 不代表脚本真跑了）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cache = new Map()

/** 真跑一段 JS，确认这个可执行文件是 node。 */
export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-node-'))
    const proof = path.join(dir, 'proof')
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof], {
      env, stdio: 'ignore', windowsHide: true, timeout: 10000,
    })
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch { return false }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 解析 node 运行时；返回 { file, env }。 */
export function resolveRuntime(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  if (cache.has(dshHome)) return cache.get(dshHome)
  const env = process.env
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const platform = process.platform
  const current = process.execPath
  const electron = Boolean(process.versions.electron)
  const bin = platform === 'win32' ? 'node.exe' : 'node'

  const cands = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try {
      for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'dependencies', 'node', 'bin', bin))
    } catch { /* 没有这个运行时目录就算了 */ }
  }
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH ?? '').split(sep)) {
    if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  }
  if (platform === 'win32' && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (platform === 'darwin') cands.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  if (!electron) cands.push(current)

  for (const file of new Set(cands.filter(Boolean))) {
    try {
      if (fs.statSync(file).isFile() && probeRuntime(file, env)) {
        const out = { file, env: { ...env } }
        cache.set(dshHome, out)
        return out
      }
    } catch { /* 下一个候选 */ }
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probeRuntime(current, nodeEnv)) {
      const out = { file: current, env: nodeEnv }
      cache.set(dshHome, out)
      return out
    }
  }
  throw new Error('[dsh-doubao-painter] 找不到可执行脚本的 node 运行时；请把环境变量 DSH_NODE 设成真实 node 的绝对路径')
}
