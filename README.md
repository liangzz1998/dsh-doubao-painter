# dsh-doubao-painter

把本机 **豆包桌面客户端**的生图能力接进 DeepSeek Harness：
agent 一句话 `doubao_paint`，豆包在后台出图，**直接拿回无水印高清原图**。

- 不逆向豆包私有接口
- 不需要火山方舟 API Key、不按张付费
- 不需要「去水印」——从源头拿的就是干净原图

---

## 先说水印这件事（这是本插件最值钱的部分）

同一张图在豆包 CDN 上有两个版本，实测（豆包 2.32.5 / 2026-10）：

| URL 里的模板 | 尺寸 | 水印 |
|---|---|---|
| `…-cthumb_lwm3:…png` | 384×216 | 右下角烧了「豆包 AI生成」 |
| `…-cgen_wm0_hflow:…png` | 2848×1600（图生图 2048×1152） | **无** |

聊天流里默认只挂 `cthumb`（缩略图）——这就是「豆包出的图带水印」的来源。
**点开图片**后豆包才会把 `cgen` 原图 URL 挂进 DOM。本插件做的就是：
等图 → 点开 → 抓 `cgen` → 下载。

所以「便宜的办法」不是找去水印工具（LaMa/IOPaint 要算力、裁切会毁构图、糊了还得修），
而是**在正确的层拿到本身就没有水印的那张图**：成本 0，画质还是 2K+ 原图。

> ⚠️ 合规提醒：如果生成的图要对外发布，按《人工智能生成合成内容标识办法》
> 等规定，AI 生成内容仍应做显著标识。本插件解决的是「素材被平台 logo 污染」，
> 不是让你绕过标识义务——请按自己所在地区/平台的规则来。

---

## 原理

豆包桌面端是 Electron（Chromium 147）。用调试端口启动它：

```powershell
"D:\Doubao\app\Doubao.exe" --remote-debugging-port=9225
```

它就在 `127.0.0.1:9225` 暴露 Chrome DevTools Protocol。插件通过 CDP：

1. 开一个新对话（不污染你正在聊的会话）
2. 往 ProseMirror 输入框里 `Input.insertText` 提示词、回车发送
3. 轮询 DOM 等 `rc_gen_image` 出现
4. 点开图片拿到 `cgen` 原图 URL
5. 下载到会话工作区的 `doubao-images/`

图生图（P 图）走文件输入：把参考图塞进豆包隐藏的 `input[type=file]`，等上传完再发指令。

---

## 安装

前提：

- 豆包桌面版已安装、**已登录**，且你机器上 `D:\Doubao\app\Doubao.exe` 存在（不是 launcher 那个 `D:\Doubao\Doubao.exe`）
- DSH 运行时自带 Node ≥ 22（插件跑子进程用）

```powershell
# 1. 把插件链进 desktop profile
#    这一步会把依赖写进 package.json，并自动把 "dsh-doubao-painter" 加进 dsh.profile.bundles
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-doubao-painter"

# 2. 如果 bundles 里没自动出现，手动在 ~/.dsh/profiles/desktop/package.json 的
#    dsh.profile.bundles 数组里加一行 "dsh-doubao-painter"

# 3. 重启 DeepSeek Harness（profile 的配置树只在启动时组装）
```

重启后问 agent「豆包在线吗」，它会调用 `doubao_status` 自检。

> 第一次调用 `doubao_paint` 时，如果豆包没在调试端口上跑，插件会自己用
> `--remote-debugging-port=9225` 拉起来。
> **如果豆包已经在普通模式下运行着**，需要先完全退出它（托盘 → 退出），
> 否则新实例不会抢端口。

---

## 使用

### agent 里（推荐）

```
用户：帮我画一张「戴墨镜的橘猫在赛博朋克街头」的图
agent → doubao_paint({ prompt: "..." })
     ← { files: ["<工作区>/doubao-images/doubao-....png"], seconds: 21.2 }
```

P 图/改图：

```
agent → doubao_paint({
  prompt: "把参考图改成水彩风，保留构图",
  ref_images: ["C:\\path\\to\\ref.png"]
})
```

### 命令行（排障 / 手动）

```powershell
# 文生图
node tools\paint.mjs "一只披着斗篷的柯基宇航员站在月球上，电影级光影"

# 图生图
node tools\paint.mjs "改成蒸汽朋克机械狗" --ref "C:\path\ref.png" --out ".\out" --json

# 机器可读（插件内部就是走这个）
echo '{"prompt":"..."}' | node tools\paint.mjs --stdin-json --json
```

---

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉插件 |
| `cdpPort` | `9225` | CDP 端口；和别的调试程序冲突时改 |
| `appExe` | `D:\Doubao\app\Doubao.exe` | 豆包主程序（**不是** launcher） |
| `timeoutMs` | `180000` | 单张图等待上限，正常 20~90 秒 |
| `newChatPerTask` | `true` | 每单开新对话；关掉会写进你当前对话 |
| `outSubdir` | `doubao-images` | 输出目录（相对会话工作区） |

---

## 已知限制（都是「用 UI」换来的）

- **会动你的豆包窗口**：任务进行中会点开图片预览、开新对话。别在它干活时手动操作豆包。
- **需要调试端口**：豆包必须由插件带 `--remote-debugging-port` 启动。从快捷方式正常启动的实例没有这个端口。
- **豆包改版会坏**：DOM 结构、CDN 模板名都可能变。坏了先跑 `node tools\paint.mjs "test" --json` 看报错，再改 `lib/bridge.mjs` 里的选择器。
- **串行**：豆包只有一个界面，插件用文件锁保证同一时刻只跑一个任务。
- **额度**：吃的是你豆包账号的免费额度（用页面上的「今日签到领 200 额度」那套）。
- **不保证多图**：豆包一次给几张由它自己决定，插件把拿到的都下下来。

---

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `CDP 仍不可用` | 豆包已在普通模式运行。完全退出豆包（托盘退出）后重试 |
| `没找到豆包聊天页` | 豆包没登录，或停在非聊天页。手动打开一次主界面 |
| `页面提示：额度不足` | 豆包免费额度用完了，去客户端签到/等明天 |
| 拿到 384×216 小图 | 原图升级那步没成功（预览没点开）。重跑一次；或看 `lib/bridge.mjs` 的 `openPreviewForKey` |
| 报 `找不到可执行脚本的 node` | 设环境变量 `DSH_NODE` 为真实 node 路径 |

---

## 文件

```
lib/bridge.mjs        CDP 驱动核心（连接/发消息/抓图/下载/原图升级）
lib/index.js          cordis 插件壳：注册 doubao_paint / doubao_status
lib/resolve-node.mjs  在 Electron 里找真 node
tools/paint.mjs       CLI（插件走子进程调它，也可手动用）
cordis.patch.yml      bundle patch
tests/plugin.test.mjs 离线测试（不启动豆包）
```

## License

MIT
