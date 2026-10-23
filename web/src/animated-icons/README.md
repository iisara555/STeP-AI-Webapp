# Animated icons

The folded sidebar's icons, shared with the Desktop app (`desktop/src/animated-icons` in
[STeP-AI-Harness](https://github.com/iisara555/STeP-AI-Harness) at `90ee71ca667c63284afe4996eddc7e8095b9a059`).

- `blocks`, `file-text`, `message-square`, `plus`, `receipt`, `search`, `sliders-horizontal` and `megaphone` are
  copied unchanged from Desktop. `megaphone` is Desktop's own drawing in the same shape (lucide-animated has none).
- `brain`, `folder-open` and `history` come from [lucide-animated](https://lucide-animated.com)
  (github.com/pqoqubbw/icons at `4662fff2b60fdcf4751b32013606756caf7c4c26`) with the same two edits Desktop made:
  the `"use client"` line and the `cn()` helper are removed.

All are MIT, see `LICENSE`. They animate with `motion` on hover or keyboard focus and stay still when the system asks
for reduced motion (`../reduced-motion.ts`). Every other icon goes through `../icons.tsx`, which keeps the Lucide
drawing and plays one short movement on its control's hover or focus.
