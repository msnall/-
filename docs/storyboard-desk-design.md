# 方案台、素材台与技巧卡片格式（第二轮设计）

状态：2a 已实施（2026-10-29）；2b 的新效果尚未开发。第一批 12 张卡片和三种开场组合已于 2026-10-29 确认，并按你的意见加入第 13 张"金句前置"。

**2a 实施时与本设计不同的地方：**

- **方案 B 的开场：** 搜索框效果属于 2b，2a 期间方案 B 改用"一周测评"大字开场。
- **预览素材：** 未确认的素材，预览时先用候选图；缺失的素材，预览时显示"缺素材"占位图。确认方案时仍然要求所有素材都已就位。
- **段落顺序：** 由卡片决定（金句前置 `moveBeatFirst`），方案里不写 `order` 字段。
- **新增"文字说明"字段：** 段落里的 `textZh` 是中文翻译；方案里的 `onScreen` 用中文说明屏幕上出现什么。界面显示中文，视频里的屏幕文字仍用英文。
- **审美规则：** 初始的两条（标题保持一行、不遮挡人脸）来自你在第一轮审阅中的意见，状态是 `proposed`（待批准），批准前不会被强制检查。

使用方式见 [review-desk.md](review-desk.md) 的"① 素材准备、② 方案选择"一节。
相关文档：
- [technique-library-design.md](technique-library-design.md)：技巧库总体设计；
- [review-desk-design.md](review-desk-design.md)：总体流程。

以下示例都用 Bloom10 的真实转录（114 个词，18 句）。

## 1. 第一步：段落角色

方案的依据是口播里每段话在讲什么。Claude 读转录后写出 `projects/<id>/analysis/beats.json`，你在素材台里确认。

```jsonc
{
  "version": 1,
  "transcript": "transcripts/Bloom10-达人素材.edited.json",
  "beats": [
    { "id": "b1", "role": "intro",   "words": [0, 11],    "text": "I've been taking these biotic breast gummies for about a week now." },
    { "id": "b2", "role": "benefit", "words": [12, 35],   "text": "…what I like the best … is the fact that they are individually wrapped.",
      "claims": ["individually-wrapped"] },
    { "id": "b3", "role": "pain",    "words": [36, 65],   "text": "I don't have to worry about them getting stuck to the side of the bottle…" },
    { "id": "b4", "role": "cta",     "words": [66, 72],   "text": "So I'm gonna link them for y'all." },
    { "id": "b5", "role": "product", "words": [73, 80],   "text": "They come in a pretty good size container," },
    { "id": "b6", "role": "dose",    "words": [81, 106],  "text": "…30 days' worth, because you take two gummies a day…",
      "claims": ["30-days", "two-a-day"] },
    { "id": "b7", "role": "cta",     "words": [107, 113], "text": "So I'll highly recommend these to you." }
  ]
}
```

- **角色：** `hook | intro | pain | benefit | proof | product | dose | offer | cta | filler`。
- **词范围：** 用转录里的词序号（包含首尾），和 edit-plan 的词锚点用同一套编号。
- **产品事实：** `claims` 指向 `assets.json` 里的产品事实条目。未核实的事实不能上屏；含有未核实事实的段落，方案里默认剪掉。b6 的"30 天用量"就属于这种情况，和 demo 的处理方式一致。

## 2. 技巧卡片格式

### 2.1 字段

| 字段 | 说明 |
| --- | --- |
| `id` | `<名称>@<版本>`。卡片内容一旦改动就升版本，旧方案引用的旧版本保持不变 |
| `name`、`category`、`description` | 展示用 |
| `status` | `ready` / `needs-effect` / `needs-model` / `draft`。只有 `ready` 的卡片能进入方案 |
| `source` | 来源：`pdf#N`、`ref:<参考视频 id>` 或 `tk-common` |
| `when` | 适用条件（见 2.2），Claude 在 `beats.json` 里找匹配的段落 |
| `slots` | 槽位定义（见 2.3），由 Claude 在方案里填写 |
| `needs` | 需要的素材种类（见 2.4） |
| `template` | edit-plan 片段，`"$槽位名"` 会被替换（见 2.5） |
| `tunables` | 风格菜单里可以调的参数 |
| `rules` | 规则（见 2.6）：一部分由程序检查，其余是给 Claude 的文字说明 |
| `examples`、`stats` | 示例图和使用统计 |

