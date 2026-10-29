# edit-plan 剪辑配置说明（schemaVersion 1）

一条视频 = 一个 `projects/<id>/edit-plan.json`。渲染引擎只执行经过校验的配置；换素材、换标题、换颜色、换字幕样式、加镜头缩放或产品图，都只改这个文件，不改代码。

## 常用命令（PowerShell）

```powershell
Set-Location F:\VideoAutomation
# 1. 校验（schema、效果登记、素材存在与 SHA-256、逐帧素材、词锚点）
npm.cmd run plan:check -- projects/bloom10/edit-plan.json
# 2. 渲染（先自动校验；已存在的文件默认拒绝覆盖，禁止写入 public/）
npm.cmd run plan:render -- projects/bloom10/edit-plan.json out/bloom10/bloom10-r2.mp4
# 3. 自动质检（规格、帧数、时长、响度/真峰值、字幕时间、空白/冻结帧扫描、字幕与图形拼图）
npm.cmd run plan:verify -- projects/bloom10/edit-plan.json out/bloom10/bloom10-r2.mp4
# 4. 与参考版本逐帧对比（SSIM/PSNR、编码流与解码音频是否完全一致、响度）
npm.cmd run plan:compare -- out/bloom10-first-cut/Bloom10-first-cut-r1.mp4 out/bloom10/bloom10-r2.mp4
# 在 Studio 里预览：默认打开 Bloom10；预览其他配置先 plan:check，再用它生成的 props
npx.cmd remotion studio --props=out/edit-plans/bloom10-demo/render-props.json
```

`plan:render` 可选参数：`--overwrite`（明确要替换已有文件时）、`--concurrency=2`、`--frames=0-89`（只渲一段试看）、`--browser-executable=<chrome.exe>`（默认使用已安装的 Chrome）。

校验输出：`out/edit-plans/<id>/edit-plan.resolved.json` 是换算成成片帧号后的完整时间轴，可用来核对；`render-props.json` 是传给 Remotion 的输入。质检输出在 `<成片>.qc/`，对比输出在 `<成片>.compare/`。

## 两套时间

| 概念 | 单位 | 写在哪里 |
| --- | --- | --- |
| 原视频时间 | 毫秒，素材内部时间 | `segments[].sourceStartMs / sourceEndMs`，转录词时间 |
| 成片时间 | 帧，从 0 开始 | 由 segments 依次拼接算出；`{"frame": n}` 锚点 |

`segments` 按顺序保留原片片段，片段之间就是剪掉的部分（跳剪）。成片时长 = 各片段时长之和，不需要手写。

**锚点**（overlay 的 `from`/`until`、镜头 punch-in 的 `at`、音轨 `from`）四选一：

- `{"frame": 263}`：成片第 263 帧。
- `{"fromEnd": 75}`：距成片结尾 75 帧。
- `{"word": 34, "expect": "individually", "edge": "start", "offsetMs": 0}`：转录第 34 个词（从 0 数）开始时。引擎通过 segments 换算到成片帧，剪辑改动后效果自动跟着词走。`expect` 强烈建议写：转录重做导致词序号变化时会直接报错，而不是把效果放错位置。
- `{"segment": "s02", "edge": "end", "offsetMs": -500}`：某片段开始/结束前后。

词落在被剪掉的部分、或字幕句子跨越剪辑点，都会报错并指出是哪个词/哪句。整句都在剪掉部分的字幕会随声音一起删除，校验输出会显示数量。

## 结构

