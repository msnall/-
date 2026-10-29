---
name: video-workflow
description: Start or continue a TikTok e-commerce video in this repo. Use when the user says to start a new video, continue a project, or asks where a video stands. Reads projects/<id>/status.json and routes to the right stage.
---

# Video workflow

1. Identify the project id (ask only if more than one project is in progress and the user did not name one). Read `projects/<id>/status.json`; if missing, the review desk server creates a default on first load (`npm run desk`).
2. Report the stage, round, open proposals and anything `blocked` (with its reason) in one short paragraph.
3. Route by `status.stage`:
   - `asset-prep`: use the `asset-prep` skill. The stage moves on when the editor confirms the beats in ① 素材准备.
   - `storyboard`: use the `storyboard` skill. The editor confirms one option in ② 方案选择, which writes edit-plan r0 and moves to timeline review.
   - `timeline-review`: make sure the desk has what it needs, then hand over:
     - proxies: `analysis/proxies.json` lists every segment asset, otherwise `npm run desk:proxy -- <id>`;
     - faces: `analysis/faces.json` exists, otherwise `npm run desk:faces -- <id>`;
     - `npm run plan:check -- projects/<id>/edit-plan.json` passes (warnings are fine, mention them).
     Then tell the user to open http://127.0.0.1:4310/#project=<id> (start it with `npm run desk` in the background if it is not running) and to say "看我的意见" after submitting comments. Use the `timeline-review` skill for that.
   - `render-qc`: the desk's "渲染 + 质检" job, or `plan:render` then `plan:verify`. Report QC failures and layout warnings verbatim; QC passing is required but not sufficient — the user must watch and listen.
4. Never move a stage forward yourself unless its gate (CLAUDE.md) is met; the user marks render-qc as passed.