### 2.2 适用条件 `when`

```jsonc
"when": {
  "roles": ["pain", "hook"],     // 只能用在这些角色的段落上
  "position": "opening",         // opening（开场）| any（任意位置）| closing（结尾）
  "minDurationMs": 1500,
  "note": "需要一句能独立成立的痛点句"   // 给 Claude 的文字说明
}
```

### 2.3 槽位 `slots`

| 类型 | 例子 | 校验方式 |
| --- | --- | --- |
| `word` | 推近落在哪个词上 | 词序号在所用段落内，带 `expect` 原词 |
| `wordRange` | 打勾清单每一条对应的词 | 同上 |
| `beat` | 卡片作用于哪个段落 | 在 `beats.json` 里存在 |
| `text` | 钩子大字的文案 | 有字数上限；如果包含产品事实，必须引用已核实的事实条目 |
| `items` | 清单条目 | 每条引用一个已核实的事实条目 |
| `asset` | 产品图 | 在 `assets.json` 里状态为 available |
| `choice` | 样式选项 | 在给定的选项里 |

### 2.4 素材需求 `needs`

```jsonc
"needs": [
  { "slot": "image", "kind": "image", "subject": "product-front",
    "accept": "产品正面、文字可读、背景干净",
    "fallback": "candidate-from-footage",        // 先从原片里找帧
    "shotRequest": { "framing": "正面平拍，竖构图", "background": "浅色纯色", "notes": "标签完整可读" } }
]
```

### 2.5 模板 `template`

```jsonc
"template": {
  "segments.camera.punchIns": [                  // 加到包含该词的那一段上
    { "at": { "word": "$word", "expect": "$wordText" }, "durationFrames": 30, "zoom": "$zoom", "rampFrames": 5 }
  ],
  "overlays": [
    { "id": "$id", "effect": "title-card@2", "from": { "word": "$word", "expect": "$wordText" }, "durationFrames": 66,
      "props": { "text": "$text", "x": 90, "y": 260, "width": 900, "fontSize": 84, "style": "@style.hookCard" } }
  ]
}
```

- **`$名称`** 换成槽位的值。
- **`@style.xxx`** 换成当前风格包里的对应值，所以换风格包不需要改卡片。
- **编译后的结果**必须通过 Phase 1 的 edit-plan 校验。

### 2.6 规则 `rules`

```jsonc
"rules": [
  { "check": "noFaceOverlap", "max": 0.1 },
  { "check": "safeZone" },
  { "check": "maxPerVideo", "value": 1 },
  { "check": "minGapMs", "value": 4000, "sameCategory": true },
  { "check": "maxChars", "slot": "text", "value": 32 },
  { "check": "claimVerified", "slot": "items" },
  { "text": "钩子文案必须是口播里实际说到的内容，或者是对它的如实概括" }
]
```

有 `check` 的规则由编译器和 `plan:check` 自动检查；只有 `text` 的规则写进 Claude 的提示。你批准的审美规则（`library/taste-rules.json`）用同样的格式。

## 3. 风格包

```jsonc
{
  "id": "clean-pink@1", "name": "清爽粉",
  "fonts": [{ "family": "BloomInter", "src": "fonts/Inter-700.woff2", "weight": 700 }],
  "palette": { "primary": "#ff7ab6", "ink": "#101820", "card": "#ffffff" },
  "captions": { "style": "word-box@1", "box": { "x": 90, "y": 1330, "width": 860, "height": 190 }, "fontSize": 64, "activeBox": "#ff7ab6" },
  "hookCard": { "background": "#ffffff", "color": "#101820", "accentColor": "#ff7ab6" },
  "transition": "whip-pan@1",
  "grade": { "brightness": 1.03, "contrast": 1.05, "saturate": 1.08 },
  "layout": "full-bleed"            // full-bleed（满屏）| framed（Bloom10 那种画框式）
}
```

第一批先做三个风格包：清爽粉、深色质感、暖色生活感。

## 4. 方案文件

格式参照 PDF 第一条"先出分镜"：每个节拍一行，写明时间、原话、屏幕上出现什么、用哪张卡片。

