# Centralized STeP PWA

> This describes the current Supabase pilot. The target architecture (Desktop engine on organization
> hardware behind a gateway) is recorded in [ADR 0001](adr/0001-server-engine-direction.md).

The web application is separate from the Electron repository. It uses a static
React/Vite app on Cloudflare Pages and Supabase Auth, Postgres, private Storage,
and Edge Functions. AI runs only on the server; the paid path uses Gemini. Hosting can start on free
plans; Gemini usage and any future plan changes are separate costs.

Desktop workflow adapters retain the original five document profiles, internal-media
Prompt compiler, Thai date helpers, team starters and document presentation presets.
Forms prepare private conversations/drafts; they do not start AI calls. Prompt
preparation stays local until an explicit handoff or download. The searchable
32-group Desktop reference records supported, partial and native-only capabilities.
See [Desktop details](desktop-reference.md) for the source inventory and limits.

## Identity and access

Google sign-in establishes identity. An unexpired invitation plus a verified
Google identity establishes tenant membership. A service-only bootstrap reserves
the first owner invitation; browser clients cannot assign owners. Domain suffixes
and editable user metadata never establish access. Tenant membership is checked
again on each operation and before a worker commits a result.

Workspaces start private. Their creator can add active members of the same tenant
as editors or viewers. Conversations have immutable private/workspace visibility.
Personal memory, documents, conversations and receipt reviews are owner-only;
tenant administrators can manage members and aggregate usage without gaining
access to private contents. Infrastructure operators still have database access.
RLS enforces these boundaries for database and Storage, including derived images.

## AI and data

The API exposes named actions, never arbitrary desktop IPC, shell or SQL. A
conversation shows selected documents and memory before asking for AI consent.
Workspace conversations cannot use private memory or another workspace's files.
Organization knowledge comes from an explicitly imported, versioned Harness pack;
source instructions cannot grant authority. The original retrieval and authority
code is retained with its MIT notice and source commit under harness-core/vendor.

Skill-local text references/templates/examples retain provenance and are excluded
from general organization retrieval. The selected Skill may include bounded working
references labelled as such. Existing mandatory sources remain complete; oversized
material fails before provider access, and unavailable sources remain explicit gaps.
User-scoped history search uses the same tenant/session/message RLS as reading a
conversation, searches title/draft/body without an external search service, and
returns at most 50 sessions. The new routes require matching API/worker deployment.

Postgres jobs use idempotency keys, leases, a global concurrency cap of two, fresh
access checks and budget reservations. Interrupted jobs do not replay provider
calls automatically. Responses are stored once. Failed or ambiguous calls retain
their reservation because a provider may already have charged. Usage is an
estimate based on configured rates, not a provider invoice. Paid AI is disabled until
server credentials, rates and a positive tenant budget have been configured.

Google Workspace uses a separate web OAuth grant: Calendar read-only and
drive.file for explicitly selected files. Grants are encrypted server-side with
tenant/user associated data. Paused and expired grants have distinct remedies.
OAuth scopes remain subject to Google's verification and the organization's
policies. This implementation does not send email or modify Google resources.

## Files and receipts

Original files stay in private Storage. PDF and Office text extraction runs in the
browser; image preparation runs in a worker. OCR is explicit, billed Gemini work.
Prepared receipt images are separate derivatives so the original remains
available. Receipt output has three sections: type, completeness and next steps.
The model also checks signatures and the configured STeP buyer details. Findings
remain unverified until a person compares the original and saves a review; they
never constitute reimbursement approval or signature authentication.

Limits include 10 MiB/file, 30 PDF pages, 200k extracted characters, 32k AI input
tokens, bounded embedding batches, 800 MB/tenant and 25 MB/member file storage.
Pilot capacity is at most 20 invited staff. These are application limits rather
than promises of free-plan capacity or OCR accuracy.

## PWA and operations

The service worker caches public application assets only. API responses,
documents, memory and conversations are not cached for offline reading. Signing
out clears in-memory application state; Auth tokens remain managed by Supabase.
Desktop-native integrations remain in the original Desktop app.

Schema, function deployment, OAuth configuration, secrets, an actual Pages URL,
organization import, backups and real-account acceptance are separate steps.
Passing synthetic tests does not certify a live Google or Gemini connection.
See deployment.md and progress.md for the verified state and outstanding setup.

## Administrator OpenRouter trial

Settings → เชื่อมต่อ AI includes a separate, synchronous text-only OpenRouter
trial for active owners/admins of one operator-selected tenant. It works with
zero Gemini budget and does not enable paid chat, embeddings or receipt OCR.
Only the explicitly consented trial prompt is sent; no stored conversations,
memory, organization documents or Google context are retrieved. Known credential
patterns are rejected. Free providers may retain data or train on it; the UI asks
for synthetic, nonconfidential input and explains this before each attempt.

The API authenticates tenant membership and admin role, requires explicit consent,
and reserves an idempotent attempt via a service-only Postgres function that checks
the active tenant/admin again. Reservations serialize per tenant, allow at most
5 attempts/minute and 40/day (UTC), and retain only IDs/timestamps. Failed and
ambiguous attempts count and are never retried automatically. A fresh provider
catalog check requires a `:free` model, text input/output and zero for every
reported price, including prompt/completion. Each generation disables provider
fallbacks and sets prompt/completion/request/image price ceilings to zero. There
is no paid-model fallback or purchase action. Provider billing remains external;
an unexpected nonzero reported cost is surfaced as an error.

Responses are bounded to 2048 output tokens with a 20-second upstream deadline,
rendered as plain text and held only in component memory. Only token totals,
elapsed time and optional reported cost accompany the reply; raw provider
diagnostics and keys never reach clients. Missing cost is not reported as $0.
The user's admin role is rechecked before returning a result. The demo path is
explicitly synthetic and makes no provider request.

## Provider and deployment configuration

The API/worker/callback retain the existing deployed provider selection and Vault
fallback. Environment values override the exact Vault allowlist; only service_role
can read the configuration RPC. A configuration failure returns a sanitized 503.
Snapshots expose provider/model/consent metadata, never keys. User confirmation is
bound to that provider, model and upstream; the API and worker reject a changed
identity before sending context.

The existing opt-in OpenRouter worker pilot supports administrator text chat and
pins one free model/upstream with data collection denied and zero price ceilings.
It can use the authorized context shown at confirmation and stores conversation
results. It remains separate from the temporary synthetic-only Settings sandbox.
The worker pilot is disabled by default and does not enable a paid budget.

Both channels serialize admission under one account lock and share 40 attempts per
UTC day / 15 per minute, including failed, cancelled and purged accounting rows.
The Settings sandbox also retains its 5/minute per-tenant limit; the worker has an
additional tenant daily limit. PostgreSQL tests cover the combined accounting and
revocation paths; real multi-connection contention is a separate acceptance check.
See [backend pilot preparation](backend-pilot.md) before deployment or activation.
