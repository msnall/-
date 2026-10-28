# VideoAutomation

竖屏短视频 Remotion 工程。Bloom10 英语口播第一版已完成渲染与技术检查，待观看后确认交付。

全流程操作手册：[Markdown 版](docs/视频自动剪辑全流程说明.md) · [Word 版](docs/视频自动剪辑全流程说明.docx)。涵盖环境安装、Git、转录校对、分镜、HyperFrames、声音处理、渲染验收和下一条视频复用方法。

成片：`out/bloom10-first-cut/Bloom10-first-cut-r1.mp4`。以下保留各阶段操作记录；当前完整流程以操作手册为准。

## 启动预览

在 PowerShell 中执行：

```powershell
Set-Location F:\VideoAutomation
npm.cmd run dev
```

浏览器地址以终端输出为准。在 Studio 中选择 `Reel`，点击播放查看动画；按 Ctrl+C 停止开发服务。

## 测试画面

- Composition：`Reel`
- 尺寸：1080 × 1920
- 帧率：30fps
- 时长：90 帧（3 秒）
- 内容：中文环境测试、淡入文字、进度条。颜色仅用于环境验证，品牌样式尚未确认。

## 验证与构建

```powershell
npm.cmd run lint
npm.cmd run build
```

生成环境测试视频：

```powershell
npx.cmd remotion render src/index.ts Reel out/setup-test.mp4 --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe" --concurrency=2
```

## 目录用途

| 目录 | 用途 |
| --- | --- |
| src | Remotion 画面组件与视频规格 |
| public/recordings | 口播和主要拍摄素材 |
| public/screen-recordings | 屏幕录制素材 |
| public/images | 图片素材 |
| public/sound pack | 音效 |
| public/music pack | 背景音乐 |
| public/transcripts | 转录及字幕时间数据 |
| hyperframes | 后续独立特效项目 |
| brand | 后续品牌配置 |
| scripts | 后续转录和检查脚本 |
| bin | 后续本地工具 |
| out | 导出的测试画面和视频 |

安装依赖可运行 `npm.cmd ci`。保留 package-lock.json，以便复现依赖版本。
Remotion 官方文档：https://www.remotion.dev/docs/

## 当前验证记录（2026-10-27）

- ESLint 与 TypeScript 检查通过，Remotion bundle 构建通过。
- 使用已安装的 Chrome 完成 Reel 的 H.264 渲染；FFprobe 确认 1080×1920、30fps、90 帧、3 秒。
- 本地 Studio 的 /Reel 页面 HTTP 检查返回 200；导出样帧已检查中文显示。
- 模板 Remotion 版本为 4.0.539。其固定的 Zod 4.5.4 被 npm audit 标记受影响，因此 package.json 使用 overrides 将 Zod 固定为 4.6.7，当前 npm audit 为 0 告警。
- 此调整会触发 Remotion 的 Zod 版本不匹配提示。调整后的 lint、构建与完整测试视频渲染均通过；未来使用 Zod schema 相关功能时仍需验证兼容性。
- 创建工具已初始化 Git 并暂存文件，但首次提交未成功；本阶段未修改用户的 Git 身份配置。

## 第三步：本地转录工具（2026-10-27）

whisper.cpp 已编译，多语言 base 模型已下载并校验，官方 11 秒示例已完成转录和时间戳检查。详细路径、重建命令和验证结果见 [本地 Whisper 环境说明](docs/whisper-setup.md)。视频转录封装和中文素材验收将在下一步进行。

Git 身份已在当前项目配置，基础工程首次提交为 6e39d48；上方关于首次提交失败的说明为搭建时的历史记录。

## 第四步：视频转录脚本

已创建 scripts/transcribe.mjs，支持中文/空格路径、自动语言检测、--language、--model、--threads 和 --force。默认不覆盖已有输出，每次保留独立原始音频和日志。

```powershell
npm.cmd run transcribe -- "public/recordings/Bloom10/Bloom10-达人素材.mp4"
# 已有结果需要重跑时显式增加 --force
```

输出至 public/transcripts/，包含 TXT、{text,startMs,endMs} JSON、可读分组 SRT、review.json 和 meta.json。时间戳为 Whisper 估计短片段，不保证是语言学意义的逐词对齐。默认模型 base，原语言转录，不自动翻译。

第一条素材自动识别为西班牙语，已通过时间戳结构和脚本错误处理检查，文字仍待校对。详见 [Bloom10 转录验收](docs/bloom10-transcript-review.md)。

## 当前素材更新：英语市场

用户已在相同路径替换素材。当前 Bloom10 视频为 30.278 秒英语口播，已重新转录：116 个时间单元、14 条 SRT 字幕。上方的西语识别记录为历史结果；以当前 meta.json 中的 SHA-256 和 [最新验收说明](docs/bloom10-transcript-review.md) 为准。旧西语字幕已归档到 out/transcript-archive/。

转录脚本现在记录源文件 SHA-256、大小与修改时间，并在识别期间文件被替换时拒绝发布结果，避免同名素材更新后混淆字幕来源。

## 英语模型对照转录

small.en 模型已下载并通过官方 SHA-1 校验。当前 public/transcripts/Bloom10-达人素材.* 为 small.en 结果：115 个时间单元、14 条字幕。base 英语版已归档，重点差异和听校片段见 [最新字幕验收](docs/bloom10-transcript-review.md)。字幕仍为待听校机器稿，未按推测修改品牌与疑词。

## 字幕修订与分镜 r1

已根据用户明确确认将 go the bottle away 修订为 throw the bottle away；另生成 edited 系列文件，保留原识别稿。修订 SRT 共 18 条、每条最多两行。六段静帧与计划数据保存在 public/storyboards/bloom10/，详见 [分镜方案](docs/bloom10-storyboard-r1.md)。本轮尚未制作正式成片，品牌样式、数量图形和特殊效果仍待验收。

## HyperFrames 环境与标签样片

已创建 hyperframes/packaging-label/，验证并导出 2 秒透明标签和原片叠加演示，均为 1080×1920、30fps、60 帧。复用资产位于 public/effects/packaging-label.webm。完整检查、alpha 验证和复现说明见 [标签效果验收](docs/hyperframes-label-validation.md)。等待样片验收后再制作整条动态初剪。

## 第一条完整动态初剪

Composition：Bloom10FirstCut。主画面、18条修订字幕、已验收的HyperFrames标签与声音已接入。视频目标909帧、30fps、1080×1920。查看 [动态初剪说明](docs/bloom10-first-cut-r1.md)。当前工作样式见 brand/BRAND.md。

```powershell
npm.cmd run prepare:bloom10
npm.cmd run render:bloom10 -- --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm.cmd run verify:bloom10
```

HyperFrames标签预览已验收，其独立3017预览服务在进入整片阶段后已停止；可按该项目README重新启动。Remotion整片预览使用3000端口。
