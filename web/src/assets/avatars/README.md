# Profile pictures

Copied unchanged from STeP-AI-Harness `desktop/src/assets/avatars/` at
`90ee71ca667c63284afe4996eddc7e8095b9a059`. Upstream records:

- `avatar-01.webp` to `avatar-36.webp` are the original bundled illustrations.
- `avatar-37.webp` to `avatar-56.webp` are 20 fictional office employees added on 2026-10-18, generated with
  `avatar-01` and `avatar-36` as drawing-style references. They do not depict real employees.
- `avatar-30`, `avatar-34` and `avatar-35` are near-copies that the picker no longer offers; they stay valid for an
  employee who already chose one.

All are hand-drawn ink on white, 256px WebP. Only the chosen id is stored with the employee's profile; the images
load from the app bundle. They are left out of the offline app shell (`web/vite.config.ts`).
