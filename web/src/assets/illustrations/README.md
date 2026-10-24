# Illustrations

Hand-drawn ink scenes shared with the Desktop app, used only in empty and waiting states. They are decorative:
the surrounding headings carry the meaning, so every image is rendered with empty `alt` and `aria-hidden`.

| File                | Source in [STeP-AI-Harness](https://github.com/iisara555/STeP-AI-Harness) at `90ee71ca667c63284afe4996eddc7e8095b9a059` |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `chat.webp`         | `desktop/src/assets/illustrations/section-art-sheet.png`, 440×390 at (35, 166), caption corner painted paper `#FEFDFA`  |
| `workspace.webp`    | same sheet, 440×390 at (545, 166), caption corner painted paper                                                         |
| `skills.webp`       | same sheet, 440×390 at (1055, 166), caption corner painted paper                                                        |
| `receipt.webp`      | same sheet, 440×390 at (35, 633)                                                                                        |
| `connections.webp`  | same sheet, 440×390 at (545, 633)                                                                                       |
| `teamwork.webp`     | `desktop/src/assets/illustrations/teamwork.png`, converted to WebP                                                      |
| `idea.webp`         | `desktop/src/assets/illustrations/idea.png`, converted to WebP                                                          |
| `media-couple.webp` | `desktop/src/assets/illustrations/media-couple.webp`, unchanged                                                         |

The crops use the same scene offsets as Desktop's `desktop/src/illustration.tsx` and were made with ffmpeg
(`crop`, `drawbox`, `libwebp` quality 82). The drawings themselves are unchanged.

Licence: Desktop's DESIGN.md records that the user supplied these illustrations on 2026-09-29 and stated they are
licensed for this use, with the source and licence record to be kept with CC before wider distribution. The web app
reuses them on that same basis (confirmed by the user for this change); confirm the record with CC before any
distribution beyond STeP staff.
