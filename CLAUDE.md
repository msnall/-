# VideoAutomation：给 Claude 的工作规则

TikTok 电商竖屏视频的自动剪辑系统。引擎是 Remotion + FFmpeg + whisper.cpp；每条视频由 `projects/<id>/edit-plan.json` 描述（格式见 `docs/edit-plan.md`）。人工审阅在本地审阅台进行（`docs/review-desk.md`）。

## 开始任何工作前

1. 先看 `projects/<id>/` 里的文件判断阶段（`ingest.json`、`catalog.json`、`cleanup.json`、`cut-script.*.json`、`edit-plan.json`、`exports/`），不要依赖对话记录，所有交接都在文件里。新人流程见 `docs/SOP.md`。
2. 按阶段使用对应的 Skill：
   - `video-workflow`：开始或继续一条订单，判断做到哪一步；
   - `asset-prep`：① 素材 + ② 口播（导入、分类描述、口播校对、口播清理、风格卡）；
   - `storyboard`：③ 方案（AI 导演出 2–3 版表格方案，用户选定后放进审阅台）；
   - `timeline-review`：④ 精修，用户说"看我的意见"时使用。

流程是 **订单导入 → ① 素材 → ② 口播 → ③ 方案 → ④ 精修 → ⑤ 导出**，网页（`npm run desk`）里就能完成，不依赖聊天。时间线只有一份：`cut-script.<版本>.json`，edit-plan 由它编译而来。风格卡在 `library/style-cards/`，只有用户确认过的卡才能用；卡里的"包装"（贴纸、音效、音乐）只记录，由用户在剪映里补。

## 阶段与闸门

| 阶段 | 进入下一阶段的条件 |
| --- | --- |
| ① 素材 | 素材全部确认（分类、描述、口播校对），上屏的产品事实都有依据 |
| ② 口播 | `cleanup.json` 已由用户确认 |
| ③ 方案 | 用户选定一版并放进审阅台（方案没有过期） |
| ④ 精修 | 所有段落都已标记，没有待确认的提案 |
| ⑤ 导出 | `plan:verify` 通过，并且用户自己看过、听过 |

- 素材和口播清理的确认、方案的选定、提案的采纳，都只由用户操作，Claude 不代点。
- 没有选定的方案，不渲染整片。
- 没有采纳的提案，不写入 edit-plan。
- 质检不通过，不交付。
- 品牌禁止的说法（虚构数字、竞品、电池/隐私/安全、诱导箭头）不上屏，规则见 `scripts/lib/claims.mjs`。

## 修改 edit-plan 的唯一方式

- **Claude 不直接改 `edit-plan.json`。** 修改写成提案 `projects/<id>/proposals/p-NNNN.json`，格式见 `docs/review-desk.md`：
  - `basedOnRevision` 填当前的 `edit-plan.revision`；
  - `changes` 用 JSON Patch，每处修改前先加一条 `test` 确认改的是对的元素；
  - 写明理由和影响范围。
- **出提案前先看画面。** 用 `npm run desk:stills -- <id> --proposal=p-NNNN --frames=...` 生成修改前后的对比图，看过对比图再写理由，不要凭推测描述效果。
- **采纳、拒绝、回退只由用户在审阅台操作。** 服务端会校验版本号，并把旧版本存进 `versions/`。
- **过期提案不要修改。** 提案变成 stale 后，基于最新版本重出一条新的。

## 禁止事项

- 不覆盖、不删除原片、产品素材和已交付的成片。`public/recordings/` 只读。
- 不编造产品事实，不伪造前后对比，不跳过质检。
- 引用他人的视频只用于分析，不把它们的画面放进成片。
- 不升级 Node.js、Remotion 或现有依赖。可以按需新增依赖或模型，但版本要固定，模型要记录 SHA-256（`models/manifest.json`）。
- 不做破坏性的 Git 操作。

## 常用命令

```powershell
npm run desk                                  # 构建并启动审阅台 http://127.0.0.1:4310/
npm run desk:proxy -- <id>                    # 540p 预览代理
npm run desk:faces -- <id>                    # 人脸检测 -> analysis/faces.json
npm run desk:stills -- <id> --frames=a,b [--proposal=p-NNNN]
npm run desk:stills -- <id> --round=r1 --option=option-a   # 方案关键帧
npm run plan:check -- projects/<id>/edit-plan.json   # 校验，并给出人脸和安全区警告
npm run plan:render -- projects/<id>/edit-plan.json out/<name>.mp4
npm run plan:verify -- projects/<id>/edit-plan.json out/<name>.mp4
npm run order:ingest -- <订单文件夹>              # 导入订单（网页首页也能导入）
npm run order:transcribe -- <id>                  # 口播转写
npm run cut:direct -- <id> --variant=full [--card=<卡id>]   # AI 导演出方案
npm run cut:compile -- <id> --file=cut-script.<版本>.json   # cut-script -> edit-plan（网页保存表格时会自动编译）
npm run capcut:export -- <id>                      # 导出剪映草稿
npm run lint
```
