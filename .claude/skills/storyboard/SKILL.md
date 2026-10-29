---
name: storyboard
description: Write storyboard options (3 TK e-commerce edits built from technique cards) for a project whose beats are confirmed. Use when the user asks for options/方案, a new storyboard round, or the project is in the storyboard stage.
---

# Storyboard options

Inputs: `projects/<id>/analysis/beats.json` (must be confirmed), `assets.json`, `library/techniques/*.json` (cards), `library/styles/*.json`, `library/taste-rules.json` (approved rules are enforced; follow proposed ones as guidance).

1. Read the cards. Only `status: "ready"` cards can be used; others say what they are blocked by (2b work).
2. Write `storyboard/r<N>/option-a|b|c.json` (schema: `src/engine/storyboard.ts` optionSchema). One row per beat, in beat order; `keep: false` needs a `reason`. Each kept row: `onScreen` (Chinese, what the viewer sees) and `cards` with filled `slots` (word slots are transcript word indices inside that beat; asset slots are assets.json ids; claims shown on screen go in the card's `claims`).
   - The three options differ in the opening (hook) and style pack; middle and CTA can be shared.
   - Only make an opening the transcript supports (no pain beat -> no pain opening). Hook text must be a faithful summary of what is said; on-screen text is English for the US market.
   - Drop beats whose claims cannot be verified, and say so; never put an unverified claim on screen.
   - If a card needs an asset that does not exist, keep it only if it is worth asking for; add the item to assets.json as missing with a shotRequest (the asset-prep skill).
3. Compile: `npm run desk:compile -- <id> r<N> --all`. Fix every ERROR. Look at WARN lines (face/safe-zone) and fix placement or timing; a punch-in must end inside its segment.
4. Keyframes: `npm run desk:stills -- <id> --round=r<N> --option=option-x` for each option, then read the images. If a keyframe shows something wrong (text over the face, card over the product, odd crop), fix the option and redo.
5. Tell the user, one line per option, and that they choose in ② 方案选择 (style menu, drag elements, then confirm). Confirmation is theirs; the gate requires confirmed beats, available assets and verified claims.
6. A new round (`r2`) when the user wants different cards or beats; never edit a confirmed round.