```jsonc
// projects/bloom10/storyboard/r1/option-a.json
{
  "id": "option-a", "round": "r1", "title": "痛点开场",
  "style": "clean-pink@1",
  "summary": "用『粘在瓶壁上』这个痛点开场，接独立包装的卖点，最后行动号召。",
  "rows": [
    { "beat": "b3", "keep": true, "order": 1,
      "onScreen": "大字『Gummies stuck to the bottle?』弹入；说到 stuck 时推近",
      "cards": [
        { "card": "hook-big-text@1", "slots": { "beat": "b3", "word": 44, "wordText": "stuck", "text": "Gummies stuck to the bottle?" } },
        { "card": "keyword-punch@1", "slots": { "word": 44, "wordText": "stuck", "zoom": 1.18 } }
      ] },
    { "beat": "b1", "keep": true, "order": 2, "onScreen": "逐词高亮字幕", "cards": [] },
    { "beat": "b2", "keep": true, "order": 3, "onScreen": "说到 individually wrapped 时出现产品图",
      "cards": [{ "card": "product-pip@1", "slots": { "word": 34, "wordText": "individually", "image": "product-front" } }] },
    { "beat": "b6", "keep": false, "reason": "包含未核实的『30 天用量』" },
    { "beat": "b7", "keep": true, "order": 6, "onScreen": "购物车按钮跳动",
      "cards": [{ "card": "cta-button@1", "slots": { "word": 109, "wordText": "recommend", "label": "Tap the link below" } }] }
  ],
  "global": [{ "card": "word-captions@1" }, { "card": "jump-cut@1", "slots": { "maxPauseMs": 220, "alternateZoom": 1.15 } }],
  "needs": ["product-front"],
  "estimate": { "durationMs": 21000 },
  "keyframes": ["storyboard/r1/option-a-k1.jpg", "storyboard/r1/option-a-k2.jpg"]
}
```

- **`order` 允许重新排序。** 例如把痛点段放到最前面，这在 TK 里很常见，叫"金句前置"。引擎本来就支持任意顺序的段落。
- **全局卡片**（字幕、去停顿）作用于整条视频，放在 `global` 里。
- **`needs`** 是这个方案缺少的素材，会出现在素材台的补拍清单里。

## 5. 编译：方案 → edit-plan v1

新脚本 `scripts/compile-storyboard.mjs`：输入方案、风格包和卡片库，输出 `edit-plan.json`。

1. **生成段落：** 按 `order` 把保留的节拍转成 segments，节拍的词范围换算成原片的毫秒时间。如果启用了去停顿，先把节拍切成更细的小段。
2. **应用卡片模板：** 填入槽位和风格包里的值，自动生成 id，例如 `hook-big-text-b3`。
3. **生成字幕和音频：** 字幕使用风格包的样式；`segmentAudio` 默认开启；响度沿用 Phase 1 的默认值。
4. **检查：** 先跑卡片规则，再跑 Phase 1 的完整校验和布局检查。不通过就报出是哪张卡片、哪个槽位的问题。
5. **生成关键帧：** 用 `render-stills` 为每个方案出 4–6 张关键帧，包括开场、每个卡片的出现时刻和结尾。

同样的输入总是得到同样的 edit-plan。你选定方案以后，edit-plan v1 进入审阅台，revision 从 0 开始。

## 6. 素材台

**`assets.json` 的生命周期**（格式见 review-desk-design §5.2）：

```
missing ──Claude 在原片里找到候选帧──▶ candidate ──你确认──▶ available
   │                                                         ▲
   └──────────写进补拍清单──▶ 你补拍并上传 ─────────────────────┘
```

- **找候选帧：** 产品类素材，Claude 从原片里找候选帧：
  - 抽帧，优先选画面清晰、没有人脸、产品占比大的帧；
  - 拼成联系表，Claude 看图后挑出 2–3 个；
  - 裁切图存到 `projects/<id>/assets/`，文件名用英文。
- **补拍清单：** 汇总所有方案的 `needs` 里还没解决的素材，生成一页可以打印或用手机查看的清单：拍什么、怎么构图、背景、时长，以及用在哪个方案。
- **产品事实核实：** 列出每条产品事实，你逐条标记"已核实"；包装照片、说明书或链接等依据可以选填。没有核实的，在所有方案里都不能上屏。
- **上传：** 新素材放进 `public/projects/<id>/assets/`，系统计算 SHA-256，记录原文件名（可以是中文），存储时改用英文文件名。

## 7. 方案台界面

