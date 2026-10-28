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

批量出图（推荐：一次 2~6 张，同一个对话排队跑，最后归档一次）：

```
agent → doubao_paint({
  prompts: [
    "橘猫趴窗台，水彩，方形",
    "柴犬雪地奔跑，油画，横版",
    "复古飞机穿云，扁平插画，横版"
  ]
})
```

批量模式比逐张开新对话省掉「切对话 + 归档」的开销，实测同对话连投不同主题**不串上下文**
（水彩猫 → 油画柴犬，各自独立）。建议同批主题相近，或者就是同一角色的系列图（一致性反而更好）。

> ⚠️ 豆包免费额度按天算（客户端显示「今日图片生成免费额度」）。额度用完时批量会提前收工，
> 返回里每条带 `额度用完` 标记，不会白等。

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

## 附：视频取用（`tools/video.mjs`）

借用豆包 `video-extract` 技能的脚本，下载在线视频 + 自动转 mp3，**不消耗对话额度、不用开豆包 UI**：

```powershell
node tools\video.mjs info "https://www.bilibili.com/video/BV..."          # 元数据（标题/时长/播放/封面）
node tools\video.mjs download "https://www.bilibili.com/video/BV..." --out D:\videos
```

支持 B站 / YouTube / TikTok / 快手 / 微博 / X / Instagram 等 20 个平台，产物是 mp4 + mp3 一对。

转写（逐字稿）依赖飞书妙记，需要 `lark-cli` 授权，未授权会失败——但 mp3 已经在本地，接 whisper 就能补。

---

## 附：直接调用豆包的技能脚本（`tools/skill.mjs`）

豆包把它的技能放在

```
%LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.skills\<技能名>\
```

每个技能 = `SKILL.md`（说明书）+ `scripts/`（Python 工具集）+ `references/`（平台文档）。
共 112 个技能，其中 47 个带脚本（`ppt` 265 个 py、`pdf` 18、`video-extract` 28…）。

**这些脚本可以在本地直接跑**，不走 UI、不消耗对话额度——用豆包自带的沙箱 Python：

```powershell
node tools\skill.mjs list                        # 112 个技能
node tools\skill.mjs read doubao-video-extract   # 看说明书
node tools\skill.mjs scripts pdf                 # 看有哪些脚本
node tools\skill.mjs run doubao-video-extract scripts/minutes/social_video_to_minutes.py -- "<url>" --media-mode video
```

实测能跑通的：视频下载（B站/YouTube/TikTok 等 20 个平台）、视频转音频、PDF/Word 分析工具。

**跑不通的**：生图、云端媒体处理、飞书妙记转写——这些脚本最终调云端接口，
需要豆包运行时注入的凭证（`DOUBAO_OFFICE_PLATFORM_APP_ID` 等），只能走豆包 UI。

小细节：跑脚本务必带 `PYTHONIOENCODING=utf-8`（`skill.mjs` 已经设好了），
否则 Windows 默认 GBK 会在输出中文时炸掉。

---

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉插件 |
| `cdpPort` | `9225` | CDP 端口；和别的调试程序冲突时改 |
| `appExe` | `D:\Doubao\app\Doubao.exe` | 豆包主程序（**不是** launcher） |
| `timeoutMs` | `180000` | 单张图等待上限 |
| `newChatPerTask` | `true` | 每单开新对话；关掉会写进你当前对话 |
| `outSubdir` | `doubao-images` | 输出目录（相对会话工作区） |
| `projectName` | `''`（不归档） | 可选：豆包侧边栏里的项目（分类文件夹）。填了名字才会自动建项目并把对话拖进去 |

### 对话模型：默认单会话，不归档

出图走**普通对话**（约 20~30 秒），批量模式在**同一个对话里**连投 2~6 条。
实测 5 连投：19.6 / 22.6 / 20.0 / 20.6 / 21.9 秒，**没有变慢、没有串上下文**
（水彩猫 → 油画狗 → 扁平飞机 → 水墨玫瑰 → 水彩灯塔，各自独立）。

因为都在一个会话里跑，对话列表不会被刷屏，所以**默认不做归档**——
没有「拖进项目」这一步，也就没有拖拽失败的问题。

想让 DSH 的出图对话单独归类，就在 `cordis.patch.yml` 里填 `projectName`
（插件会自动建项目，跑完拖进去）。归档是尽力而为的，批量模式下偶尔拖不准，
可以手动补一刀：

```powershell
node tools\archive.mjs
```

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
