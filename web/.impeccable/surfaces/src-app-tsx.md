---
version: 1
slug: 'src-app-tsx'
primary_target: 'src/App.tsx'
related_targets: ['src/Chat.tsx', 'src/ReceiptView.tsx']
---

Scope: the whole signed-in PWA shell (title bar, sidebar, page header, status bar) plus chat, artifact pane, receipt and the tool pages; login. Mode: Operate.

Audience/job: STeP staff from every team doing document, knowledge and receipt work with org-governed AI. Constraints: PRODUCT.md, WCAG 2.1 AA both themes, Thai first, no capability shown that the web does not have.

## Direction contract

THESIS: The web app is the STeP AI Desktop in a browser: same Notion-calm ink-on-paper world and three-pane workspace, so staff moving between Desktop and web find everything where they expect it. Refuses a separate "web" look with its own cards, eyebrows and topbar controls.
OWN-WORLD: Desktop theme.css tokens verbatim (#FFC709 fill with #231F20 ink, --sidebar/--surface/--paper layers, hairlines, --selected rows, inset 3px yellow active marker), IBM Plex Sans Thai 14px/1.7, hand-drawn ink illustrations only in empty and waiting states.
STORY: Staff see their tasks and tools in the sidebar, type a request on the home screen, review exactly what AI will read, then shape the result in the draft pane and export.
FIRST VIEWPORT: 40px title bar (STeP menu, rail toggle, workspace switcher, centred command bar), 246px sidebar (symbol + MAKE INNOVATION SIMPLE, yellow เริ่มงานใหม่, search, task filter, dated task groups, folding เครื่องมือ, การตั้งค่า, profile), main pane with 78px title header, welcome greeting + two-line promise with highlighted second line + chat illustration, starters, docked composer, 28px status bar.
FORM: Desktop parity (user-pinned), position 1; signature move: the yellow inset active marker shared by tasks, tools and palette rows. seed:9d88740fd303699d (roll recorded; the user-pinned Desktop direction overrides its assignment)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
