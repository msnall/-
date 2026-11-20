---
name: asset-prep
description: Prepare a new TTO order before any plan - import the order folder, classify and describe assets, proofread the creator voice-over text, clean the voice-over, optionally learn a style card from a reference video. Use when the user brings a new order/footage or the project is at ① 素材 / ② 口播.
---

# 素材准备（① 素材 + ② 口播）

目标：每个素材都归对类、有描述，口播文字准确，口播已清理。全部记录在文件里，不编造。

1. **导入**：网页首页「导入订单素材」，或 `npm run order:ingest -- <订单文件夹>`。产出 `public/derived/<id>/*.mp4`（竖屏 ≤1080 宽、30fps）和 `projects/<id>/ingest.json`。订单文件夹只读，不改、不删。
2. **转写**：`npm run order:transcribe -- <id>`（英文 small.en，模型已在 `models/manifest.json` 固定）。机器稿需要人校对。
3. **分类和描述**（`catalog.json`）：五类 = 文案 / 达人口播 / 达人动作 / 游戏录屏 / 官方素材。描述 AI 先写（API 设置里配置的模型），用户改过的描述标「已人工修改」，之后不覆盖。
4. **校对口播文字**：用户在 ① 素材的「文案」分类里改；只能改拼写，不能增删词（字幕按词对齐，`order:sync-text` 会拒绝）。不要替用户改文字；发现疑似听错可以指出。
5. **确认**：全部素材 confirmed 后才能进 ②。确认是用户的操作。
6. **口播清理**（② 口播）：网页「开始检测」，或 `node scripts/cleanup-voice.mjs`（`--review` 让模型复核口误和重说）。检测停顿、语气词、重复、重说，结果在 `cleanup.json`；用户逐处核对后「确认清理」，改了就要重新确认。细则见 `docs/voice-cleanup.md`。
7. **风格卡（可选）**：参考成品在网页「风格库 → 拆解新视频」，或 `npm run ref:analyze`、`node scripts/learn-style-card.mjs`。草稿卡不生效，用户核对六栏并确认后才能用。细则见 `docs/style-card.md`。
8. 产品事实：上屏的数字、功效、评分必须有依据；品牌禁止的说法见 `scripts/lib/claims.mjs`（虚构数字、竞品、电池/隐私/安全、诱导箭头）。查不到依据就不上屏，并告诉用户。
9. 告诉用户该在页面上做什么（核对分类、校对口播、确认、确认清理），不要替他点。
