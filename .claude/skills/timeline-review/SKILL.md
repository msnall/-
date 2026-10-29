---
name: timeline-review
description: Turn the user's review-desk comments into edit-plan proposals. Use when the user says "看我的意见", "process my comments", or a review round was submitted (review/rN.json has submittedAt) and proposals are needed.
---

# Timeline review: comments -> proposals

Inputs: `projects/<id>/status.json` (round), `review/<round>.json`, `edit-plan.json` (note `revision`), `proposals/*.json`.

1. Collect open comments: comments in `review/<round>.json` that no proposal lists in `answers` yet, plus comments attached to rejected proposals (`comment.proposal`). Also every segment marked `drop` or `modify` without a pending proposal.
2. For each comment, look before deciding: `npm run desk:stills -- <id> --frames=<comment.at.frame>` and read the image. If the comment contradicts what is on screen (e.g. "it overlaps the bottom" but it is at the top), say so in the proposal's reason instead of guessing.
3. Write one proposal per independent change, `proposals/p-NNNN.json` (next free number, 4 digits):
   ```json
   { "id": "p-0007", "state": "pending", "basedOnRevision": <edit-plan.revision>, "answers": ["c-0003"],
     "summary": "一句话：改了什么", "reason": "为什么，引用看到的画面/数据",
     "changes": [ { "op": "test", "path": "/overlays/3/id", "value": "cta-title" },
                  { "op": "replace", "path": "/overlays/3/props/y", "value": 200 } ],
     "impact": { "durationDeltaFrames": 0, "segments": ["dose-and-cta"] },
     "createdBy": "claude", "createdAt": "<ISO time>" }
   ```
   - Only change what the comment asks for. Guard every array index with a `test` on the element's id.
   - Dropping or trimming a segment changes timing: check overlays/punch-ins anchored to words in that range still resolve (`plan:check` on a patched copy in out/), and put the frame delta in `impact`.
   - If a rejected proposal is being redone, the old one stays `rejected`; reference it in the reason.
4. Render the comparison: `npm run desk:stills -- <id> --proposal=p-NNNN --frames=<before frames> [--after-frames=<shifted frames>]`. Look at the after image; if it does not do what the reason claims, fix the proposal first.
5. Tell the user in chat: which proposals exist, one line each, and that they can preview ("在播放器中预览修改"), accept or reject them on the desk. Do not accept anything yourself.
6. A proposal the server marks `stale` (edit-plan changed after it was written) is never edited; write a new one on the current revision if still needed.
