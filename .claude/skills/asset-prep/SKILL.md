---
name: asset-prep
description: Prepare a new video project before any storyboard - project.json, assets.json, beats (segment roles), proxies, faces, candidate stills, product claims, shot list. Use when the user brings new footage or a project is in the asset-prep stage.
---

# Asset prep

Goal: everything the storyboard needs, recorded in files, and nothing invented.

1. **Project files** (`projects/<id>/`, id = lowercase ASCII):
   - `project.json`: `{ id, title, market, language, output {1080,1920,30}, footage: "<asset id>", transcript { words, cues } }` (schema: `src/engine/storyboard.ts` projectSchema).
   - `assets.json`: the footage item (`kind: "footage"`, `file` under public/, `sha256`, `originalName`), and `claims`: every product fact the talk states (quantities, ingredients, packaging, effects), `status: "unverified"`, with a `note` on what evidence could prove it. Never mark a claim verified yourself; the editor does that in the asset desk with evidence.
2. **Transcript**: `npm run transcribe` (see docs/whisper-setup.md) if there is none; captions need cue-level and word-level files.
3. **Proxy and faces**: `npm run desk:proxy -- <id>`, `npm run desk:faces -- <id>`.
4. **Beats** `analysis/beats.json`: split the transcript into beats with roles (hook, intro, pain, benefit, proof, product, dose, offer, cta, filler). Rules: beats cover all words in order, each starts/ends on a caption cue boundary (`checkBeats` enforces it), `textZh` is a faithful Chinese translation for the editor, `claims` lists claim ids the beat states. `confirmedAt: null` - the editor confirms.
5. **Candidate stills** for assets the cards will need (product front, packaging detail, evidence for claims): `npm run desk:candidates -- <id> --sheet`, read `out/desk-cache/<id>/candidates/sheet-*.jpg`, pick frames, then `npm run desk:candidates -- <id> --extract=<frame> --as=<asset-id> --crop=x,y,w,h --note="…"` (crop in source pixels; check the result image before telling the user). Prefer frames without motion blur, label readable, no face.
6. Anything that cannot come from the footage: an `assets.json` item with `status: "missing"`, `label`, `neededBy`, and a concrete `shotRequest` (subject, framing, background, duration, notes). It appears on the printable shot list.
7. Tell the user what to do in the asset desk (① 素材准备): confirm beats, approve/reject candidates, verify claims with evidence, upload or shoot what is missing.
