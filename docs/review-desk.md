# 审阅台使用说明（第一轮）

设计见 [review-desk-design.md](review-desk-design.md)。本文说明怎么用、文件在哪里、提案怎么写。

## 启动

```powershell
npm run desk            # 构建页面并启动服务
npm run desk:serve      # 页面已构建时，只启动服务
```

浏览器打开 `http://127.0.0.1:4310/#project=bloom10-demo`，也可以在 Claude 桌面应用的浏览器面板里打开。服务只监听本机。

第一次打开某个项目前，先准备两样东西。也可以在页面的"作业"标签里点按钮生成：

```powershell
npm run desk:proxy -- bloom10-demo   # 540p H.264 预览代理（原片只用于最终渲染）
npm run desk:faces -- bloom10-demo   # 人脸检测
```

## ① 素材准备、② 方案选择（第二轮 2a）

顶栏的四个阶段按钮用来切换不同的台。新项目从①开始：

- **① 素材准备**
  - **段落角色：** Claude 把口播切成段，每段附中文翻译，你检查角色后点确认。
  - **素材：** Claude 从原片里找到候选图，你选择"采用"或"不用"；缺少的素材可以直接上传。
  - **产品事实核实：** 逐条核实时必须填写依据。
  - **补拍清单：** 可以打印。
- **② 方案选择**
  - Claude 出的 3 套方案并排显示：关键帧、简介、确认前还缺什么。
  - 点一套方案，中间会实时预览，右侧显示分镜表（每段原话、中文翻译、屏幕上出现什么、用了哪张卡片）。
  - 可以切换风格包，也可以在画面上拖动卡片调整位置。
  - 所有条件都满足后，点"确认这个方案"：生成 edit-plan，进入③时间轴审阅。
  - 确认之后，这一轮方案不能再改。要改分镜，请让 Claude 出新一轮方案。

卡片、风格包、审美规则都在 `library/` 里，设计见 [storyboard-desk-design.md](storyboard-desk-design.md)。

## 界面（③ 时间轴审阅）

- **左栏 段落：** 关键帧、时间、字幕，以及"保留 / 修改 / 放弃"标记、意见数量、待确认提案数量。点段落会跳到该段开头。
- **中间 预览：** Remotion Player 播放当前 edit-plan（预览代理）。
  - 叠加层：TikTok 安全区（红色斜线）、人脸区域（黄色椭圆）、字幕框。
  - 点画面上的元素可以拖动或拉角调整大小，松手 0.5 秒后自动保存。
  - 选中元素后，下方会实时提示是否遮挡人脸、是否进入安全区。
  - 快捷键：空格播放或暂停，←/→ 逐帧，按住 Shift 一次跳 10 帧。
- **右栏：**
  - **检查器：** 选中元素的位置、大小、样式和出现时间，可以直接修改。没有选中元素时，显示整片的布局警告和整体意见。选中段落时，可以写意见、修正人脸框。
  - **提案：** Claude 的修改提案，包含前后对比图、理由和逐项改动。可以"在播放器中预览修改"，然后采纳，或者拒绝并附上意见。
  - **版本：** 每次保存都会生成一个新版本，可以把任意历史版本"恢复为新版本"。恢复不会删除任何历史。
  - **作业：** 生成预览代理、人脸检测、渲染并质检。每个作业都有记录和日志。
- **底部 时间轴：** 段落、字幕、叠加、音频（波形和音量线）四条轨道；红线是跳剪点，红色短条是遮挡人脸的时段。点击或拖动可以定位。

## 流程

1. 在段落上做标记、写意见。意见会记在当前帧上。
2. 点顶栏"提交意见给 Claude"，然后在对话里说"看我的意见"。
3. Claude 写提案，页面会自动刷新。
4. 逐条处理提案：预览、采纳或拒绝。拒绝时写的意见会回到审阅文件里，Claude 只针对这一条重出。
5. 需要成片时，在"作业"里点"渲染 + 质检"。输出在 `out/desk/<id>/<id>-r<版本>.mp4`，质检报告在同名的 `.qc/validation.json`。

