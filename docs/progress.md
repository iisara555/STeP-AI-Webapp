# Progress

## 2026-10-24 · Document drafting as Desktop does it

- Observed: a TOR from เครื่องมือร่างเอกสาร came back as the canned "ยังไม่พบเอกสารองค์กรที่ยืนยันเรื่องนี้"
  reply. Causes: the worker's organization-question guard answered before the Skill was loaded; the
  web sent only the primary Skill (no drafting contract, supporting Skill, template or references);
  Skill pointer files to central templates were not followed; 4,096 output tokens cut a TOR short; and
  the answer was not split into draft and review.
- A run now records its document tool (`input.documentTool`, validated against Desktop's five tools).
  The worker loads Desktop's `<document_tool_contract>` (copied verbatim) between organization rules
  and personal preferences, the supporting Skill `thai-official-documents`, the tool's working template
  and drafting references by imported path, and follows short pointer files one hop to the central
  copy. Files the Harness pack lacks are named as gaps the review must record, never filled from
  general knowledge. A revision sends the current draft as untrusted content.
- Document runs may answer with up to 8,192 tokens, only as far as the existing reservation covers:
  the reservation assumes 64k input tokens while context stays capped at 32k. No budget rule changed.
- The answer uses Desktop's `<document_draft>`/`<document_review>` envelope: the draft opens in the
  ผลงาน pane, and the conversation shows only the review and what still needs confirmation. The
  document tool page shows which Skills and template it uses.
- Validation under Node 25.2.1: TypeScript, build, 48 unit/API/PWA tests (new: context assembly,
  pointer files, contract order, output cost bound, and a mocked worker run proving a TOR reaches the
  model with its contract), 29 PostgreSQL tests and 38 desktop/mobile Playwright tests (new: draft goes
  to the pane, review stays in the chat). No live AI call was made.
- Known gaps in the imported Harness pack: `docs/thai-data-formatting.md` and
  `skills/pm/tor-government-writing/references/task-adaptations.md` are not imported; drafts list them.
- Requires redeploying the API and worker and rebuilding the homelab frontend. No migration. Not yet done.

## 2026-10-24 · Profile, assistant, answer style and memory types from Desktop

- Settings opens on โปรไฟล์และผู้ช่วย, as Desktop's ทั่วไป: the 56 Desktop avatar drawings (53 offered),
  the name to be called, main team, assistant name, chat language, the four personality presets,
  คมคาย (Witty) and ชวนคิด (Ob-Oon), and the ภาษาเหนือ language style, with Desktop's prepared
  examples (no AI call). The sidebar shows the avatar, name and "ผู้ช่วย … · ทีม …"; the greeting,
  starters and answer labels use the chosen name, team and assistant.
- Preferences are stored per employee and tenant in `member_profiles` (migration
  `20261023120000`). RLS lets only the employee read or change their own row; tenant admins cannot,
  ownership columns are not updatable, and values are bounded in SQL and the API. Names and the custom
  tone pass the same credential checks as messages.
- The worker appends the run owner's preferences after `SYSTEM_RULES`, opening with a line that ranks
  them below organization rules, sources, authority, approvals and privacy. Speaking-style text is
  Desktop's verbatim. The consent preview lists "ชื่อเรียก ทีม และสไตล์การตอบที่คุณตั้งไว้" when a
  profile exists; nothing else about the employee is added to the request.
- Memories gain Desktop's types (adds บริบทโครงการ), a lifetime in days, their origin (พิมพ์เอง/จากแชต)
  and Desktop's guidance. The consent preview now leaves out expired memories, matching the worker.
- Validation under Node 25.2.1: TypeScript, build, 41 unit/API/PWA tests, 29 PostgreSQL tests (new
  owner-only profile and memory-type checks) and 36 desktop/mobile Playwright tests passed; axe is clean
  on 40 page/theme/viewport combinations. No live AI or Google call was made.
- Requires before it works on the homelab: applying the migration to the hosted project and redeploying
  the API and worker (the frontend alone shows Settings but cannot save). Not yet done.
- Not carried over: Desktop's installed output styles, importance, AI-proposed memories, the lessons box,
  English UI and voice.

## 2026-10-23 · Homelab rollout of #10 (Desktop-parity interface)

- Merged #10 after CI passed. The second CI run followed a fix for a theme-switch contrast flicker
  (button backgrounds no longer animate between themes); CI's first run had caught it at 3.67:1.
- The homelab frontend was rebuilt from main `a78b769` (source copied with `git archive`) and is
  healthy behind Tailscale Serve at the same tailnet origin. The previous image is tagged
  `step-ai-webapp:pilot-8cd4a23` for rollback; earlier source trees were kept, not deleted.
- Hosting smoke passed over HTTPS (static shell, OAuth callback, PWA cache headers, CSP, missing
  assets). The served bundle contains the new interface, and the synthetic demo renders without page
  errors. No Supabase function, migration or secret changed; the contract edit is type-only.
- Not yet accepted: the new interface with a real Google account, Gemini, receipt OCR and the
  OpenRouter sandbox after this rollout.

## 2026-10-23 · Desktop-parity interface and audit fixes

- The web shell now follows Desktop 0.6.20 (`90ee71c`) DESIGN.md: Desktop's theme tokens verbatim,
  a 40px title bar (STeP menu with theme, sidebar toggle, workspace switcher, command bar), a 246px
  sidebar (symbol and MAKE INNOVATION SIMPLE, เริ่มงานใหม่, search, งานทั้งหมด/มีผลงาน, tasks grouped
  by date, folding เครื่องมือ, การตั้งค่า, profile), a folded icon rail, page headers and a status bar.
- Chat matches Desktop: greeting and two-line promise with illustration, team starters that fill the
  composer, and a composer on the home screen. Sending there creates a private task and opens the
  existing consent preview; no AI call happens before consent. Workspace-shared tasks still start from
  เริ่มงานใหม่. The draft opens as a right-hand ผลงาน pane with save and Word/text export.
- Receipt review uses Desktop's layout (original on the left, review sections on the right) and keeps
  the ทดลอง status. Pages lose their eyebrow labels; the command palette also searches tasks.
- Desktop's hand-drawn illustrations are reused in empty and waiting states, cropped to WebP with the
  source and licence note in `web/src/assets/illustrations/README.md`. Sidebar rail icons use Desktop's
  lucide-animated set (MIT, `motion` 14.1.0) plus brain, folder-open and history from upstream; every
  other icon plays Desktop's short hover/focus movement. Both stop under reduced motion.
- Audit fixes: dark-mode contrast for selected tasks, avatars, success/found/missing states, notices and
  the sign-in screen (lowest measured 5.6:1); `aria-current` on navigation and tab semantics on filters;
  44px touch targets on coarse pointers; a 12px floor for Thai text; an in-app update dialog instead of
  `window.confirm`; a keyboard-reachable receipt preview; tool pages load on first open (main bundle
  188 → 147 KB gzip).
- Validation under Node 25.2.1: TypeScript, build, 38 unit/API/PWA and 27 PostgreSQL tests, and 32
  desktop/mobile Playwright tests passed, including a new dark-theme state check. axe (WCAG 2.2 AA and
  best practice) is clean on 40 page/theme/viewport combinations. `prettier --check` reports only CRLF
  line endings in this Windows checkout; content formatting passes with `--end-of-line auto`.
- An independent design review against the Desktop screenshots ran two rounds; its fixes (draft-pane
  sources, Desktop's grey disabled send, drawer scroll, touch hints, menu and Skill copy) are applied.
  `web/PRODUCT.md` and `web/DESIGN.md` record the product and the inherited Desktop design.
- Not done here: no deployment, no real-account check. Desktop-only surfaces (tabs for เว็บ/งานเบื้องหลัง,
  model picker, งานตั้งเวลา, avatar pictures) are not imitated because the web has no such capability.

## 2026-10-23 · Homelab origin, first owner and OpenRouter empty replies

- The frontend from main `5f7d059` runs on the homelab (Ubuntu 24.04) as a healthy,
  loopback-only container. Tailscale Serve publishes it inside the tailnet at
  `https://homelab.tail17add1.ts.net:8443`; hosting smoke passed over that origin.
  No public ingress or Funnel was created. Docker requires sudo on that host.
- Auth Site URL/redirect, Google login, disabled email/anonymous sign-in and the
  `APP_ORIGIN` secret were configured by the operator. The API returned 401 for the
  homelab origin and 403 `ORIGIN_DENIED` for a foreign origin. The first verified
  Google sign-in claimed the reserved owner membership; Auth holds only that account.
- Workspace OAuth, Picker and credential-encryption secrets were set by the operator;
  Workspace connection, Gemini, worker dispatch and a member denial test are not yet
  accepted. AI budget remains zero.
- The administrator OpenRouter sandbox reached the provider. One attempt received an
  upstream 429; another spent its 512-token output budget on reasoning and returned no
  text (522 tokens, $0 in OpenRouter Activity), surfacing as `OPENROUTER_RESPONSE_INVALID`.
  The sandbox now requests low, unreturned reasoning with 2048 output tokens, and both
  the sandbox and worker report empty text as `AI_EMPTY_REPLY`. The worker keeps
  `require_parameters` and does not send reasoning options, so non-reasoning pinned
  upstreams remain eligible. Requires API/worker redeployment.
- Validation: TypeScript, formatting, build, 38 unit/API/PWA and 27 PostgreSQL tests
  passed with synthetic provider responses under Node 25.2.1. No live AI call was made
  by tests; Playwright was not rerun because only an error catalogue entry changed.

## 2026-10-23 · Expanded Harness pack import

- Hosted migrations match all 12 local versions. API/worker version 5 are ACTIVE and
  their deployed source matches main after PR #6 (only the type-only `contracts.ts`
  is stripped by bundling); google-callback version 4 is unchanged since that rollout.
- Exported the reviewed baseline from a clean clone at
  `90ee71ca667c63284afe4996eddc7e8095b9a059`: 106 sources / 48 Skills. The upstream
  verifier passed original retrieval 61/61 and buyer identity 3/3. The operator imported
  it into the STeP tenant; hosted SQL confirmed 106 sources and 48 Skills at that version.
  The pack stayed in ignored `.exports/`; no source bodies entered Git.
- The import secret check rejected the pack because `sk` without a separator matched
  `skill-authoring-standard`. Key prefixes now require `sk-`/`sk_`, `ghp_` or
  `github_pat_`, matching the exporter. Synthetic tests keep real key shapes rejected.
  The deployed API/worker still use the earlier pattern for memory/prompt checks and
  need redeployment after merge.
- Export now normalizes Windows path separators, so `.exports/` output works there.
- Validation: TypeScript, formatting (line endings normalized for a CRLF checkout),
  production build, 38 unit/API/PWA and 27 PostgreSQL (PGlite) tests passed under
  Node 25.2.1, outside the declared engine range. Playwright was not run; no UI changed.
  No live AI, Google call, homelab installation or function deployment was performed.

## 2026-10-23 · Desktop workflows and complete product reference

- Audited Desktop 0.6.20 at `90ee71ca667c63284afe4996eddc7e8095b9a059`.
  Added a searchable Thai reference covering 32 feature groups and all 91 top-level
  renderer modules, with pinned source links and a SHA-256 inventory. Statuses
  distinguish web support, partial support and capabilities still requiring Desktop.
- Added the original five document profiles/variants, team starters, internal-media
  Prompt compiler, Thai dates and Word presentation presets. Forms prepare private
  drafts/conversations and still require the existing per-request AI consent.
  Media preparation is local; no image-generation API or external publication is added.
- Added Skill search/team filters/details, source gaps and command search, title/body/draft
  history search under user RLS, theme selection before first paint, original symbol
  artwork, CI colours and a collapsible desktop rail. Word supports Markdown headings,
  bullets/tables, three A4 presets and page numbers; native rich editing/font embedding
  and institutional-template acceptance remain separate.
- Extended private Harness export with 66 non-executable Skill-local references,
  templates and examples: 106 sources / 48 Skills in the reviewed baseline pack.
  Paths/symlinks, restricted registry entries, size and credential checks remain enforced.
  Worker retrieval and the upstream verifier exclude working references from organization
  knowledge. Mandatory sources remain complete or stop on context limits; missing
  originals remain explicit gaps. No source bodies or staff records enter public Git.
- Validation: type/format and production build passed; 38 synthetic unit/API/PWA,
  27 PostgreSQL (PGlite) and 30 desktop/mobile browser tests passed. Browser checks
  include Word XML/layout, local media preparation, consent, history, Skill details,
  responsive layout and WCAG A/AA in both themes. Original private retrieval 61/61
  and buyer identity 3/3 passed; all 91 upstream module hashes were verified.
- The production Docker image built with TLS verification and the environment proxy/CA.
  Its dedicated local container is healthy, non-root (`101:101`) and read-only;
  static hosting/CSP/PWA/OAuth callback smoke passed. GitHub Actions run 39875584009
  passed on the reviewed implementation head. These are local/CI checks, not homelab
  or live provider acceptance.
- A later CI accessibility check caught an intermediate theme frame with yellow
  text over a transitioning light background. Button ink/background now switch
  together; only the border transition remains. Immediate theme checks are retained
  without sleeps, disabled contrast rules or automatic test retries.
- Main's existing homelab/backend changes (#4/#5) are integrated. Matching API/worker
  deployment and operator import of the expanded private pack are still required for
  the new routes/context. The hosted project remains on the previously recorded
  function/pack versions; no live inference, Google write, paid usage, source import
  or real homelab installation was performed for this change.
- The complete capability reference records remaining work: personal Skill approval,
  recurring user schedules, Tasks/Gmail writes, learning/maintenance, rich/native Office,
  browser/Vault/MCP/process tools, voice and image generation. No placeholder action
  claims these have been ported. See [Desktop details](desktop-reference.md).

## 2026-10-22 · Homelab pilot preparation

- Added a reproducible multi-stage Docker build and Compose service for the static
  frontend, with pinned Node/nginx image digests. Only a hosted Supabase URL and
  modern publishable key are accepted as browser configuration. Operator files,
  source credentials and local environment files are excluded from the build context.
- Runtime is a non-root nginx process on a read-only filesystem, with a loopback-only
  host port, bounded resources, PWA cache headers, security headers, SPA/OAuth callback
  routing and a health check. Supabase remains the backend; no database is self-hosted.
- Added Thai setup/rollback instructions for Tailscale Serve over a dedicated HTTPS
  port, plus a hosting smoke checker. The current pilot uses Tailscale; no Cloudflare
  DNS, Tunnel, Access policies or public ingress were created.
- Validation: type/format checks, 24 unit/API/PWA tests, 21 PostgreSQL tests, the
  production build and 16 desktop/mobile browser checks passed. The Docker image
  built and ran healthy; hosting checks verified callback fallback, cache/CSP headers
  and missing-asset handling. Its runtime contains no server credentials or build CA.
- The target homelab is not installed yet: this execution environment has
  `vpn_configured: false` and no TCP grants. SSH installation and testing from an
  actual tailnet device require that network connection first. No live AI was called.
- After combining the frontend consent update from PR #5, the production Docker
  image was rebuilt and ran healthy. Hosting smoke plus four desktop/mobile admin
  trial/accessibility checks passed. The download bundle contains the combined
  source and public Supabase configuration; the real homelab is still not installed.
- Supabase backend reconciliation is tracked in PR #5. The sandbox/shared-quota
  migrations are installed and API/worker/callback are now version 4. SQL verified
  service-only configuration/reservation RPCs, sandbox RLS, zero paid budget and
  disabled worker trial. Merge that frontend consent update before installing this
  checkout; the prepared bundle combines both PRs. The actual HTTPS origin,
  replacement trial credentials and live Google/AI acceptance are still pending.

## 2026-10-22 · Administrator OpenRouter free trial

- Added Settings → เชื่อมต่อ AI → ทดลอง OpenRouter Free for active tenant owners/admins.
  The separate channel accepts only explicitly consented synthetic text, without
  organization documents, memory, chat history or Google Workspace context.
- Server-only credentials and a single configured tenant gate access. Every call
  checks the live catalog for a zero-priced `:free` text model and sets zero price
  ceilings with provider fallbacks disabled. No paid AI budget or purchase is enabled.
- Service-only SQL reservations enforce idempotency and shared limits of 5 attempts
  per minute / 40 per UTC day, including failed attempts. Prompts/replies are temporary
  UI state; only reservation IDs/timestamps are persisted. Provider errors are sanitized.
- Validation: type/format checks and production build passed; 24 synthetic unit/API/PWA
  tests, 21 PostgreSQL isolation/accounting tests and 16 desktop/mobile Playwright tests
  passed, including consent reset, temporary result clearing and accessibility.
- Not activated in production: this environment has no Supabase credentials and its
  outbound policy does not permit OpenRouter. No transcript key was installed or
  committed and no live inference was attempted. Activation requires applying the new
  migration, deploying the API/frontend, setting a replacement `OPENROUTER_API_KEY`
  with `OPENROUTER_TRIAL_TENANT_ID`, then real-account authorization and $0 billing
  acceptance. Existing hosting/Google rollout requirements below remain applicable.

## 2026-10-22 · Supabase backend reconciliation

- Recovered the existing provider/Vault migrations and version-3 function behavior
  into source while retaining the administrator-only, temporary Settings sandbox.
  Worker chat remains a separate opt-in channel; paid budgets are unchanged.
- Added shared account admission for both OpenRouter paths: 40 attempts/day UTC
  and 15/minute, including failed/cancelled/purged jobs. The sandbox also retains
  its 5/minute tenant limit. Admission locks precede tenant locks for free jobs.
- Added the sandbox tenant restriction to the service-only Vault allowlist.
  Environment values take precedence; configuration failures return a sanitized 503.
  Browser confirmations bind provider/model/upstream consent, and the API/worker
  reject stale consent before sending context. Text-only mode disables OCR/indexing.
- Validation: type/format and production build passed; 31 unit/API/PWA, 26 real
  PostgreSQL (PGlite) and 16 desktop/mobile browser/accessibility checks passed.
  Vault tests use synthetic rows; multi-connection contention, actual OAuth and
  provider billing still require live acceptance. No live AI was called.
- The combined PR #4/#5 frontend built and ran as a healthy non-root, read-only
  Docker container. Hosting smoke and four desktop/mobile sandbox/accessibility
  checks passed against that production image. The operator bundle was refreshed
  with matching frontend source and public configuration only.
- Applied the sandbox and shared-quota migrations in the hosted project as
  `20261022164853` and `20261022164909`; local filenames match all 12 remote versions.
  The earlier sandbox migration had not been deployed and was renamed to its
  assigned version without rewriting remote history. API/worker/callback version 4
  are ACTIVE, with the sandbox route and provider consent verified in deployed source.
- Hosted SQL confirmed the service-only RPC ACLs, sandbox RLS, shared quota/Vault
  allowlist definitions, no public table without RLS, zero paid budget and disabled
  worker trial. Security advisors show only the documented 12 intentional RPC WARNs
  and four policy-free private-table INFOs. No server key was printed or installed.
- Direct HTTP smoke could not reach the hosted function URLs with the available
  network tools; deployment/source checks do not establish runtime or login acceptance.
  Homelab SSH, the real HTTPS origin, replacement trial credentials and real-account
  trial acceptance remain pending. The sandbox tenant restriction is unset in Vault.

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
