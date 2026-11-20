---
name: video-workflow
description: Start or continue a TikTok One (TTO) order video in this repo. Use when the user says to start a new order/video, continue a project, or asks where a video stands. Checks the project files and routes to the right stage (素材 → 口播 → 方案 → 精修 → 导出).
---

# Video workflow (TTO 订单流程)

整条流程在网页里就能完成（`npm run desk` → http://127.0.0.1:4310/），不依赖聊天。面向新人的步骤见 `docs/SOP.md`。你的作用：看清现状、告诉用户下一步、做网页做不了的事。

1. 确定项目 id（只有一个以上进行中且用户没说时才问）。读文件判断阶段，不要靠对话记录：

   | 看这个 | 说明 |
   | --- | --- |
   | `projects/<id>/ingest.json` | 有 = 订单已导入（`npm run order:ingest`，或首页「导入订单素材」） |
   | `projects/<id>/catalog.json` | 素材分类、描述、口播校对；全部 confirmed = ① 素材完成 |
   | `projects/<id>/cleanup.json` | `confirmedAt` 有值 = ② 口播清理完成 |
   | `projects/<id>/cut-script.<full\|minimal\|pip>.json`、`edit-plan.draft.*.json` | ③ 方案已生成；`director-run.json` 记录生成情况，网页会标「过期」 |
   | `projects/<id>/edit-plan.json` + `versions/` | ④ 精修（审阅台）中的正式方案 |
   | `projects/<id>/exports/` | ⑤ 已导出的成片 / 剪映草稿 |

2. 用一小段话报告：当前在哪一步、缺什么、有没有过期的方案或待处理的提案。
3. 按阶段路由：
   - ① 素材、② 口播：交给用户在页面上核对并确认（`asset-prep` skill 讲怎么准备）。**不替用户确认素材或清理。**
   - ③ 方案：`storyboard` skill。
   - ④ 精修：`timeline-review` skill（用户说"看我的意见"时）。
   - ⑤ 导出：网页导出中心渲染并质检，或生成剪映草稿；也可 `npm run plan:render` 再 `plan:verify`。质检失败原样报告；质检通过只是必要条件，用户必须自己看、听一遍。
4. 闸门（见 CLAUDE.md）没满足就不往下走；订单文件夹只读。
