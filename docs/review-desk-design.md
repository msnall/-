# 审阅台与工作流设计（阶段 A：Claude 内的本地审阅台）

状态：第一轮（审阅台）已实施，使用说明见 [review-desk.md](review-desk.md)；素材台、方案台待第二、三轮。日期：2026-10-29。界面草图：[review-desk-sketch.html](review-desk-sketch.html)（浏览器打开）。

## 1. 目标与范围

把"素材准备 → 方案选择 → 时间轴审阅 → 渲染质检"做成以文件为中心、高可视化、人工确认后才生效的流程。

- 使用者：剪辑本人，单人，本机。
- 形式：Claude Code 负责理解、规划、出提案；本地审阅页（`http://127.0.0.1:<端口>`）在 Claude 桌面应用的浏览器面板中打开，负责看、选、拖、标记、批注。
- 所有交接通过 `projects/<id>/` 下的 JSON 文件，不依赖对话记录；新开对话也能从 `status.json` 接着做。

**本阶段不做：** 登录、数据库、对象存储、多人协作、参考视频自动学习（Storyboard 完成后再设计）、人像抠像、精确逐词对齐和自动去停顿（单独阶段）。

## 2. 整体结构

```
Claude 桌面应用
 ├─ 对话：Claude Code 读写项目文件、调用脚本、生成方案与提案（遵守 .claude/skills 与 CLAUDE.md）
 └─ 浏览器面板：本地审阅页（React + Remotion Player）
          │  只通过 HTTP 接口
          ▼
   本地 Node 服务（只监听 127.0.0.1）
     ├─ 项目接口：读写 status / assets / storyboard / edit-plan / review / proposals
     ├─ 作业队列：代理转码、截帧、关键帧渲染、渲染、质检（复用 Phase 1 脚本）
     └─ 事件推送：作业进度、文件被他方修改（SSE）
          ▼
   文件：projects/<id>/…、public/projects/<id>/…（媒体）
```

Claude 与审阅页之间不直接通信：审阅页写 `review/`，Claude 读取后写 `proposals/`，审阅页刷新显示。以后上服务器，把"Claude Code 读写文件"换成服务端 Agent 调用，文件格式不变。

## 3. 阶段与闸门

| 阶段 | Claude 做什么 | 你做什么 | 闸门（满足才进入下一阶段） |
| --- | --- | --- | --- |
| 1 素材准备 | 入库、转录、生成代理、按候选效果列出所需素材、从原片找可截取的帧、生成补拍清单 | 确认截帧、补拍、标记产品事实状态（依据可选） | 所选方案需要的素材状态全部为"已有"；上屏的产品事实已核实 |
| 2 方案选择 | 出 3 套 TK 电商方案（开头钩子和风格差异化，中段卖点和 CTA 尽量共用），每套渲染关键帧 | 选方案、在风格菜单里换字幕/转场/调色、拖动元素位置 | `storyboard/rN/selection.json` 为已确认 → 编译出 edit-plan v1 |
| 3 时间轴审阅 | 根据意见出修改提案（前后对比 + 理由），只改被批注的部分 | 逐段保留/放弃/修改、写意见、采纳或拒绝提案、直接微调位置和样式 | 所有段落都已标记，没有待确认的提案 |
| 4 渲染质检 | 渲染、自动质检（Phase 1 已有）、生成审片单 | 观看、试听，通过或退回第 3 阶段 | 自动质检通过且你标记"通过" |

规则：没有批准的方案不渲染整片；没有采纳的提案不写入 edit-plan；质检不通过不交付。

## 4. Skills 与 CLAUDE.md

**`CLAUDE.md`（项目根目录）** 包含：目录约定、上述闸门、禁止事项（不覆盖原片和交付物、不编造产品事实、不伪造前后对比、不跳过质检、引用他人视频只用于分析）、常用命令，以及"开始任何工作前先读 `projects/<id>/status.json`"。

**`.claude/skills/`：**

