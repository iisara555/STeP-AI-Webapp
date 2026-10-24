# Upstream provenance

Copied from `iisara555/STeP-AI-Harness` at
`90ee71ca667c63284afe4996eddc7e8095b9a059` (MIT; license included).

- scorer, translation scope, task boundary and context budget are unchanged.
- `authority.js` adapts `authority-preflight.js` to accept organization YAML as
  a factory argument instead of reading organization files at module import.
  Each invocation receives its own tenant data; there is no mutable global roster.
- `simple-yaml.js` is the upstream parser used by the authority engine.
- `knowledge.ts` preserves the Desktop Thai retrieval/ranking logic; its file
  loading is replaced with a per-invocation array of authorized tenant sources.
- `../src/skill-labels.ts` adapts the staff-facing Thai title map from
  `desktop/src/skill-display.ts`; it contains UI labels only.
- `desktop/` retains the upstream document profiles/output parser, date helpers,
  document presentation presets and internal-media Prompt engine. Imports use explicit
  `.ts` extensions for web/server tooling. `starters.ts` uses Thai labels directly and
  exposes the team keys; it never uses team selection for authorization.
- `desktop/document-contract.ts` is `documentToolRule` from upstream `desktop/electron/document-tools.ts`,
  unchanged apart from its import path. The web's context assembly around it is in
  `../src/document-context.ts`.
- `desktop/draft.ts`, `desktop/thai-typography.ts` and `desktop/document-layout.ts` are upstream
  `desktop/src/` files, unchanged apart from `.ts` import extensions.
- `desktop/garuda-image.ts` is upstream `desktop/electron/garuda-image.ts` with the same pinned PNG bytes;
  only the decoding uses `atob` instead of Node's `Buffer`. Provenance and sizing are in
  `docs/third-party-notices/thai-garuda.md` (copied unchanged).
- `desktop/document-export.ts` is upstream `desktop/electron/export.ts` for the browser. The Word
  document, table layout and PDF page HTML are unchanged. Changes: imports; `DocumentImage` is declared
  locally and image bytes are encoded with `btoa`; `pdfHtml` accepts extra `@font-face` rules; the
  spreadsheet, slide, Markdown-file and agency-template (`document-template.ts`) exports and file writing
  are removed; `exportDocx`/`exportPdfHtml` replace `exportDocument` and read the Markdown draft with
  upstream `markdownDocument`.
- `desktop/document-fonts.ts` is upstream `desktop/electron/document-fonts.ts` with a font loader in place
  of the file system, Web Crypto hashes and the platform `DOMParser`; the manifest pin, per-file hashes
  and the package edits are unchanged. The font files themselves are the unchanged upstream
  `desktop/assets/document-fonts/` set, served from `web/public/document-fonts/` with their licences.
- `desktop/teams.ts` keeps only the team ids and display names from upstream `manifest/teams.yaml`
  (no starter prompts, paths or routing); a team choice never grants access.
- `../src/assistant-profile.ts` copies the speaking-style fragments from `desktop/src/speaking-styles.ts`
  verbatim and the personality tones from `src/modules/user-memory.js`; the web adds only the field
  bounds and the line that ranks these preferences below the organization rules.
- `web/src/assets/avatars/` are the unchanged Desktop profile drawings (see its README).
- Public symbol assets in `web/public/step-symbol-*.svg` are the unchanged Desktop
  artwork; palette and usage come from upstream `DESIGN.md`. No logo is redrawn.

No organization registry, employee record or controlled document is included.
Import these separately into the tenant database with the operator tool.
