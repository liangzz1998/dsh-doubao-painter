/**
 * dsh-doubao-painter —— 让 DSH 里的 agent 把生图任务交给本机「豆包」客户端。
 *
 * 做法：不碰豆包的私有接口，也不装一堆逆向依赖；用 Electron 自带的
 * Chrome DevTools Protocol（--remote-debugging-port）驱动豆包聊天界面，
 * 把提示词打进去、等图出来、把 CDN 上的「原图版本」下载下来。
 *
 * 水印：豆包同一张图在 CDN 有多个变体，`cgen` 版本实测无水印且是 2848×1600
 * 的高清原图（缩略图 `cthumb` 才烧了水印）。所以这里天然不产生去水印成本。
 *
 * 架构：插件只是薄壳。真正干活的是 tools/paint.mjs（独立 node 子进程）——
 * 这样不会被 Electron 主进程的 Node 能力限制，也不会卡住主进程。
 *
 * @module dsh-doubao-painter
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveRuntime } from './resolve-node.mjs'

export const name = 'dsh-doubao-painter'

/** 需要 DSH 的工具注册表与会话工作目录。 */
export const inject = ['tools', 'workingDirectory']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAINT_MJS = path.join(HERE, '..', 'tools', 'paint.mjs')

const DEFAULTS = {
  enabled: true,
  cdpPort: 9225,
  appExe: 'D:\\Doubao\\app\\Doubao.exe',
  timeoutMs: 180000,
  /** 每个任务开一个新对话，避免污染用户正在聊的会话 */
  newChatPerTask: true,
  /** 输出子目录名（相对会话工作区） */
  outSubdir: 'doubao-images',
  /** 豆包侧边栏里的项目（分类文件夹）：DSH 的对话都塞这里，不和用户的混在一起 */
  projectName: 'DSH 和豆包的秘密画室',
}

/** 合并配置。 */
export function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    enabled: c.enabled === undefined ? DEFAULTS.enabled : Boolean(c.enabled),
    cdpPort: num(c.cdpPort, DEFAULTS.cdpPort),
    appExe: typeof c.appExe === 'string' && c.appExe.trim() ? c.appExe.trim() : DEFAULTS.appExe,
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs),
    newChatPerTask: c.newChatPerTask === undefined ? DEFAULTS.newChatPerTask : Boolean(c.newChatPerTask),
    outSubdir: typeof c.outSubdir === 'string' && c.outSubdir.trim() ? c.outSubdir.trim() : DEFAULTS.outSubdir,
    projectName: typeof c.projectName === 'string' ? c.projectName.trim() : DEFAULTS.projectName,
  }
}

/**
 * 跑一次 tools/paint.mjs 子进程，返回它打印的 JSON。
 * @param {{file: string, env: object}} runtime
 * @param {object} payload
 * @param {{signal?: AbortSignal, timeoutMs: number}} opts
 */
function runPaint(runtime, payload, opts) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let child
    try {
      child = spawn(runtime.file, [PAINT_MJS, '--stdin-json', '--json'], {
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      finish({ ok: false, error: '启动 node 子进程失败: ' + (e?.message || e) })
      return
    }

    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: `豆包生成超时（>${Math.round(opts.timeoutMs / 1000)}s）` })
    }, opts.timeoutMs + 30000)

    const onAbort = () => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: '调用被取消' })
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'node 子进程错误: ' + (e?.message || e) }) })
    child.on('close', () => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = Buffer.concat(err).toString('utf8').trim()
      // 脚本约定：stdout 最后一个 JSON 对象就是结果
      const jsonText = stdout.startsWith('{') ? stdout : (stdout.slice(stdout.indexOf('{')) || '')
      try {
        const j = JSON.parse(jsonText)
        finish(j)
      } catch {
        finish({ ok: false, error: (stderr || stdout || '生成失败（无输出）').slice(0, 1200) })
      }
    })

    try {
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, error: '写入子进程失败: ' + (e?.message || e) })
    }
  })
}

const PAINT_DESCRIPTION = [
  '把生图/P图任务交给本机的「豆包」桌面客户端执行，返回无水印高清原图的本地路径。',
  '适用：用户要画图、生成插画/海报/头像/壁纸、按描述改图、换风格、换背景、加元素等。',
  '豆包（Seedream 底座）中文文字与画面质感强，这类活优先用它，不要自己用代码画图。',
  '文生图：只给 prompt。图生图/P图：再给 ref_images（本地图片的绝对路径数组）。',
  '返回后可用 read_image 工具把图展示给用户；需要交付到工作区时把文件复制过去。',
].join('\n')