```
┌ 顶栏：阶段 ① 素材 ② 方案（当前）③ 审阅 ④ 质检 ─────────────────────────┐
├ 方案 A 痛点开场 ┬ 方案 B 搜索框开场 ┬ 方案 C 产品特写开场 ┬ 右栏 ─────────┤
│ 关键帧条（4–6 张） │ …                │ …                  │ 风格菜单      │
│ 预计时长 21 s      │                  │                    │ ·字幕样式     │
│ 缺素材 1（产品正面）│                  │                    │ ·转场         │
│ [播放] [选这个]    │                  │                    │ ·调色         │
├────────────────────┴──────────────────┴────────────────────┤ ·风格包       │
│ 分镜表（选中方案）：节拍 | 时间 | 原话 | 屏幕上 | 卡片 | 保留 │ 卡片详情      │
└──────────────────────────────────────────────────────────────┴──────────────┘
```

- **播放：** 选中的方案先编译成临时 edit-plan，再用审阅台同一个播放器播放，叠加层（安全区、人脸、可拖动元素）照常显示。
- **修改：**
  - 在风格菜单里换样式，或在画面上拖动元素，修改记入 `selection.json` 的 `styleOverrides` 或 `layoutOverrides`，然后重新编译；
  - 想改分镜内容（换卡片、换节拍），就写意见，让 Claude 出新一轮方案（r2）。
- **选定：** 点"选这个"，`selection.json` 的状态变为 confirmed，编译出 edit-plan v1，阶段推进到审阅。如果还缺素材，阶段停在"补素材"，等素材齐了再推进。

## 8. 新增接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET/PUT | `/api/projects/:id/beats` | 段落角色 |
| GET/PUT | `/api/projects/:id/assets` | 素材清单与产品事实核实 |
| POST | `/api/projects/:id/assets/upload` | 上传素材（计算哈希、改用英文文件名） |
| GET | `/api/projects/:id/storyboard/:round` | 某一轮的全部方案和选定结果 |
| POST | `/api/projects/:id/storyboard/:round/:option/compile` | 编译成临时 edit-plan，用于预览 |
| PUT | `/api/projects/:id/storyboard/:round/selection` | 修改样式、布局，确认选定 |
| GET | `/api/library` | 卡片、风格包、审美规则 |

作业类型新增：`keyframes`（方案关键帧）、`candidates`（从原片找候选帧）。

## 9. 第二轮的实施拆分

**2a：流程打通。** 先只用已经能做的卡片：开头大字钩子（暂用 title-card@1 的淡入）、关键词推近、产品画中画、真实截图卡。

1. 卡片、风格包、审美规则的 schema，以及第一批 12 张卡片文件。不能做的卡片标为 `needs-effect`。
2. `beats.json` 和对应的 Skill（storyboard）。
3. 编译器和关键帧生成。
4. 素材台：候选帧、补拍清单、产品事实核实。
5. 方案台界面。

**2b：新效果。** 按带货价值和难度排序：

1. 逐词高亮字幕
2. title-card@2（弹入）
3. 购物车按钮
4. 卖点打勾清单
5. 品牌标签
6. 搜索框打字
7. 去停顿规划器
8. 快甩转场
9. 音效和背景音乐压低（等你提供授权素材）

**2a 的验收标准：**

- 用 Bloom10 走完全流程：
  - 生成段落角色；
  - 出 3 套方案，每套都有关键帧；
  - 未核实的"30 天用量"在所有方案里都被剪掉，或者不上屏；
  - 选定一套方案后，编译出的 edit-plan 能通过 `plan:check`；
  - 进入审阅台以后能正常审阅和渲染。
- 换一个风格包、拖动一个元素后重新编译：结果符合预期，其他元素不受影响。
- 缺少素材的方案不能确认，补拍清单内容正确。
- 编译是确定的：同一输入编译两次，得到的 edit-plan 完全一样。
- Bloom10 的 r1 回归渲染仍然逐字节一致。

## 10. 需要你回答的问题

1. **金句前置：** 把最有冲击力的一句（比如痛点句）调到开头，是 TK 很常见的开场。要不要加成第 13 张卡片？引擎已经支持段落重新排序，不需要开发新效果。
2. **屏幕文字的语言：** 屏幕文字按英文（面向美区）来做吗？界面保持中文。
3. **先做 2a 还是 2b：** 我建议先做 2a，把流程打通；新效果按 2b 的顺序逐个加入。
