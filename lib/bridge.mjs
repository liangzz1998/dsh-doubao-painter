/**
 * 豆包 CDP 桥 —— 把本机「豆包」桌面客户端当成一台可编程的生图机器。
 *
 * 原理：豆包客户端是 Electron 应用（Chromium 147）。用
 *   Doubao.exe --remote-debugging-port=9225
 * 启动后，它会在 127.0.0.1:9225 暴露 Chrome DevTools Protocol。
 * 本模块通过 CDP 操作聊天页（chrome://doubao-chat/chat）：
 *   1. 开新对话（不污染用户正在聊的会话）
 *   2. 在 ProseMirror 输入框里打字并回车发送
 *   3. 轮询 DOM，等新生成的图片 URL 出现
 *   4. 挑出 CDN 上「cgen 版本」的 URL —— 实测该版本是**无水印**的原图
 *   5. 下载到本地
 *
 * 水印说明（2026-10 实测，豆包 2.32.5）：
 *   - 同一张图在 CDN 上有多个 URL 变体：
 *       ~tplv-...-cthumb_lwm3:<b64>.png   → 384x216 缩略图，右下角烧了「豆包 AI生成」
 *       ~tplv-...-cgen_wm0_hflow:<b64>.png → 2848x1600 原图，**无水印**
 *   - 所以「去水印」不需要图像修复：直接取 cgen URL 即可，成本 0。
 *   - 若某天 cgen 也带水印，再走上层的本地兜底（见 utils）。
 *
 * 这就是「便宜的办法」：不花钱、不糊图、不猜。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 豆包的默认安装位置（含 launcher 与主程序）。 */
