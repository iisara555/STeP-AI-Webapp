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

No organization registry, employee record or controlled document is included.
Import these separately into the tenant database with the operator tool.