| Skill | 触发 | 读 | 写 | 调用 |
| --- | --- | --- | --- | --- |
| video-workflow | 开始或继续一条视频 | status.json | status.json | 按阶段转到下面的 Skill |
| asset-prep | 新素材，或方案缺素材 | 原片、转录、效果所需素材 | assets.json、补拍清单 | 转录、代理转码、截帧脚本 |
| storyboard | 素材齐全，或要求重出方案 | assets.json、风格菜单、审美规则 | storyboard/rN/* | 关键帧渲染 |
| timeline-review | 你说"看我的意见" | review/rN.json、相关帧图、edit-plan | proposals/*.json | 关键帧/片段预览渲染 |
| render-qc | 第 3 阶段闸门已满足 | edit-plan（已批准） | 成片、qc 报告 | plan:render / plan:verify |

Skill 只写决策规则和脚本入口；颜色、坐标等参数在风格库和 edit-plan 中。

## 5. 项目文件结构

```
projects/<id>/
├─ status.json          阶段状态
├─ assets.json          素材清单与补拍清单
├─ storyboard/r1/       option-a|b|c.json、关键帧、selection.json
├─ edit-plan.json       当前版本（Phase 1 格式 + revision 字段）
├─ versions/            edit-plan 历史版本（edit-plan.r0003.json …）
├─ review/r1.json       逐段标记与意见
├─ proposals/           p-0001.json …
└─ logs/                作业日志
public/projects/<id>/   该项目的媒体（原片工作副本、代理、截帧、补拍素材）
```

所有文件带 `updatedAt`、`updatedBy`（`user` / `claude`），写入时先写临时文件再改名，避免中断后留下半个文件。

### 5.1 status.json

```jsonc
{
  "project": "bloom10",
  "stage": "timeline-review",            // asset-prep | storyboard | timeline-review | render-qc | delivered
  "stages": {
    "asset-prep":      { "state": "done", "updatedAt": "…" },
    "storyboard":      { "state": "done", "round": "r1", "selected": "option-b" },
    "timeline-review": { "state": "waiting-user", "round": "r2", "openProposals": 2 },
    "render-qc":       { "state": "pending" }
  },
  "editPlanRevision": 7
}
```

`state`：`pending` | `in-progress` | `waiting-user` | `done` | `blocked`（`blocked` 必须带 `reason`，例如缺素材）。

### 5.2 assets.json

```jsonc
{
  "items": [
    { "id": "product-front", "kind": "image", "status": "available",
      "file": "projects/bloom10/assets/product-front.jpg", "originalName": "包装正面.jpg",
      "sha256": "…", "source": "截自原片第 860 帧", "approvedBy": "user" },
    { "id": "product-detail", "kind": "image", "status": "missing",
      "neededBy": ["option-a: 卖点开头画中画"],
      "shotRequest": { "subject": "软糖独立包装特写", "framing": "微距，竖拍", "background": "浅色纯色", "duration": "3 秒以上或静态图", "notes": "可见包装文字" } },
    { "id": "back-label", "kind": "image", "status": "candidate",
      "candidates": [{ "frame": 312, "preview": "…/cand-312.jpg" }], "neededBy": ["参数卡"] }
  ],
  "claims": [
    { "text": "individually wrapped", "status": "verified", "evidence": "product-detail" },
    { "text": "30 days' worth", "status": "unverified", "evidence": null }
  ]
}
```

`status`：`available` | `candidate`（Claude 从原片找到，待你确认）| `missing`（进补拍清单）。素材内部用 ASCII 文件名，中文原名放 `originalName`。

### 5.3 storyboard/rN/selection.json

```jsonc
{ "round": "r1", "option": "option-b", "state": "confirmed",
  "styleOverrides": { "captions": "word-box@1", "transition": "whip-pan@1", "grade": "warm@1" },
  "layoutOverrides": { "product-card": { "x": 640, "y": 980, "width": 360, "height": 590 } },
  "confirmedAt": "…" }
```

### 5.4 review/rN.json

```jsonc
{ "round": "r2", "editPlanRevision": 7,
  "segments": [
    { "segment": "hook", "decision": "keep" },
    { "segment": "pain", "decision": "modify",
      "comments": [{ "id": "c-0003", "at": { "frame": 312 }, "text": "这里节奏太慢，停顿剪掉，加关键词放大", "createdAt": "…" }] },
    { "segment": "dose", "decision": "drop", "comments": [{ "id": "c-0004", "text": "用量信息未核实，先去掉" }] }
  ] }
```

`decision`：`keep` | `drop` | `modify` | `undecided`。

### 5.5 proposals/p-NNNN.json

```jsonc
{ "id": "p-0007", "state": "pending",          // pending | accepted | rejected | stale | superseded
  "basedOnRevision": 7, "answers": ["c-0003"],
  "summary": "剪掉 2 处停顿（共 0.9 秒），在 STUCK 处加关键词放大",
  "reason": "该段 4.2 秒内有 0.6 秒和 0.3 秒停顿；关键词放大对应痛点",
  "changes": [                                   // 对 edit-plan 的结构化修改（JSON Patch）
    { "op": "replace", "path": "/segments/1/sourceEndMs", "value": 12400 },
    { "op": "add", "path": "/overlays/-", "value": { "id": "kw-stuck", "effect": "keyword-pop@1", "from": { "word": 44, "expect": "stuck" }, "durationFrames": 24, "props": { … } } }
  ],
  "preview": { "before": ["…/p-0007-before-0312.jpg"], "after": ["…/p-0007-after-0303.jpg"], "clip": "…/p-0007-after.mp4" },
  "impact": { "durationDeltaFrames": -27, "segments": ["pain"], "laterOverlaysShift": true },
  "createdBy": "claude", "createdAt": "…" }
```

生命周期：

1. 你写意见（`review`），Claude 读取，生成提案，状态为 `pending`，附修改前后对比、理由和影响范围。
2. 你在审阅页逐条处理：
   - **采纳：** 服务端校验 `basedOnRevision` 等于当前版本，应用 `changes`，旧版存入 `versions/`，版本号加 1，提案标为 `accepted`。
   - **拒绝或补充意见：** 提案标为 `rejected`，意见写回 review，Claude 只针对这一条出新提案（旧提案标为 `superseded`）。
3. 提案基于的版本已被你在界面上改过时，提案自动标为 `stale`，不能直接采纳，需要 Claude 基于新版本重出。

`changes` 用 JSON Patch：可校验、可精确显示改了什么，也方便撤销。应用后的 edit-plan 必须再通过 Phase 1 的 schema 和素材校验，不通过则拒绝采纳并显示原因。

## 6. 本地服务接口（阶段 A）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表与阶段 |
| GET | `/api/projects/:id` | status、assets、当前 edit-plan（含版本号） |
| PUT | `/api/projects/:id/edit-plan` | 保存直接修改；请求头 `If-Match: <revision>`，版本不一致返回 409 |
| GET/PUT | `/api/projects/:id/review/:round` | 读写逐段标记和意见 |
| GET | `/api/projects/:id/proposals` | 提案列表 |
| POST | `/api/projects/:id/proposals/:pid/accept` | 采纳（校验版本、应用、存历史） |
| POST | `/api/projects/:id/proposals/:pid/reject` | 拒绝，可附意见 |
| GET | `/api/projects/:id/versions` / `…/versions/:rev` | 历史版本与对比 |
| POST | `/api/projects/:id/jobs` | 提交作业：proxy、stills、render、verify |
| GET | `/api/jobs/:jobId` | 作业状态与日志 |
| GET | `/api/events` | SSE：作业进度、文件变化（Claude 写了新提案时界面自动刷新） |
| GET | `/media/:projectId/:assetId` | 媒体（预览只给代理） |

服务端是唯一写文件的地方（Claude Code 直接写提案文件除外，服务端监听文件变化后通知界面）。

## 7. 审阅台界面

详见草图。布局：

- **顶栏：** 项目名、四个阶段进度、edit-plan 版本号、保存状态、"请 Claude 处理意见"提示。
- **左栏 段落列表：** 每段显示关键帧、角色（钩子/痛点/卖点/CTA）、字幕文字、时长；保留/放弃/修改三个按钮；意见数量和待确认提案数量。
- **中间 预览：** Remotion Player 实时播放当前 edit-plan（代理视频）。叠加层开关：平台安全区（TikTok 右侧按钮、底部文案区）、人脸区域、字幕框。点击画面上的元素（产品卡、标题卡、字幕框）可以直接拖动位置、拉伸大小，松手后写回 edit-plan。
- **右栏 检查器 / 提案：** 选中元素时显示它的参数（位置、大小、颜色、字号、出现时间），可直接修改；切换到"提案"时，逐条显示修改前后对比（帧图并排 + 文字差异 + 时长变化），有采纳、拒绝、写意见三个按钮。
- **底部 时间轴：** 段落、字幕、叠加层、音频（波形和音量线）多条轨道；红线标出跳剪点；点击跳转；段落被标为"放弃"时显示为灰色斜线。

**直接修改的范围（阶段 A）：** 叠加元素的位置和大小、字幕框位置、颜色和字号、段落保留或放弃。时间轴拖动剪辑点、音量曲线编辑放到下一轮。

**安全提示：** 拖到人脸区域、平台安全区外或画面外时，元素边框变红并提示，但不阻止（由你决定）。

## 8. 七条可迁移规则（开发自查清单）

| # | 规则 | 检查方法 |
| --- | --- | --- |
| 1 | 界面只走接口 | 前端代码没有文件读写 |
| 2 | 存储封装一层 | 所有读写经过同一个存储模块 |
| 3 | 素材用 ID | edit-plan 无绝对路径；内部 ASCII 文件名，原名在元数据 |
| 4 | 预览用代理 | 浏览器只加载 540p H.264 代理；原片只用于最终渲染 |
| 5 | 版本号与冲突检查 | 保存带 If-Match；提案带 basedOnRevision |
| 6 | 作业记录 | 每个作业有状态、日志、输入哈希、重试次数 |
| 7 | 字体与工具版本固定 | 字体在项目内；工具版本写入作业记录 |

## 9. 第一轮实施范围（建议）

1. 本地服务：项目、edit-plan（带版本号）、review、proposals、jobs、SSE 接口；代理转码作业；人脸检测作业（见 10.1）。
2. 审阅页：Remotion Player 预览、段落列表与标记、元素拖动与检查器、安全区与人脸区叠加、提案对比与采纳/拒绝、版本历史。
3. Skills：video-workflow、timeline-review；`CLAUDE.md`。
4. 用 Bloom10 与 bloom10-demo 两个项目验收。

**验收标准：**
- demo 的人脸区能被自动检测出来；产品卡遮挡人脸时，审阅台和 `plan:verify` 都会报警。
- 在面板中拖动 demo 产品卡离开人脸区，保存后版本号加 1，重新渲染的位置正确。
- 写一条意见，Claude 生成提案；采纳后 edit-plan 改变并可回退；拒绝后可以追加意见。
- 界面修改和 Claude 提案冲突时，提案标为"已过期"，不覆盖你的修改。
- Bloom10 回归渲染仍与 r1 逐字节一致。
- 七条规则逐条自查通过。

素材准备台和方案选择台在第二、三轮实施，复用这一轮的播放器、检查器和提案机制。

## 10. 已确认的决定（2026-10-29）

1. **第一轮范围：** 按第 9 节执行，先审阅台，素材台和方案台放第二、三轮。
2. **安全区：** 只按 TikTok 竖屏（1080×1920）。安全区定义放在 `src/engine/safe-zones/tiktok.json`，以后加平台只加文件。
3. **人脸区域：自动检测，可手动修正。**
4. **显卡：** NVIDIA Quadro P520，2 GB 显存，驱动 538.59。FFmpeg 已支持 CUDA。机器上没有 Python。

### 10.1 人脸自动检测方案（已实施）

实施时新增的依赖，版本均已固定：
- `@mediapipe/tasks-vision` 1.1.1：人脸检测；
- `puppeteer-core` 25.14.0：驱动已安装的 Chrome，不另外下载浏览器；
- `@remotion/player`、`@remotion/bundler`、`@remotion/renderer` 4.0.539：与现有 Remotion 版本相同，此前已作为间接依赖安装，这次改为直接声明；
- `vite` 8.3.4：构建审阅页；
- `@types/react-dom` 19.2.3：类型定义。

模型文件 `models/blaze_face_short_range.tflite` 的 SHA-256 记录在 `models/manifest.json`。

过滤规则：每个采样点保留置信度最高的一张脸，同一画面的其他检测结果要求置信度不低于 0.85。原因是实测中模型会把手或包装误识别为人脸，置信度在 0.5–0.8 之间；而侧脸或部分被遮挡的真实人脸，置信度也可能只有 0.5–0.75，所以不能简单提高统一阈值。

- **做法：** 在 Remotion 已经在用的 Chrome 里运行 MediaPipe Face Detector（BlazeFace short-range），对 540p 代理视频每秒取 5 帧检测。结果写入 `projects/<id>/analysis/faces.json`（每个采样时间点的人脸框，坐标按输出画面归一化），再做平滑，合并成连续的"人脸区域"轨道。
- **依赖：** 新增一个 npm 包 `@mediapipe/tasks-vision`（版本固定，WASM，CPU 即可运行），外加一个约 230 KB 的模型文件。模型放在项目内，记录 SHA-256。不需要 Python，也不占用显卡。
- **手动修正：** 检测结果在审阅台里显示为黄色虚线框。可以整体拖动或缩放某一段的框，修正结果写入 `faces.overrides.json`，不改检测原始结果。
- **用途：** 审阅台显示人脸区并发出遮挡提示；`plan:verify` 增加一项检查：叠加元素与人脸区重叠超过阈值即报警（不阻止）。
- **备选：** `onnxruntime-node` 加 YuNet 模型，在 Node 中直接运行。依赖更重，作为后备方案。

### 10.2 显卡对后续排期的影响

P520 只有 2 GB 显存，适合硬件解码和转码，不适合重型模型。
- **代理视频：** 可以用 CUDA 解码加速。编码仍用 libx264，以保持输出一致。
- **人像抠像：** 例如 RVM 这类模型，在 540p 下或许能离线慢速跑，但不能实时预览。继续放在单独阶段，到时候先做性能测试再决定。
- **以后上服务器：** 重型模型放到服务器的 GPU 上跑，本机只做预览。