```jsonc
{
  "schemaVersion": 1,
  "id": "bloom10-demo",                 // 小写字母、数字、连字符
  "meta": { ... },                      // 自由备注（来源、审核、事实依据），渲染器不读取
  "output": { "width": 1080, "height": 1920, "fps": 30,
              "encoding": { "crf": 18, "x264Preset": "veryfast" } },
  "theme": { "background": "#101820", "textColor": "#ffffff",
             "fontFamily": "\"BloomInter\", sans-serif",
             "fonts": [{ "family": "BloomInter", "src": "fonts/Inter-700.woff2", "weight": 700 }] },
  "assets": {                           // 所有路径相对 public/，可写 sha256 锁定素材
    "source":  { "type": "video", "path": "recordings/...mp4", "sha256": "..." },
    "frames":  { "type": "imageSequence", "dir": "derived/x/frames", "pattern": "frame-%04d.jpg", "frameCount": 909, "fps": 30 },
    "product": { "type": "image", "path": "projects/x/product.jpg" },
    "music":   { "type": "audio", "path": "derived/x/mix.wav" }
  },
  "transcript": { "asset": "source", "words": "transcripts/x.edited.json", "cues": "transcripts/x.edited.cues.json" },
  "segments": [
    { "id": "s01", "asset": "source", "sourceStartMs": 0, "sourceEndMs": 19330,
      "camera": { "zoom": 1, "originX": 0.5, "originY": 0.4,
                  "punchIns": [{ "at": { "word": 44, "expect": "stuck" }, "durationFrames": 36, "zoom": 1.18, "rampFrames": 5 }] } }
  ],
  "layout": { "footage": { "x": 0, "y": 0, "width": 1080, "height": 1920, "borderRadius": 0, "fit": "cover",
                           "grade": { "brightness": 1.02, "contrast": 1.06, "saturate": 1.1 } } },
  "captions": { "box": { "x": 70, "y": 1330, "width": 860, "height": 190 },
                "fontSize": 66, "lineHeight": 80, "fontWeight": 700, "color": "#ffffff", "activeColor": "#ffd23f",
                "background": "#101820b3", "wordGap": 16, "maxLines": 2, "singleLineMaxChars": 20,
                "balanceWeight": 0.2, "textTransform": "uppercase",
                "emphasis": [{ "word": 34, "expect": "individually", "color": "#ff7ab6", "scale": 1.12 }] },
  "overlays": [
    { "id": "hook-title", "effect": "title-card@1", "from": { "frame": 0 }, "until": { "word": 12 },
      "layer": "below-captions", "props": { ... } }
  ],
  "audio": { "segmentAudio": true, "tracks": [{ "asset": "music", "from": { "frame": 0 }, "volume": 0.3 }],
             "loudness": { "normalize": true, "targetLufs": -16, "truePeakDb": -1.5, "lra": 11 } },
  "qc": { "loudnessLufs": -16, "loudnessToleranceLu": 1.5, "maxTruePeakDb": -1 }
}
```

要点：

- 每一层都是严格模式：拼错字段名（如 `captons`、`colour`）直接报错，不会被静默忽略。
- 颜色用十六进制，`#rrggbbaa` 可带透明度。
- `segments[].asset` 可以是 `video`（直接读原视频，无需预处理）或 `imageSequence`（预抽帧，Bloom10 使用，保证与 r1 逐帧一致）。
- `camera.zoom` ≥ 1（不允许缩小露出边缘）；`punchIns` 在片段内临时推近，`rampFrames` 为推入/拉回帧数。
- `layout.footage.grade` 是 CSS 滤镜级的轻度调色，用于预览和简单统一色调；LUT/曲线级调色属于后续 FFmpeg 预处理阶段。
- `audio.segmentAudio: true` 播放每个保留片段的原声（跟随跳剪）；`tracks` 放独立音轨（如预混音、BGM）。
- 字幕某一行实际宽度超过 `captions.box.width` 时自动等比缩小该行，避免出框；未超宽的行保持原样。大写、大字号时会出现缩小，可通过调小 `fontSize` 或 `singleLineMaxChars` 让各行宽度更一致。
- **响度标准化默认开启**：`plan:render` 在 Remotion 渲染后用 FFmpeg 两遍 loudnorm 处理整条混音，默认 `-16 LUFS / 真峰值 -1.5 dBTP / LRA 11`，视频流原样复制不重新编码，音频裁到与画面等长；测量结果写入 `<成片>.loudnorm.json`。可在 `audio.loudness` 中修改目标值。音轨已经在前期处理中标准化过时（如 Bloom10 的 mix.wav）写 `"loudness": { "normalize": false }`，避免二次处理改变已审核的声音。原声需要增益较大且峰值受限时，loudnorm 会自动改用动态模式（`.loudnorm.json` 中 `normalization_type` 为 `dynamic`），需听感确认。
- `qc.loudnessLufs` 不写时默认取 `audio.loudness.targetLufs`；关闭标准化且不写时只报告、不判定。

