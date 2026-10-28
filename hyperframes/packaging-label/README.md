# Packaging label verification

Two-second transparent HyperFrames overlay for the approved Bloom10 storyboard.

- 1080 × 1920, 30fps, 60 frames.
- Root composition: `main`; scene: `compositions/label.html`.
- Local GSAP 3.15.0 and bundled Inter 700 assets, no remote fonts/scripts during render.
- Entrance 0–0.32s; gloss 0.55–1.23s; exit 1.66–1.90s.
- Background remains transparent. This component contains no audio.

From this folder, run:

```powershell
npm.cmd run check -- --json --snapshots --timeout 30000
npm.cmd run render -- --format webm --fps 30 --workers 1 --quality looks --output ../../out/hyperframes/packaging-label.webm
npx.cmd hyperframes@0.8.206 preview --background --port 3017
npx.cmd hyperframes@0.8.206 preview --status --json
```

Preview project: http://127.0.0.1:3017/#project/packaging-label

Before giving a preview URL to another person, confirm the managed preview is running. Keep it alive during review; after review stop it with `npx.cmd hyperframes@0.8.206 preview --stop`.

The full check passes runtime, layout, motion and contrast. Two craft warnings were reviewed: an empty first frame and less than two seconds of closing-line visibility. Both correspond to this short alpha overlay's intended fade-in/fade-out, rather than a standalone film's opening/ending. No silent full-film check is being claimed.

The verified reusable output is copied to `../../public/effects/packaging-label.webm`. The composited MP4 under `../../out/hyperframes/` is a demonstration over the source interval 8.78–10.78s, with the overlay shifted up 160px and original audio gain increased by 10dB in that preview only. The preview uses timestamp normalization and a short final-frame hold to produce exactly 60 frames. These are not final edit or mixing settings.

Source reference: https://github.com/heygen-com/hyperframes