## 保护规则

- **提案只有你采纳后才会写入 edit-plan。** 采纳前，服务端会再跑一次 Phase 1 的完整校验，不通过就拒绝采纳，edit-plan 保持原样。
- **保存带版本号。** 版本不一致时返回冲突，页面提示重新加载，不会覆盖别处的修改。
- **过期提案不能采纳。** edit-plan 改动后，基于旧版本的待确认提案会自动标为"已过期"。
- **页面只能读取预览代理。** 原片目录（`public/recordings/`）不会对页面开放。

## 文件

```
projects/<id>/
├─ edit-plan.json           当前版本（含 revision）
├─ status.json              阶段状态
├─ versions/                edit-plan.rNNNN.json 历史版本 + log.json
├─ review/r1.json           段落标记与意见
├─ proposals/p-NNNN.json    提案；previews/ 是前后对比图
├─ analysis/faces.json      人脸检测结果（相对原画面的比例坐标）
├─ analysis/faces.overrides.json   手动修正（按段落）
├─ analysis/proxies.json    预览代理记录（不入 Git）
├─ jobs/  logs/             作业记录与日志（不入 Git）
public/projects/<id>/proxy/ 预览代理（不入 Git）
```

## 提案格式

```json
{
  "id": "p-0002", "state": "pending", "basedOnRevision": 5, "answers": ["c-0001", "c-0002"],
  "summary": "一句话说明改了什么",
  "reason": "为什么这样改，依据是什么",
  "changes": [
    { "op": "test", "path": "/overlays/3/id", "value": "cta-title" },
    { "op": "replace", "path": "/overlays/3/props/fontSize", "value": 60 }
  ],
  "impact": { "durationDeltaFrames": 0, "segments": ["dose-and-cta"] },
  "createdBy": "claude", "createdAt": "2026-10-29T07:05:00.000Z"
}
```

`changes` 使用 JSON Patch（RFC 6902），支持 add、remove、replace、move、copy、test。按数组下标修改元素前，先用 `test` 确认该下标上的元素就是要改的那个。

对比图用下面的命令生成，结果会写入提案的 `preview` 字段：

```powershell
npm run desk:stills -- bloom10-demo --proposal=p-0002 --frames=770
```

## 人脸区域与安全区

- **检测：** MediaPipe BlazeFace（short-range）在无界面的 Chrome 里用 CPU 运行，每秒取 5 帧。模型文件是 `models/blaze_face_short_range.tflite`，SHA-256 记录在 `models/manifest.json`。
- **结果按原画面的比例坐标保存。** 重新剪辑或改变布局都不需要重跑检测，只有换素材时才需要。
- **过滤规则：** 每个采样点保留置信度最高的一张脸（最低 0.5）；同一画面的其他检测结果，要求置信度不低于 0.85 才算人脸。这样可以过滤掉被误识别成脸的手和包装。
- **手动修正：** 在段落检查器里选"手动修正"，然后在画面上拖动黄色框；如果这一段没有人，选"此段无人脸"。
- **安全区：** 定义在 `src/engine/safe-zones/tiktok.json`（顶部标签栏、右侧按钮区、底部文案区），是近似值，可以在文件里调整。
- **警告不阻止渲染，由你决定是否处理。** `plan:check` 和 `plan:verify` 会列出以下三类情况，`plan:verify` 还会把它们写进 `validation.json` 的 `layoutWarnings`：
  - 元素遮挡人脸超过 10%；
  - 元素有 5% 以上落在安全区内；
  - 元素超出画面。

### 已知局限

- **标题卡的高度是估算值**（一行文字加上下内边距），多行文字的卡片会被低估。
- **透明视频（alpha-video）按整个矩形计算**，透明的部分也算作遮挡，所以可能误报。Bloom10 的 packaging-label 就属于这种情况。
