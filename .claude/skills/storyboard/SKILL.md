---
name: storyboard
description: Produce and compare plan versions (③ 方案) for a TTO order whose assets and voice cleanup are confirmed - AI director builds 2-3 table versions, the user picks or edits one, then it goes to the review desk. Use when the user asks for 方案/出方案/重新生成, or the project is at ③ 方案.
---

# 方案（③ 方案）

前提：素材全部 confirmed，口播清理 confirmed；API 可用。缺任何一项先回去（`asset-prep`），不绕过。

1. **生成**：网页「生成方案」（可选一张已确认的风格卡 → 多一个"按风格卡"版本），或 `npm run cut:direct -- <id> --variant=full|minimal|pip [--card=<卡id>]`。AI 为每句口播选录屏和时间，程序校验时长、重叠、占比、禁止说法，不合格会重试。结果是 `cut-script.<variant>.json`（**唯一的时间线文件**），`edit-plan.draft.<variant>.json` 由它编译而来。
2. **表格**：每版一张表，一行一句：时间 / 口播 / 画面 / 效果 / 字幕 / 音效。用户可逐行改画面、推近、强调词、音效，保存时先校验再写回 cut-script 并重编译。你要改某版，也改 cut-script（`npm run cut:compile -- <id> --file=cut-script.<variant>.json` 重编译（会拒绝覆盖已修改的正式方案，除非加 `--discard-edits`，不要加）），不要手改 draft。字段说明：`docs/timeline-table.md`、`docs/cut-script.md`。
3. **看画面再说效果**：编译后抽几帧看（`npm run desk:stills`），别只凭 JSON 描述。
4. **过期**：生成之后素材、文案或口播清理变了，方案显示"过期"，需重新生成。用户的审阅台正式方案不会被自动覆盖。
5. **选定**：用户点「选这一版 → 放进审阅精修」。已有改过的 edit-plan 时，系统生成新版本、保留字幕样式、上一版可还原。**这一步是用户的操作。**
6. 包装（贴纸、音效、音乐）只记录在风格卡里，由用户在剪映里补；网页渲染的成片不含音效，剪映草稿里才有。