const PAINT_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '生图描述。写清主体、风格、构图、光线、比例、图上要出现的文字（中文文字要逐字写准）。',
    },
    ref_images: {
      type: 'array',
      items: { type: 'string' },
      description: '参考图的本地绝对路径（可选，图生图/P图时用；可以多张）',
    },
    out_dir: {
      type: 'string',
      description: '输出目录（绝对路径，可选）。默认是当前会话工作区下的 doubao-images/',
    },
    timeout_ms: {
      type: 'number',
      description: '等待超时毫秒数（可选，默认 180000）',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const PAINT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: '生成图片的本地绝对路径' },
      urls: { type: 'array', items: { type: 'string' }, description: '豆包 CDN 上的原图地址（有时效）' },
      seconds: { type: 'number', description: '耗时（秒）' },
    },
    required: ['files'],
    additionalProperties: false,
  },
  render: (_args, value) => [{
    type: 'text',
    text: value.files.length
      ? `豆包出图完成（${value.seconds.toFixed(1)}s）：\n` + value.files.map((f) => '  ' + f).join('\n')
      : '豆包没有返回图片',
  }],
}

const STATUS_DESCRIPTION = [
  '检查本机豆包客户端是否处于「可被驱动」状态：CDP 调试端口是否在跑、是否已登录聊天页。',
  '生图报错时先用它排障。',
].join('\n')

/**
 * 插件入口。
 * @param {object} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  let runtime
  try {
    runtime = resolveRuntime(process.env.DSH_HOME)
  } catch (e) {
    console.error('[dsh-doubao-painter] ' + (e?.message || e))
    return
  }

  ctx.tools.register({
    name: 'doubao_paint',
    description: PAINT_DESCRIPTION,
    parameters: PAINT_PARAMETERS,
    output: PAINT_OUTPUT,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt 不能为空')

      const refImages = Array.isArray(args.ref_images) ? args.ref_images.filter((p) => typeof p === 'string' && p.trim()) : []
      for (const p of refImages) {
        if (!path.isAbsolute(p)) throw new Error(`ref_images 必须是绝对路径：${p}`)
        if (!fs.existsSync(p)) throw new Error(`参考图不存在：${p}`)
      }

      let outDir = args.out_dir
      if (!outDir) {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        outDir = path.join(cwd, config.outSubdir)
      }
      if (!path.isAbsolute(outDir)) throw new Error(`out_dir 必须是绝对路径：${outDir}`)

      const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : config.timeoutMs
      const result = await runPaint(runtime, {
        prompt,
        refImages,
        outDir,
        newChat: config.newChatPerTask,
        timeoutMs,
        cdpPort: config.cdpPort,
        appExe: config.appExe,
        projectName: config.projectName,
      }, { signal: exec.signal, timeoutMs })

      if (!result?.ok) throw new Error(result?.error || '豆包生成失败（无返回）')
      return {
        files: Array.isArray(result.files) ? result.files : [],
        urls: Array.isArray(result.urls) ? result.urls : [],
        seconds: Number(result.ms) > 0 ? Number(result.ms) / 1000 : 0,
      }
    },
  })

  ctx.tools.register({
    name: 'doubao_status',
    description: STATUS_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          cdpAlive: { type: 'boolean' },
          port: { type: 'number' },
          appExe: { type: 'string' },
          appExeExists: { type: 'boolean' },
          chatPageFound: { type: 'boolean' },
          loggedIn: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['cdpAlive'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.hint || (v.cdpAlive ? '豆包在线' : '豆包离线') }],
    },
    async execute() {
      const alive = await fetch(`http://127.0.0.1:${config.cdpPort}/json/version`).then((r) => r.ok).catch(() => false)
      const appExeExists = fs.existsSync(config.appExe)
      const result = { cdpAlive: alive, port: config.cdpPort, appExe: config.appExe, appExeExists, chatPageFound: false, loggedIn: false, hint: '' }
      if (!alive) {
        result.hint = appExeExists
          ? `豆包没有带调试端口运行。第一次调用 doubao_paint 会自动用 --remote-debugging-port=${config.cdpPort} 拉起它（如果豆包已经在运行但没有该端口，需要先完全退出豆包）。`
          : `找不到豆包主程序：${config.appExe}（请在插件配置 appExe 里改成实际路径）`
        return result
      }
      try {
        const list = await fetch(`http://127.0.0.1:${config.cdpPort}/json/list`).then((r) => r.json())
        const chat = list.find((t) => (t.url || '').includes('doubao-chat/chat'))
        result.chatPageFound = Boolean(chat)
        result.hint = chat ? '豆包在线，可以生图' : 'CDP 在线但没找到聊天页，请确认豆包停在上次的主界面'
      } catch (e) {
        result.hint = 'CDP 在跑但读取页面列表失败：' + (e?.message || e)
      }
      return result
    },
  })
}

export default { name, inject, apply }
