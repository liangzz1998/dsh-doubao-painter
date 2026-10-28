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

/**
 * DSH 在豆包里单独开的「项目」（= 分类文件夹）。
 * 每张图都在这个项目里新开对话，用户自己的对话列表就不会被一堆生图任务刷屏。
 */
export const DEFAULT_PROJECT_NAME = 'DSH 和豆包的秘密画室'

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

/** 下载图片到本地，返回 { file, bytes }。扩展名按响应头的真实格式纠正（豆包 CDN 会返回 webp）。 */
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
  // URL 里的后缀（.jpeg~tplv-xxx.webp）不可靠，以 content-type 为准
  const ct = String(res.headers.get('content-type') || '').toLowerCase()
  let real = filePath
  const wantExt = ct.includes('webp') ? '.webp' : (ct.includes('jpeg') || ct.includes('jpg')) ? '.jpg' : ct.includes('png') ? '.png' : ''
  if (wantExt && !filePath.toLowerCase().endsWith(wantExt)) {
    real = filePath.replace(/\.\w+$/, wantExt)
  }
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, buf)
  return { file: real, bytes: buf.length }
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
    /** 项目名（归档用）：默认空 = 不归档。所有出图都在一个会话里，没有列表混乱问题 */
    this.projectName = typeof options.projectName === 'string'
      ? options.projectName.trim()
      : ''
    /** 复用同一个固定会话（默认 true）：所有出图都在一个对话里，不会把列表堆满 */
    this.reuseSession = options.reuseSession === undefined ? true : Boolean(options.reuseSession)
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

  /** 开一个新对话（避免污染用户正在聊的会话）。返回是否真的换到了一个新对话。 */
  async newChat() {
    const beforeUrl = await this.session.evaluate('location.href').catch(() => '')
    for (let attempt = 0; attempt < 2; attempt++) {
      const clicked = await this.session.evaluate(`(() => {
        const cands = [...document.querySelectorAll('div,a,button')].filter((el) => {
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) return false
          const t = (el.innerText || '').trim()
          return t === '新对话' || t.startsWith('新对话 ') || t.startsWith('新对话\\n')
        })
        if (!cands.length) return { ok: false, reason: 'no-button' }
        // 取最后一个：前面的可能是外层容器
        cands[cands.length - 1].click()
        return { ok: true }
      })()`)
      if (!clicked?.ok) {
        // 兜底：键盘 Ctrl+Shift+K
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 10 })
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 10 })
      }
      // 等 URL 真的换掉（豆包对话 URL 末尾带 conversation id）
      for (let i = 0; i < 25; i++) {
        await sleep(400)
        const st = await this.session.evaluate(`({ href: location.href })`).catch(() => null)
        if (st && st.href !== beforeUrl) return await this.waitForComposer()
      }
    }
    // URL 没变：可能本来就是新对话，也可能点击没生效——交给调用方判断
    return await this.waitForComposer()
  }

  /** 固定会话记录文件（记住 DSH 出图专用对话的 id）。 */
  get sessionFile() {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    return path.join(home, '.dsh', 'doubao-session.json')
  }

  /** 当前页面对应的 conversation id。 */
  async currentConversationId() {
    const href = await this.session.evaluate('location.href').catch(() => '')
    const m = String(href || '').match(/\/chat\/(\d+)/)
    return m ? m[1] : null
  }

  async readSessionId() {
    try {
      const j = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      return j && j.id ? String(j.id) : null
    } catch { return null }
  }

  async writeSessionId(id) {
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true })
      fs.writeFileSync(this.sessionFile, JSON.stringify({ id: String(id), at: new Date().toISOString() }, null, 2))
    } catch { /* 写不进去就算了，不影响出图 */ }
  }

  /** 按 id 打开对话（直接 Page.navigate，比点侧边栏稳）。 */
  async openSessionById(id) {
    if (!id) return false
    const cur = await this.currentConversationId()
    if (cur === String(id)) return true
    const target = `chrome://doubao-chat/chat/${id}`
    await this.session.send('Page.navigate', { url: target }).catch(() => {})
    await sleep(2600)
    const now = await this.currentConversationId()
    if (now !== String(id)) return false
    return await this.waitForComposer(8000)
  }

  /**
   * 打开（或创建）固定的出图会话。
   *
   * 注意：豆包的新对话在**发出第一条消息后**才有 conversation id
   * （发消息前 URL 是 chrome://doubao-chat/chat，没有 id），
   * 所以这里只负责「导航到已保存的会话」或「开一个空白新对话」，
   * id 的落盘交给 generate/generateBatch 在 submit 之后做。
   * @returns {Promise<string|null>} 复用的会话 id（新开时为 null）
   */
  async ensureSession() {
    const saved = await this.readSessionId()
    if (saved && await this.openSessionById(saved)) return saved
    await this.exitProjectContext()
    await this.newChat()
    return null
  }

  /** 发完消息后把当前会话 id 记下来（下次就能直接跳回来）。 */
  async rememberSession() {
    if (!this.reuseSession) return null
    for (let i = 0; i < 12; i++) {
      const id = await this.currentConversationId()
      if (id) { await this.writeSessionId(id); return id }
      await sleep(400)
    }
    return null
  }

  /** 等输入框（ProseMirror）就绪。 */
  async waitForComposer(timeoutMs = 9000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await this.session.evaluate(`(() => {
        const el = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"]')
        return !!(el && el.getBoundingClientRect().width > 0)
      })()`).catch(() => false)
      if (ok) return true
      await sleep(300)
    }
    return false
  }

  /** 在侧边栏里找项目行，返回它的位置；找不到返回 null。 */
  async findProjectRow() {
    return await this.session.evaluate(`(() => {
      const target = ${JSON.stringify(this.projectName)}
      const rows = [...document.querySelectorAll('[class*="project-row"]')]
      const row = rows.find((r) => (r.innerText || '').includes(target))
      if (!row) return null
      const b = row.getBoundingClientRect()
      if (b.width === 0) return null
      return { x: Math.round(b.left + 8), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) }
    })()`).catch(() => null)
  }

  /**
   * 确保豆包里存在 DSH 专属项目；没有就现场建一个。
   * 项目就是豆包侧边栏的「分类文件夹」——所有 DSH 发起的对话都往里塞。
   * @returns {Promise<boolean>} 项目是否就绪
   */
  async ensureProject() {
    if (await this.findProjectRow()) return true

    // hover「项目」分区，让「新建项目」按钮从 opacity-0 变成可点，然后点它
    const opened = await this.session.evaluate(`(() => {
      const h = [...document.querySelectorAll('div')].find((el) => el.getBoundingClientRect().width > 0 && (el.innerText || '').trim() === '项目')
      if (h) {
        const sec = h.closest('[role="button"]') || h.parentElement
        for (const t of ['mouseover', 'mouseenter', 'mousemove']) sec.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window }))
      }
      const btn = document.querySelector('[aria-label="新建项目"]')
      if (btn) btn.click()
      return !!btn
    })()`)
    if (!opened) throw new Error('找不到「新建项目」按钮（豆包界面可能改版了）')
    await sleep(1400)

    const focused = await this.session.evaluate(`(() => {
      const vis = [...document.querySelectorAll('input, textarea')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 40 && r.height > 16
      })
      const input = vis.find((el) => /项目名称|输入项目/i.test(el.getAttribute('placeholder') || '')) || vis[0]
      if (!input) return false
      input.focus()
      return true
    })()`)
    if (!focused) throw new Error('创建项目时没找到名称输入框（豆包界面可能改版了）')

    await this.session.send('Input.insertText', { text: this.projectName })
    await sleep(500)
    const created = await this.session.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (b.innerText || '').trim() === '创建'
      })
      if (!btns.length) return false
      btns[btns.length - 1].click()
      return true
    })()`)
    if (!created) throw new Error('创建项目时没找到「创建」按钮')
    await sleep(2200)
    return Boolean(await this.findProjectRow())
  }

  /**
   * 回到普通空间（点侧边栏「主对话」）。
   * 豆包一旦处于项目上下文里，连「新对话」也会继承项目的工作台流程，
   * 所以关掉项目隔离时要先把上下文退出来。
   */
  async exitProjectContext() {
    const clicked = await this.session.evaluate(`(() => {
      const el = [...document.querySelectorAll('a,div,button')].find((x) => {
        const t = (x.innerText || '').trim()
        return t === '主对话' && x.getBoundingClientRect().width > 0
      })
      if (!el) return false
      el.click()
      return true
    })()`).catch(() => false)
    if (clicked) await sleep(1200)
    return clicked
  }

  /**
   * 模拟一次指针拖拽。豆包侧边栏用 dnd-kit（pointer 事件驱动），
   * 关键点：按下后要「立刻」移动超过 5px 激活阈值，否则会被识别成点击。
   */
  async dragByPointer(x1, y1, x2, y2) {
    const s = this.session
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    // 1) 先把鼠标挪到起点，触发 hover，让这一行进入稳定状态
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' })
    await sleep(220)
    // 2) 按下
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 })
    // 3) 第一跳直接 16px，越过 dnd-kit 的 distance 激活约束
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + (dx / len) * 16),
      y: Math.round(y1 + (dy / len) * 16),
      button: 'left',
      buttons: 1,
    })
    await sleep(40)
    // 4) 快速走完剩下的路：拖太慢会触发 dnd-kit 的 auto-scroll，
    //    侧边栏一滚，项目行的落点就漂了。
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x1 + dx * t),
        y: Math.round(y1 + dy * t),
        button: 'left',
        buttons: 1,
      })
      await sleep(28)
    }
    // 5) 在目标上停一下再松手，给 drop 留出判定时间
    await sleep(420)
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(1800)
  }

  /** 等侧边栏布局静止（连续两次采样的对话行位置一致），刚出完图时很关键。 */
  async waitSidebarStable(timeoutMs = 7000) {
    const deadline = Date.now() + timeoutMs
    let prev = null
    while (Date.now() < deadline) {
      const sig = await this.session.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[class*="conversation-item"]')].slice(0, 10)
        return rows.map((el) => {
          const r = el.getBoundingClientRect()
          return Math.round(r.top) + ':' + Math.round(r.height)
        }).join('|')
      })()`).catch(() => '')
      if (sig && sig === prev) return true
      prev = sig
      await sleep(320)
    }
    return false
  }

  /** 检查某个标题是不是已经在项目里、且不在「最近」里了。 */
  async isArchivedToProject(name) {
    const key = String(name).slice(0, 24)
    return await this.session.evaluate(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const key = ${JSON.stringify(key)}
      const headers = [...document.querySelectorAll('[class*="section-header"]')]
      const recent = headers.find((s) => clean(s.innerText) === '最近')
      const recentTop = recent ? recent.getBoundingClientRect().bottom : 1e9
      const proj = [...document.querySelectorAll('[class*="project-row"]')].find((r) => {
        const b = r.getBoundingClientRect()
        return b.width > 0 && (r.innerText || '').includes(${JSON.stringify(this.projectName)})
      })
      if (!proj) return false
      const projTop = proj.getBoundingClientRect().top
      let inProject = false
      let stillRecent = false
      for (const el of document.querySelectorAll('[class*="conversation-item"]')) {
        const r = el.getBoundingClientRect()
        if (!clean(el.innerText).includes(key)) continue
        if (r.top > projTop && r.top < recentTop) inProject = true
        else if (r.top >= recentTop) stillRecent = true
      }
      return inProject && !stillRecent
    })()`).catch(() => false)
  }

  /** 列出「最近」区里的对话标题（用来找出刚生成的那个）。 */
  async listRecentNames() {
    return await this.session.evaluate(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const headers = [...document.querySelectorAll('[class*="section-header"]')]
      const recent = headers.find((s) => clean(s.innerText) === '最近')
      const ry = recent ? recent.getBoundingClientRect().bottom : 0
      return [...document.querySelectorAll('[class*="conversation-item"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.top > ry && clean(el.innerText)
        })
        .map((el) => clean(el.innerText).slice(0, 40))
    })()`).catch(() => [])
  }

  /**
   * 把「最近」里新出现的那个对话拖进 DSH 项目。
   *
   * 出图走普通对话（20 来秒），归档这一步靠拖拽（1 秒）。
   * 稳定性靠三件事：
   *   1. 拖之前等侧边栏布局静止（刚出完图时会插入新行、位置在变）
   *   2. 拖完校验「项目区有它 + 最近区没它」，不成立就重试（最多 3 次）
   *   3. 重试用 beforeNames 差集重新定位，不会越拖越偏
   *
   * @param {string[]} [beforeNames] 生成前的「最近」列表；用来精确找出这次新建的对话
   * @returns {Promise<string|null>} 被移动的对话标题
   */
  async moveLatestConversationToProject(beforeNames = []) {
    const before = new Set(beforeNames || [])

    // 1) 先等「刚生成的那条对话」真的出现在侧边栏里——它刚出来时列表还在长，
    //    此时去拖必然拖空。这一步比任何坐标校准都关键。
    let target = null
    for (let i = 0; i < 22; i++) {
      const names = await this.listRecentNames()
      const fresh = names.filter((n) => !before.has(n))
      if (fresh.length) { target = fresh[0]; break }
      await sleep(400)
    }
    if (!target) { console.error('[archive] 等不到新对话出现在「最近」'); return null }
    console.error('[archive] 目标对话:', target)

    // 2) 刚出完图界面还在刷新，先静一静；然后反复「拖最近区第一行 → 校验第一行变了」
    await sleep(2500)
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.waitSidebarStable(attempt === 0 ? 4000 : 2500)
      // 源行贴到窗口底部（y > 700）时拖拽容易失手，先把它滚到视口中间
      const recentName = (await this.listRecentNames())[0] || ''
      if (recentName) {
        await this.session.evaluate(`(() => {
          const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
          const item = [...document.querySelectorAll('[class*="conversation-item"]')]
            .find((el) => clean(el.innerText).includes(${JSON.stringify(recentName.slice(0, 18))}))
          if (item) {
            const r = item.getBoundingClientRect()
            if (r.top > window.innerHeight * 0.82) item.scrollIntoView({ block: 'center' })
          }
          return true
        })()`).catch(() => {})
        await sleep(500)
      }
      const beforeFirst = (await this.listRecentNames())[0] || null
      const geo = await this.session.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
        const H = window.innerHeight
        const headers = [...document.querySelectorAll('[class*="section-header"]')]
        const recent = headers.find((s) => clean(s.innerText) === '最近')
        const ry = recent ? recent.getBoundingClientRect().bottom : 0
        const rows = [...document.querySelectorAll('[class*="conversation-item"]')].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.top >= 0 && r.bottom <= H && clean(el.innerText)
        })
        const item = rows.filter((el) => el.getBoundingClientRect().top > ry)[0] || rows[0]
        const proj = [...document.querySelectorAll('[class*="project-row"]')].find((r) => {
          const b = r.getBoundingClientRect()
          return b.width > 0 && (r.innerText || '').includes(${JSON.stringify(this.projectName)})
        })
        if (!item || !proj) return { ok: false, hasItem: !!item, hasProj: !!proj }
        const ir = item.getBoundingClientRect()
        const pr = proj.getBoundingClientRect()
        return {
          ok: true,
          name: clean(item.innerText).slice(0, 40),
          src: { x: Math.round(ir.left + ir.width / 2), y: Math.round(ir.top + ir.height / 2) },
          // 落点压在项目行的名字区域（避开最左的展开箭头和右侧按钮）
          dst: { x: Math.round(pr.left + 70), y: Math.round(pr.top + pr.height / 2) },
        }
      })()`).catch(() => null)
      if (!geo?.ok) { console.error('[archive] 定位失败:', JSON.stringify(geo)); return null }
      console.error('[archive] 尝试', attempt + 1, 'src=', JSON.stringify(geo.src), 'dst=', JSON.stringify(geo.dst), 'name=', geo.name)
      const countBefore = (await this.listRecentNames()).length
      await this.dragByPointer(geo.src.x, geo.src.y, geo.dst.x, geo.dst.y)
      await sleep(1000)
      // 校验：最近区少了一行 = 这一行被拖走了。
      // 用「数量减少」而不是「第一行变了」——批量模式下可能有好几个同名对话，
      // 拖走第一个后第一行标题不变，用标题判断会误判失败。
      const countAfter = (await this.listRecentNames()).length
      const moved = countAfter < countBefore
      console.error('[archive] 结果:', moved, '| 最近区', countBefore, '->', countAfter)
      if (moved) return geo.name || beforeFirst
      await sleep(1200 + attempt * 600)
    }
    return null
  }

  /** 读当前对话的标题（页面标题去掉「- 豆包」后缀）。 */
  async getCurrentConversationTitle() {
    return await this.session.evaluate(`(() => (document.title || '').replace(/\\s*[-–—]\\s*豆包\\s*$/, '').trim())()`).catch(() => '')
  }

  /**
   * 按标题把「最近」里的某个对话拖进项目。
   *
   * 比差集法可靠：批量模式下对话是跑之前就建好的，标题又是异步生成的，
   * 差集经常找不到；而「当前打开的对话标题」一定是对的（跑完就在这个对话里）。
   * @param {string} title
   * @returns {Promise<string|null>}
   */
  async archiveConversationByTitle(title) {
    if (!title) return null
    const key = title.slice(0, 24)
    // 先点开它，让目标对话成为「当前项」——实测当前项拖拽成功率明显更高
    try {
      await this.session.evaluate(`(() => {
        const key = ${JSON.stringify(key)}
        const row = [...document.querySelectorAll('[class*="conversation-item"]')].find((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (el.innerText || '').includes(key)
        })
        if (!row) return false
        const btn = row.querySelector('button') || row
        btn.click()
        return true
      })()`)
    } catch { /* 点不到就继续 */ }
    await sleep(1800)
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitSidebarStable(attempt === 0 ? 5000 : 3000)
      const geo = await this.session.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
        const key = ${JSON.stringify(key)}
        const H = window.innerHeight
        const rows = [...document.querySelectorAll('[class*="conversation-item"]')].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.top >= 0 && r.bottom <= H && clean(el.innerText).includes(key)
        })
        const item = rows[0]
        const proj = [...document.querySelectorAll('[class*="project-row"]')].find((r) => {
          const b = r.getBoundingClientRect()
          return b.width > 0 && (r.innerText || '').includes(${JSON.stringify(this.projectName)})
        })
        if (!item || !proj) return { ok: false, hasItem: !!item, hasProj: !!proj }
        const ir = item.getBoundingClientRect()
        const pr = proj.getBoundingClientRect()
        return {
          ok: true,
          name: clean(item.innerText).slice(0, 40),
          src: { x: Math.round(ir.left + ir.width / 2), y: Math.round(ir.top + ir.height / 2) },
          dst: { x: Math.round(pr.left + 70), y: Math.round(pr.top + pr.height / 2) },
        }
      })()`).catch(() => null)
      if (!geo?.ok) { console.error('[archive] 按标题定位失败:', JSON.stringify(geo)); return null }
      const countBefore = (await this.listRecentNames()).length
      await this.dragByPointer(geo.src.x, geo.src.y, geo.dst.x, geo.dst.y)
      await sleep(1000)
      const countAfter = (await this.listRecentNames()).length
      const moved = countAfter < countBefore
      console.error('[archive] 按标题归档:', moved, '|', geo.name, '| 最近区', countBefore, '->', countAfter)
      if (moved) return geo.name || title
      await sleep(1200 + attempt * 600)
    }
    return null
  }


  /**
   * 清掉豆包侧边栏「草稿」区里没用的草稿（失败的任务会在那里堆残留）。
   * @param {{matchText?: string}} [opts] 只删包含该片段的草稿（防止误删用户自己的草稿）
   * @returns {Promise<number>} 删掉几条
   */
  async deleteDrafts(opts = {}) {
    const matchText = typeof opts.matchText === 'string' ? opts.matchText.trim() : ''
    let total = 0
    for (let round = 0; round < 5; round++) {
      const n = await this.session.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
        const match = ${JSON.stringify(matchText)}
        const headers = [...document.querySelectorAll('[class*="section-header"]')]
        const draft = headers.find((s) => clean(s.innerText) === '草稿')
        if (!draft) return 0
        const top = draft.getBoundingClientRect().bottom
        const next = headers.find((s) => {
          const t = clean(s.innerText)
          return (t === '置顶' || t === '项目' || t === '最近') && s.getBoundingClientRect().top > top
        })
        const limit = next ? next.getBoundingClientRect().top : top + 400
        const items = [...document.querySelectorAll('[class*="conversation-item"]')].filter((el) => {
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.top > top && r.top < limit)) return false
          if (match && !(el.innerText || '').includes(match)) return false
          return true
        })
        let n = 0
        for (const el of items) {
          const r = el.getBoundingClientRect()
          for (const t of ['mouseover', 'mouseenter', 'mousemove']) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, view: window }))
          }
          const btn = el.querySelector('[aria-label="从对话列表删除"]')
          if (btn) { btn.click(); n++ }
        }
        return n
      })()`).catch(() => 0)
      total += n
      if (!n) break
      await sleep(900)
      // 可能的二次确认
      await this.session.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(删除|确认|确定)$/.test((x.innerText || '').trim()) && x.getBoundingClientRect().width > 0)
        if (b) b.click()
        return !!b
      })()`).catch(() => false)
      await sleep(600)
    }
    return total
  }

  /**
   * 在 DSH 专属项目里开新对话。
   * 对话会挂在项目下，用户的「最近」列表不会被一堆生图任务刷屏。
   * @returns {Promise<boolean>} 是否成功在项目内开了对话
   */
  async newChatInProject() {
    await this.ensureProject()
    // 先关掉可能残留的弹层/菜单，免得挡住点击
    for (const type of ['keyDown', 'keyUp']) {
      await this.session.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    }
    await sleep(300)
    const clicked = await this.session.evaluate(`(() => {
      const target = ${JSON.stringify(this.projectName)}
      const rows = [...document.querySelectorAll('[class*="project-row"]')]
      const row = rows.find((r) => (r.innerText || '').includes(target))
      if (!row) return { ok: false, reason: 'no-row' }
      const b = row.getBoundingClientRect()
      // 行内按钮默认 opacity-0 + pointer-events-none，先派发 hover 让它们可点
      for (const t of ['mouseover', 'mouseenter', 'mousemove']) {
        row.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: b.left + 8, clientY: b.top + 8, view: window }))
      }
      const btn = row.querySelector('[aria-label="新对话"]')
      if (!btn) return { ok: false, reason: 'no-new-chat-btn' }
      btn.click()
      return { ok: true }
    })()`)
    if (!clicked?.ok) {
      // 兜底：没有项目内按钮就退回普通新对话，至少别把图生成到别的会话里
      await this.newChat()
      return false
    }
    await sleep(1800)
    return await this.waitForComposer()
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
   * @param {boolean} [req.archiveToProject] 出图后把对话拖进项目（默认 true，需 projectName 非空）
   * @param {number} [req.timeoutMs]
   * @returns {Promise<{files: string[], urls: string[], pageText: string}>}
   */
  async generate(req) {
    const {
      prompt,
      outDir,
      refImages = [],
      newChat = true,
      archiveToProject = true,
      timeoutMs = 180000,
      fileNamePrefix = 'doubao',
    } = req
    if (!prompt || !String(prompt).trim()) throw new Error('prompt 不能为空')

    if (!this.session) await this.connect()
    // 出图一律走普通对话（快）；默认复用同一个固定会话，避免把对话列表堆满
    if (newChat) {
      if (this.reuseSession) {
        await this.ensureSession()
      } else {
        await this.exitProjectContext()
        await this.newChat()
      }
    }
    // 记下「最近」里已有的对话，出图后靠差集找出这次新建的那个再拖走
    const beforeRecent = this.projectName ? await this.listRecentNames() : []

    if (refImages.length) await this.attachImages(refImages)

    const beforeKeys = (await this.collectImageUrls().catch(() => [])).map(imageKey)
    await this.type(prompt)
    await this.submit()
    // 发出第一条消息后才有 conversation id，这时候记下来，下次直接跳回来
    await this.rememberSession()

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
        const got = await downloadImage(url, file)
        files.push(got.file)
      } catch (e) {
        // 一张失败不影响其它
        if (i === 1) throw e
      }
    }
    if (!files.length) throw new Error('图片 URL 拿到了，但下载全部失败')

    // 出图完成后，把这次对话拖进 DSH 项目（普通对话出图 20 来秒，比项目工作台快 2~4 倍）
    let archived = null
    if (archiveToProject && this.projectName) {
      try {
        await this.ensureProject()
        archived = await this.moveLatestConversationToProject(beforeRecent)
      } catch { /* 归档失败不影响出图 */ }
    }
    return { files, urls, pageText: result.pageText || '', resolution, archived }
  }

  /**
   * 批量出图：**同一个对话**里连续投多个 prompt，跑完归档一次。
   *
   * 为什么要这样：每张图都开新对话 + 归档，开销大（切对话 1.8s + 拖拽 5s×重试）。
   * 实测同对话连投不同主题不会串上下文（水彩猫 → 油画柴犬，各自独立），
   * 所以一次开一个对话、连投 4~6 张、最后拖一次，能省掉一大半操作。
   *
   * 注意：
   *   - 同批次里主题越接近越好（同一角色系列图反而更稳）
   *   - 长对话里抓图靠「生成前后的图集差集」，所以每张都重新采样 beforeKeys
   *
   * @param {object} req
   * @param {string[]} req.prompts 提示词数组
   * @param {string} [req.outDir]
   * @param {boolean} [req.archiveToProject] 跑完把整个对话拖进项目（默认 true）
   * @param {number} [req.timeoutMs] 单张等待上限
   * @returns {Promise<{items: Array, archived: string|null}>}
   */
  async generateBatch(req) {
    const {
      prompts = [],
      outDir,
      archiveToProject = true,
      timeoutMs = 180000,
      fileNamePrefix = 'doubao',
    } = req
    if (!Array.isArray(prompts) || !prompts.length) throw new Error('prompts 不能为空')
    const clean = prompts.map((p) => String(p ?? '').trim()).filter(Boolean)
    if (!clean.length) throw new Error('prompts 里没有有效内容')

    if (!this.session) await this.connect()
    if (this.reuseSession) {
      await this.ensureSession()
    } else {
      await this.exitProjectContext()
      await this.newChat()
    }
    const beforeRecent = this.projectName ? await this.listRecentNames() : []

    const dir = outDir || path.resolve(process.cwd(), 'doubao-images')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const items = []

    for (let idx = 0; idx < clean.length; idx++) {
      const prompt = clean[idx]
      const item = { index: idx, prompt, files: [], urls: [], error: null, ms: 0 }
      const t0 = Date.now()
      try {
        const beforeKeys = (await this.collectImageUrls().catch(() => [])).map(imageKey)
        await this.type(prompt)
        await this.submit()
        if (idx === 0) await this.rememberSession()
        const result = await this.waitForNewImages(beforeKeys, { timeoutMs })
        if (!result.urls.length) {
          item.error = result.error || (result.timeout ? '等待超时' : '没等到图片')
          // 额度用完时提前收工，不白跑后面的
          if (/额度|订阅|次数/.test(String(result.pageText || ''))) {
            item.error = '额度用完'
            items.push(item)
            for (let k = idx + 1; k < clean.length; k++) items.push({ index: k, prompt: clean[k], files: [], urls: [], error: '额度用完，未执行', ms: 0 })
            break
          }
          items.push(item)
          continue
        }
        // 缩略图 → 无水印原图
        let urls = result.urls
        try {
          const originals = await this.ensureOriginalUrls(result.keys)
          const keySet = new Set(result.keys)
          const matched = originals.filter((u) => keySet.has(imageKey(u)))
          if (matched.length) urls = matched
        } catch { /* 退回缩略图 */ }
        item.urls = urls
        let n = 0
        for (const url of urls) {
          const ext = /\.png/i.test(url) ? 'png' : (/\.jpe?g/i.test(url) ? 'jpg' : 'png')
          const file = path.join(dir, `${fileNamePrefix}-${stamp}-b${idx + 1}-${++n}.${ext}`)
          try {
            const got = await downloadImage(url, file)
            item.files.push(got.file)
          } catch { /* 单张下载失败不影响批次 */ }
        }
      } catch (e) {
        item.error = String(e?.message || e).slice(0, 300)
      }
      item.ms = Date.now() - t0
      items.push(item)
      await sleep(900) // 给下一轮留点喘息，别把输入框顶满
    }

    let archived = null
    if (archiveToProject && this.projectName) {
      try {
        await this.ensureProject()
        // 批量跑完就停在这次的新对话里，用「当前对话标题」定位最可靠
        await sleep(1500)
        const title = await this.getCurrentConversationTitle()
        archived = await this.archiveConversationByTitle(title)
      } catch { /* 归档失败不影响出图 */ }
    }
    return { items, archived }
  }
}
