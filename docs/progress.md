# Progress

## 2026-10-22 · Centralized PWA implementation

- Source baseline: STeP-AI-Harness `90ee71ca667c63284afe4996eddc7e8095b9a059`, Desktop 0.6.20.
- Separate repository: `iisara555/STeP-AI-Webapp`. Original Desktop repository is unchanged.
- Target: invited Google accounts, STeP tenant first, private workspaces with explicit sharing,
  owner-only memory/documents, centrally managed Gemini, Google Workspace and cloud receipt OCR.
- Public code includes no organization documents, employee records or API secrets.

### Implemented

- Invited, verified Google identities; service-only first-owner reservation and tenant bootstrap.
- SQL-enforced tenant/resource/Storage isolation; private workspaces and editor/viewer sharing.
- Personal and shared memory with confirmation, deletion, expiry and context limits.
- Authorized chat, source preview, consent, durable jobs, cancellation, drafts and Word/text export.
- Original Thai knowledge retrieval and authority factory adapted to per-tenant inputs.
- Central server-only Gemini, selected Drive text and read-only Calendar in private conversations.
- Private uploads, Office/PDF text extraction, bounded embedding indexing and explicit OCR.
- Receipt originals plus image derivatives, signature/buyer checks and separate human reviews.
- Installable shell, public-assets-only service-worker cache, mobile layout and accessible controls.
- Budget reservations/idempotency/leases, aggregate usage and deletion-safe accounting.
- Operator export/import/bootstrap tools, CI and a manually configured Pages deployment workflow.

### Verification

- TypeScript, formatting and production build passed; production dependency audit found no vulnerabilities.
- Unit/API/PWA checks: 19/19 passed, using synthetic provider responses and no live model calls.
- Real PostgreSQL (PGlite + pgvector) checks: 18/18 passed. Tests emulate permissive Supabase
  function defaults and synthetic Auth/Storage tables, including cross-tenant/private/admin isolation,
  worker RPC denial, shared-context scope, reservation accounting, cancellation/revocation, draft
  conflicts, owner bootstrap, receipt review and deletion. Full local Supabase stack was unavailable
  because its container registry was blocked; these do not replace real Auth/Storage acceptance.
- Chromium desktop/mobile checks: 14/14 passed, including consent, memory/document flows,
  receipt image preparation and saved edits, Word ZIP/content validation and WCAG A/AA checks.
  Browser tests use the explicitly labeled synthetic preview, not live Google or Gemini.
- Private upstream corpus: original retrieval/abstention 61/61 plus buyer identity 3/3 passed.
  Corpus/source files stayed outside Git; this does not measure generated-answer accuracy.

### Cloud state

- Dedicated Supabase project `zwwchjshmxdzhhotacte`, Singapore, provisioned after a $0/month quote.
  Existing Jorde project and Desktop repository were not changed.
- Eight schema migrations applied; local versions aligned with remote history. Vector, pg_net,
  Vault and cron verified installed; scheduler jobs registered but dispatch remains inert until
  its worker URL/secret are configured in Vault.
- STeP tenant created, requested owner reserved until verified Google login, AI budget zero.
- Baseline pack imported privately: 38 registered documents, two governance registries and 48 Skills.
  Staff titles reuse Desktop labels; developer-only/native-browser Skills are hidden from the web hub.
- API, worker and Google callback functions deployed. Live unauthenticated API smoke returned 401;
  worker returned 503 without configured credentials, before claiming work or calling AI.
- No public data table lacks RLS. Service worker/grant/import/bootstrap RPCs deny anonymous and
  ordinary authenticated execution. The intentional SECURITY DEFINER and private-table advisories
  are documented in operations.md. Permissive hosted function defaults were found and corrected.

### Required before staff rollout

- Create/connect the STeP Cloudflare Pages account/project and obtain its actual default URL.
- Configure Supabase Google login and Workspace web OAuth, real callback origins and Picker.
- Set server Gemini/worker/encryption credentials, Vault dispatch entries and reviewed token rates.
  No Gemini key from the conversation is embedded or enabled by this implementation.
- Verify real Google accounts and selected-file permissions; measure OCR on permitted labeled receipts;
  confirm generated Word files in the organization's editor; complete offsite backup/restore acceptance.
- Automated capacity alarms/database-size admission, binary Drive export and automated Desktop
  personal-history migration remain follow-up work; native execution stays in Desktop.