export const DEFAULT_APP_EXE = 'D:\\Doubao\\app\\Doubao.exe'
export const DEFAULT_CDP_PORT = 9225
export const CHAT_URL_MARK = 'doubao-chat/chat'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一个极简 CDP 客户端（只依赖 Node 内置全局 WebSocket）。 */
export class CdpSession {
  constructor(ws, target) {
    this.ws = ws
    this.target = target
    this._id = 0
    this._pending = new Map()
    this._closed = false
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
      if (msg.id === undefined) return
      const p = this._pending.get(msg.id)
      if (!p) return
      this._pending.delete(msg.id)
      msg.error ? p.reject(new Error(`CDP ${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : p.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      this._closed = true
      for (const [, p] of this._pending) p.reject(new Error('CDP socket closed'))
      this._pending.clear()
    })
    ws.addEventListener('error', () => { /* close 事件会兜底 */ })
  }

  /** 发一条 CDP 命令，返回 result。 */
  send(method, params = {}, timeoutMs = 20000) {
    if (this._closed) return Promise.reject(new Error('CDP socket closed'))
    const id = ++this._id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
        method,
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e) }
    })
  }

  /** 在页面里执行一段 JS，返回其值。 */
  async evaluate(expression, timeoutMs = 30000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('页面脚本异常: ' + (d.exception?.description || d.text || JSON.stringify(d)).slice(0, 500))
    }
    return r.result?.value
  }

  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

/** 打开一个 WebSocket（带超时）。 */
function openWebSocket(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(new Error('当前 Node 没有全局 WebSocket（需要 Node ≥ 22），无法连 CDP'))
      return
    }
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('连接 CDP 超时: ' + url)) }, timeoutMs)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws) })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP 失败: ' + url)) })
  })
}

/** 探测 CDP 是否已就绪。 */
export async function isCdpAlive(port = DEFAULT_CDP_PORT, timeoutMs = 1500) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}

/** 列出所有 CDP target。 */
export async function listTargets(port = DEFAULT_CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`CDP /json/list 返回 ${res.status}`)
  return res.json()
}

/** 用带调试端口的方式拉起豆包（不接管已有进程）。 */
export function launchDoubao({ exe = DEFAULT_APP_EXE, port = DEFAULT_CDP_PORT } = {}) {
  if (!fs.existsSync(exe)) throw new Error(`找不到豆包主程序：${exe}\n请在插件设置里配置 doubaoAppExe`)
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

/** 豆包进程是否已经在跑（Windows）。用来区分「没开」和「开了但没调试端口」。 */
export function isDoubaoProcessRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Doubao.exe" /NH', {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    })
    return /Doubao\.exe/i.test(out)
  } catch { return false }
}

/** 等到 CDP 可用（或超时）。 */
export async function waitForCdp(port = DEFAULT_CDP_PORT, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCdpAlive(port)) return true
    await sleep(700)
  }
  return false
}

/** 从 URL 列表里挑出「无水印原图」候选。 */
export function pickBestImageUrls(urls) {
  const gen = [...new Set(urls.filter((u) => typeof u === 'string' && u.includes('rc_gen_image')))]
  if (gen.length === 0) return []
  // cgen = 生成图原图；实测无水印
  const cgen = gen.filter((u) => u.includes('cgen_'))
  if (cgen.length) return cgen
  // 退一步：非缩略图
  const nonThumb = gen.filter((u) => !u.includes('cthumb'))
  return nonThumb.length ? nonThumb : gen
}

/** 用图片路径（rc_gen_image/<hash>.<ext>）做去重键，忽略签名参数。 */
export function imageKey(url) {
  try {
    const m = String(url).match(/rc_gen_image\/([^~?]+)/)
    return m ? m[1] : String(url).slice(0, 200)
  } catch { return String(url).slice(0, 200) }
}

/** 下载图片到本地，返回 { file, bytes, width, height }。 */
export async function downloadImage(url, filePath, { referer = 'https://www.doubao.com/', timeoutMs = 60000 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        Referer: referer,
      },
    })
  } finally { clearTimeout(t) }
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}: ${url.slice(0, 160)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buf)
  return { file: filePath, bytes: buf.length }
}

/**
 * 单实例锁：豆包只有一个界面，同一时刻只能跑一个生图任务。
 * 用文件锁 + 过期时间，避免两个 agent 同时抢输入框。
 */
export class FileLock {
  constructor(lockFile, staleMs = 15 * 60 * 1000) {
    this.lockFile = lockFile
    this.staleMs = staleMs
    this.held = false
  }
  async acquire({ waitMs = 10 * 60 * 1000, pollMs = 800 } = {}) {
    const deadline = Date.now() + waitMs
    for (;;) {
      try {
        fs.mkdirSync(path.dirname(this.lockFile), { recursive: true })
        fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
        this.held = true
        return true
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        // 过期锁清理
        try {
          const st = fs.statSync(this.lockFile)
          let stale = Date.now() - st.mtimeMs > this.staleMs
          if (!stale) {
            try {
              const j = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
              if (j?.at && Date.now() - j.at > this.staleMs) stale = true
              if (j?.pid === process.pid) stale = true
            } catch { stale = true }
          }
          if (stale) { fs.unlinkSync(this.lockFile); continue }
        } catch { /* 被别人先删了，重试 */ }
        if (Date.now() > deadline) throw new Error('豆包正在被另一个任务占用（等待超时）')
        await sleep(pollMs)
      }
    }
  }
  release() {
    if (!this.held) return
    this.held = false
    try { fs.unlinkSync(this.lockFile) } catch { /* ignore */ }
  }
}

/**
 * 豆包桥：一次 connect → 一次生成。
 * 用法：
 *   const b = new DoubaoBridge({ port })
 *   await b.generate({ prompt, outDir })
 */
export class DoubaoBridge {
  constructor(options = {}) {
    this.port = options.port ?? DEFAULT_CDP_PORT
    this.appExe = options.appExe ?? DEFAULT_APP_EXE
    this.autoLaunch = options.autoLaunch ?? true
    this.session = null
  }

  /** 确保豆包进程带 CDP 端口在跑，并连上聊天页。 */
  async connect({ launchTimeoutMs = 60000 } = {}) {
    if (!(await isCdpAlive(this.port))) {
      if (!this.autoLaunch) {
        throw new Error(`豆包没有以调试模式运行（127.0.0.1:${this.port} 无响应）。\n` +
          `请先运行：\n  "${this.appExe}" --remote-debugging-port=${this.port}\n` +
          `或在插件设置里打开「自动启动豆包」。`)
      }
      // 豆包已经在普通模式下跑着：新实例不会抢到调试端口，先给出可操作的提示，
      // 别让调用方白等一分钟再超时。
      if (isDoubaoProcessRunning()) {
        throw new Error(
          '豆包正在运行，但没有开调试端口（不是插件启动的实例）。\n' +
          '请先完全退出豆包（托盘图标右键 → 退出，或在任务管理器结束 Doubao.exe），然后重试——\n' +
          `插件会用 "${this.appExe}" --remote-debugging-port=${this.port} 自动拉起它。`
        )
      }
      launchDoubao({ exe: this.appExe, port: this.port })
      const ok = await waitForCdp(this.port, launchTimeoutMs)
      if (!ok) throw new Error(`启动豆包后 ${launchTimeoutMs / 1000}s 内 CDP 仍不可用（端口 ${this.port}）。请确认豆包能正常启动并已登录。`)
    }
    const targets = await listTargets(this.port)
    const chat = targets.find((t) => (t.url || '').includes(CHAT_URL_MARK))
    if (!chat) throw new Error('连上了 CDP，但没找到豆包聊天页（chrome://doubao-chat/chat）。请确认豆包已登录并停在主界面。')
    const ws = await openWebSocket(chat.webSocketDebuggerUrl)
    this.session = new CdpSession(ws, chat)
    await this.session.send('Runtime.enable').catch(() => {})
    await this.session.send('Page.enable').catch(() => {})
    return this.session
  }

  close() {
    this.session?.close()
    this.session = null
  }

  /** 当前聊天页是否已登录（用 localStorage 的 has_login 标记判断）。 */
  async isLoggedIn() {
    try {
      return await this.session.evaluate(`(() => { try { return localStorage.getItem('flow_web_has_login') === 'true' || /用户\\d+/.test(document.body.innerText) } catch { return null } })()`)
    } catch { return null }
  }

  /** 开一个新对话（避免污染用户正在聊的会话）。返回是否成功。 */
  async newChat() {
    const clicked = await this.session.evaluate(`(() => {
      const cands = [...document.querySelectorAll('div,a,button')].filter((el) => {
        if (!el.offsetParent) return false
        const t = (el.innerText || '').trim()
        return t === '新对话' || t.startsWith('新对话 ') || t.startsWith('新对话\\n')
      })
      if (!cands.length) return { ok: false, reason: 'no-button' }
      const el = cands[0]
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
      }
      return { ok: true }
    })()`)
    if (!clicked?.ok) {
      // 兜底：键盘 Ctrl+Shift+K
      await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 10 })
      await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 10 })
    }
    await sleep(1800)
    // 等输入框出现并且为空
    for (let i = 0; i < 20; i++) {
      const state = await this.session.evaluate(`(() => {
        const el = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"]')
        if (!el) return { ok: false }
        return { ok: true, text: (el.innerText || '').trim().slice(0, 40) }
      })()`)
      if (state?.ok) return true
      await sleep(300)
    }
    return false
  }

  /** 把文字写进输入框（先清空旧草稿）。 */
  async type(text) {
    const focused = await this.session.evaluate(`(() => {
      const el = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"]')
      if (!el) return { ok: false, reason: 'no-input' }
      el.focus()
      // 清空已有内容（草稿）
      try {
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('delete', false, null)
      } catch {}
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
      return { ok: true }
    })()`)
    if (!focused?.ok) throw new Error('找不到豆包输入框（可能页面结构变了，或豆包没停在聊天页）')
    // insertText 会触发 ProseMirror 的 beforeinput，比直接改 innerText 可靠
    await this.session.send('Input.insertText', { text })
    await sleep(500)
    return true
  }

  /** 回车发送。 */
  async submit() {
    for (const type of ['keyDown', 'keyUp']) {
      await this.session.send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      })
    }
  }

  /** 读出页面上所有生成图 URL。 */
  async collectImageUrls() {
    return await this.session.evaluate(`(() => {
      const out = []
      for (const el of document.querySelectorAll('img')) {
        const u = el.currentSrc || el.src || ''
        if (u && u.includes('rc_gen_image')) out.push(u)
      }
      return out
    })()`)
  }

  /** 等生成完成：出现新的生成图 URL 且稳定下来。 */
  async waitForNewImages(beforeKeys, { timeoutMs = 180000, pollMs = 1500 } = {}) {
    const before = new Set(beforeKeys || [])
    const deadline = Date.now() + timeoutMs
    let last = []
    let lastText = ''
    while (Date.now() < deadline) {
      await sleep(pollMs)
      let urls = []
      try { urls = await this.collectImageUrls() } catch { continue }
      const fresh = urls.filter((u) => !before.has(imageKey(u)))
      last = urls
      try {
        lastText = await this.session.evaluate(`(document.body?.innerText || '').slice(-600)`)
      } catch { /* ignore */ }
      if (fresh.length > 0) {
        // 图片出现即视为生成完毕（豆包是生成完才挂图的）；
        // 「图片已生成」文案只是加分项——不同技能的文案不一样，不能只靠它。
        const hinted = /图片已生成|生成完成|已完成/.test(lastText || '')
        await sleep(hinted ? 700 : 1100)
        const urls2 = await this.collectImageUrls().catch(() => urls)
        const fresh2 = urls2.filter((u) => !before.has(imageKey(u)))
        if (fresh2.length > 0) {
          return {
            urls: pickBestImageUrls(fresh2),
            keys: [...new Set(fresh2.map(imageKey))],
            all: urls2,
            pageText: lastText,
          }
        }
        continue
      }
      // 出错提示提前结束
      if (/生成失败|无法生成|请稍后再试|额度不足|次数已用完/.test(lastText || '')) {
        return { urls: [], keys: [], all: last, pageText: lastText, error: (lastText || '').slice(-200) }
      }
    }
    const fresh = last.filter((u) => !before.has(imageKey(u)))
    return { urls: pickBestImageUrls(fresh), keys: [...new Set(fresh.map(imageKey))], all: last, pageText: lastText, timeout: true }
  }

  /** 点开一张生成图，让豆包把「原图 URL」挂进 DOM。 */
  async openPreviewForKey(key) {
    const ok = await this.session.evaluate(`(() => {
      const key = ${JSON.stringify(String(key))}
      const imgs = [...document.querySelectorAll('img')].filter((i) => (i.currentSrc || i.src || '').includes('rc_gen_image') && (i.currentSrc || i.src || '').includes(key))
      if (!imgs.length) return false
      const el = imgs[imgs.length - 1]
      try { el.scrollIntoView({ block: 'center' }) } catch {}
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
      }
      return true
    })()`)
    return Boolean(ok)
  }

  /** 关掉图片预览面板（Esc 优先，兜底点关闭按钮）。 */
  async closePreview() {
    for (const type of ['keyDown', 'keyUp']) {
      await this.session.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    }
    await sleep(500)
    const still = await this.session.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button,[role="button"]')].find((b) => {
        const t = (b.getAttribute('aria-label') || b.innerText || '').trim()
        return b.offsetParent && /^(关闭|close)$/i.test(t)
      })
      if (btn) { btn.click(); return 'clicked-close' }
      return 'no-close-button'
    })()`).catch(() => 'err')
    await sleep(400)
    return still
  }

  /**
   * 把缩略图 URL 升级成无水印原图 URL。
   * 豆包聊天流里默认只挂缩略图（cthumb = 带水印）；点开图片后才会挂 cgen（原图，无水印）。
   */
  async ensureOriginalUrls(keys) {
    if (!keys?.length) return []
    const current = await this.collectImageUrls()
    const have = current.filter((u) => u.includes('cgen_'))
    const haveKeys = new Set(have.map(imageKey))
    const missing = keys.filter((k) => !haveKeys.has(k))
    if (!missing.length) return have
    for (const k of missing) {
      const opened = await this.openPreviewForKey(k).catch(() => false)
      if (!opened) continue
      await sleep(2000)
      const urls = await this.collectImageUrls().catch(() => [])
      for (const u of urls) {
        if (u.includes('cgen_') && !have.includes(u)) have.push(u)
      }
      await this.closePreview().catch(() => {})
      await sleep(500)
    }
    return have
  }

  /** 上传参考图（图生图用）。 */
  async attachImages(filePaths) {
    if (!filePaths?.length) return false
    for (const p of filePaths) {
      if (!fs.existsSync(p)) throw new Error('参考图不存在: ' + p)
    }
    const doc = await this.session.send('DOM.getDocument', { depth: -1 })
    const q = await this.session.send('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    })
    if (!q.nodeIds?.length) throw new Error('没找到豆包的文件上传入口（页面结构可能变了）')
    // 优先选 accept 里含 png/jpg 的那个
    await this.session.send('DOM.setFileInputFiles', {
      nodeId: q.nodeIds[0],
      files: filePaths,
    })
    await sleep(2500) // 等上传完
    return true
  }

  /**
   * 生成一张图（或图生图）。
   * @param {object} req
   * @param {string} req.prompt 提示词
   * @param {string} [req.outDir] 输出目录
   * @param {string[]} [req.refImages] 参考图绝对路径（图生图）
   * @param {boolean} [req.newChat] 是否开新对话（默认 true）
   * @param {number} [req.timeoutMs]
   * @returns {Promise<{files: string[], urls: string[], pageText: string}>}
   */
  async generate(req) {
    const {
      prompt,
      outDir,
      refImages = [],
      newChat = true,
      timeoutMs = 180000,
      fileNamePrefix = 'doubao',
    } = req
    if (!prompt || !String(prompt).trim()) throw new Error('prompt 不能为空')

    if (!this.session) await this.connect()
    if (newChat) await this.newChat()

    if (refImages.length) await this.attachImages(refImages)

    const beforeKeys = (await this.collectImageUrls().catch(() => [])).map(imageKey)
    await this.type(prompt)
    await this.submit()

    const result = await this.waitForNewImages(beforeKeys, { timeoutMs })
    if (!result.urls.length) {
      throw new Error(
        '豆包没有返回图片。' +
        (result.error ? `页面提示：${result.error}` : result.timeout ? '等待超时。' : '') +
        `\n页面尾部文本：${String(result.pageText || '').slice(-300)}`
      )
    }

    // 聊天流里先出现的是带水印缩略图；点开图片拿无水印原图（cgen）。
    let urls = result.urls
    let resolution = 'thumb'
    try {
      const originals = await this.ensureOriginalUrls(result.keys)
      const keySet = new Set(result.keys)
      const matched = originals.filter((u) => keySet.has(imageKey(u)))
      if (matched.length) {
        urls = matched
        resolution = 'original'
      }
    } catch { /* 拿不到原图就退回缩略图，至少别让任务失败 */ }

    const dir = outDir || path.resolve(process.cwd(), 'doubao-images')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const files = []
    let i = 0
    for (const url of urls) {
      const ext = /\.png/i.test(url) ? 'png' : (/\.jpe?g/i.test(url) ? 'jpg' : 'png')
      const file = path.join(dir, `${fileNamePrefix}-${stamp}-${++i}.${ext}`)
      try {
        await downloadImage(url, file)
        files.push(file)
      } catch (e) {
        // 一张失败不影响其它
        if (i === 1) throw e
      }
    }
    if (!files.length) throw new Error('图片 URL 拿到了，但下载全部失败')
    return { files, urls, pageText: result.pageText || '', resolution }
  }
}
