# Cross-team change requests

One entry per request: date, from, to, what, why.

## 2026-10-10, from P2 to P3 (+ team): normalization details (CLAUDE.md 6.2)
Implemented in `capture/landmarks.py`. `web/lib/recognition/features.ts` must do exactly the same:
- Before normalizing, multiply x (and z) by the image aspect ratio `width / height`, so x and y are in the same unit. Otherwise the shoulder-width scale is skewed on 16:9 video.
- Scale = 2D distance (x, y) between pose points 11 and 12.
- z is only divided by the scale, not shifted: MediaPipe gives z relative to each part (hips, wrist, face).
- Frames without pose are dropped/forward-filled (no shoulders, no normalization).
Proposal: add these lines to CLAUDE.md 6.2.

## 2026-10-10, from P2/P4 to P4 (+ team): avatar player API (CLAUDE.md 6.6), backward-compatible additions
- `playGloss(gloss, { onToken })`: optional 2nd parameter. `onToken(index)` is called with the gloss index of the token being signed, each time it changes (karaoke captions, `web/components/AvatarCaptions.tsx`). `playGloss(gloss)` alone still works as in 6.6.
- `mountAvatar(container)` (in `web/lib/avatar/player.ts`) renders the avatar into a div and returns `{ webgl, unmount }`. Without WebGL, `playGloss` still runs its timing and `onToken`, so captions keep working.
- A newer `playGloss` call interrupts the current one (which resolves).
- Windows: git checks out the `web/public/signs` symlink as a text file when `core.symlinks` is off, so `/signs/*` returns 404. Local fix, no repo change: `Remove-Item web/public/signs; cmd /c mklink /J web\public\signs <repo>\signs; git update-index --skip-worktree web/public/signs`. Needed on the demo laptop if it runs Windows.
Why: the guest screen needs to know which sign is playing, and must not crash on a machine without WebGL.
