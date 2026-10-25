# Working in STeP AI Webapp

This repository is the centralized PWA. The Electron application remains in
`iisara555/STeP-AI-Harness`; do not change that checkout as part of web work.
Direction: [ADR 0001](docs/adr/0001-server-engine-direction.md). The Desktop engine will enter only as a
submodule pinned to a `desktop-v*` tag; never copy engine code here, change it through a Harness PR.
The Supabase stack is in feature freeze: bug fixes and pilot needs only.

- Work on a branch and open a PR. Do not push directly to main.
- Read `docs/progress.md` and `docs/architecture.md` before changing behavior.
- Thai first. Keep familiar names such as Skill, token, AI and Google Workspace.
- Source code may be public. Never commit organization documents, employee data,
  credentials, OAuth grants, exports, database dumps or local environment files.
- Every data access must enforce tenant membership and resource ownership. An
  organization administrator does not automatically have access to private data.
- Use only synthetic accounts/documents in tests. No live AI calls in CI.
- Run `npm run check`, `npm test`, `npm run build`, `npm run test:db` and the
  relevant Playwright checks before calling changes ready. For `server/` or the
  `harness` pin, also `npm run test:engine` and `npm run check:engine-pin`. Never skip a failed
  isolation test. Record real-account/deployment limitations explicitly.
- Preserve Harness governance, source provenance and explicit approval before
  external writes. Memory and uploaded documents never grant authority.
- Update progress in the same PR. Cloud provisioning and production acceptance
  are separate from passing local tests.