## 已登记效果（src/engine/effects/catalog.ts）

| id | 用途 | 主要参数 |
| --- | --- | --- |
| `title-card@1` | 标题卡/关键词卡/CTA 文字 | text、x/y/width、minHeight、padding、background、color、accentColor/accentWidth（左侧色条）、borderRadius、fontSize、lineHeight、letterSpacing、align、textTransform、enter（none/fade/fade-up）、exit（none/fade） |
| `alpha-video@1` | 预渲染透明视频（HyperFrames WebM） | asset（video）、x/y/width/height |
| `image-card@1` | 真实产品图卡片 | asset（image）、x/y/width/height、fit、background、padding、borderRadius、shadow、enter（none/fade/pop）、exit |
| `rect@1` | 线条、色块 | x/y/width/height、color、borderRadius、opacity |

未登记的 `effect`、参数类型不对、多余参数、引用不存在或类型不符的素材都会被拒绝。新增效果：在 `catalog.ts` 加 schema、在 `components.tsx` 加组件（TypeScript 强制两边一一对应），出测试片段并经你确认后再用于正式视频；改已确认效果的外观时增加新版本号（如 `title-card@2`），旧配置保持原样渲染。

## 新视频的做法

1. 把原片放到 `public/recordings/<项目>/`，转录：`npm.cmd run transcribe -- "public/recordings/<项目>/<文件>.mp4"`，校对后保存 `.edited` 版本。
2. 复制 `projects/bloom10-demo/edit-plan.json` 到 `projects/<新id>/edit-plan.json`，改 `id`、`assets`（建议写 sha256）、`transcript`、`segments`、文字和样式。
3. `plan:check` → `plan:render -- ... --frames=0-89` 试看 → 全片渲染 → `plan:verify` → 人工观看与听校。

## 引擎文件

| 文件 | 作用 |
| --- | --- |
| `src/engine/schema.ts` | edit-plan 的 Zod schema、类型和跨字段校验 |
| `src/engine/effects/catalog.ts` | 效果登记表（id@版本 → 参数 schema） |
| `src/engine/resolve.ts` | 原片时间 → 成片帧号；字幕分行、词锚点、强调词 |
| `src/engine/load.ts` | Node 脚本与 Remotion 共用的统一入口 |
| `src/engine/EditPlanVideo.tsx` | Remotion 组合 `EditPlan`（calculateMetadata 自动得出尺寸、帧率、时长） |
| `src/engine/Footage.tsx` / `Captions.tsx` / `effects/components.tsx` | 画面、字幕、效果组件 |
| `scripts/edit-plan.mjs` / `render-plan.mjs` / `verify-render.mjs` / `compare-renders.mjs` | 校验、渲染、质检、对比 |

`src/engine` 下不以 `.tsx` 结尾的文件不能引入 React/Remotion，因为 Node 脚本直接运行它们（Node 24 原生 TypeScript 类型剥离）。

## 尚未包含（后续阶段）

风格库与版本锁定、Storyboard 方案与审核闸门、edit-plan 哈希锁、精确逐词对齐与自动去停顿、BGM 躲避与音效库、FFmpeg LUT 调色、平台安全区叠加检查、分块增量渲染、批量变体。
