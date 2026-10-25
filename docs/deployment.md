# Deployment

For the initial homelab pilot, use [homelab + Tailscale](homelab.md). The frontend
runs on the homelab while Supabase remains hosted. Pages is a later hosting option.

## Hosting

Use a static Cloudflare Pages project and dedicated Supabase project. The initial
project is `zwwchjshmxdzhhotacte`, Singapore, created after its quoted monthly cost
was $0. No Pages project has been provisioned for this pilot, and Google OAuth management
requires separate setup. An actual Pages URL has not been created.

Create Pages in the STeP account, connect this repository, and use:

| Setting                         | Value                     |
| ------------------------------- | ------------------------- |
| Production branch               | main                      |
| Root                            | repository root           |
| Build                           | `npm ci && npm run build` |
| Output                          | `web/dist`                |
| Node                            | 24                        |
| `VITE_SUPABASE_URL`             | Supabase API URL          |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Enabled publishable key   |

Cloudflare assigns the real `*.pages.dev` URL. Alternatively use the manual Pages
workflow after creating a project: add repository variables `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_PROJECT_NAME`, both `VITE_` values, and secret `CLOUDFLARE_API_TOKEN`
limited to Pages editing in that account. Choose one deployment route. The
workflow runs only on main, never on PRs. Vercel Hobby was not selected for
organizational commercial use. Review [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
and [Supabase pricing](https://supabase.com/pricing); AI costs are separate.

## Backend

With the official Supabase CLI installed:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy api worker google-callback --no-verify-jwt \
  --use-api --import-map supabase/functions/deno.json
```

The shared `supabase/functions/deno.json` import map must be passed explicitly;
without it, server-side bundling fails to resolve `zod` and the previous version
keeps serving. The command above is for the first deployment. For updates, name
only the functions whose source changed (for example `deploy api worker` with the
same flags), then compare the deployed source with the merged commit.

The initial project also has provider/Vault changes deployed outside the earlier
checkout. This source reconciles those changes with the administrator sandbox;
follow [backend pilot preparation](backend-pilot.md) and check `supabase migration list`
before updates. Do not reset the live database. JWT gateway verification is disabled intentionally: API
code verifies Auth.getUser and membership, worker checks a shared secret, and the
OAuth callback checks single-use expiring state and PKCE.

Trial with a free Google AI Studio key: set `GEMINI_TIER=free` together with that key and a model the
key lists as free. Free-tier use is an unpaid service under Google's Gemini API terms: Google may use
prompts, files and answers to improve its products and reviewers may read them. Every consent screen
and Settings › เชื่อมต่อ AI then says so, and the consent identity changes, so moving to a paid key asks
staff again. Use only non-confidential or synthetic material during such a trial. Free-tier rate limits
are low and change; a limit reached surfaces as `AI_RATE_LIMIT`. The in-app budget and rates still gate
work and estimate usage; they are not a Google invoice.

Set these **server-only Edge Function secrets** in the dashboard or via an ignored
local environment file. Never put them in `VITE_` or a committed SQL migration.

| Secret                           | Purpose                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `APP_ORIGIN`                     | Exact HTTPS frontend origin, no trailing slash                      |
| `AI_PROVIDER`                    | `gemini` (default) or the existing `openrouter_free` worker pilot   |
| `GEMINI_API_KEY`                 | Central paid-tier Gemini key owned by STeP                          |
| `GEMINI_MODEL`                   | Verified available model, default `gemini-3.8-flash`                |
| `GEMINI_EMBEDDING_MODEL`         | Available 768-dimensional model, default `gemini-embedding-2`       |
| `GEMINI_TIER`                    | `free` only while trialling a Google AI Studio free key (see below) |
| `OPENROUTER_API_KEY`             | Separate server-only OpenRouter trial key                           |
| `OPENROUTER_TRIAL_TENANT_ID`     | Exact tenant UUID authorized for the admin free trial               |
| `OPENROUTER_MODEL`               | Explicit `:free` model for the optional worker pilot                |
| `OPENROUTER_PROVIDER`            | Pinned upstream for the optional worker pilot                       |
| `WORKER_SECRET`                  | At least 32 random bytes, also stored in Vault                      |
| `CREDENTIAL_ENCRYPTION_KEY`      | Base64 of exactly 32 random bytes                                   |
| `GOOGLE_WORKSPACE_CLIENT_ID`     | Web OAuth client for Workspace                                      |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | Its server-side secret                                              |
| `GOOGLE_PICKER_API_KEY`          | Picker browser key restricted to actual origin/APIs                 |
| `GOOGLE_PROJECT_NUMBER`          | Google Cloud project number (Picker app ID), same OAuth project     |

Supabase provides URL, service-role and anon keys to functions automatically.
Operator scripts read local `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (or service
role key). Staff never enter these keys. No key from a chat transcript is bundled.

## Google

See [auth-setup.md](auth-setup.md) for the protected routes, exact login callback
for this project, and the real-account acceptance steps.

Create a Web OAuth client in the STeP-controlled Google Cloud project with redirect
`https://YOUR_PROJECT.supabase.co/auth/v1/callback`. Enable Google in Supabase Auth
and put that client ID/secret there. Set Auth Site URL to the real Pages origin;
allow its exact `/auth/callback` URL. Disable email/password and anonymous signup,
while retaining OAuth account creation for invited accounts. Uninvited identities
can exist in Auth but have no tenant/data access. Login uses openid/email/profile;
domain suffixes or editable profile metadata never assign membership.

Workspace permissions use a separate Web OAuth client with redirect
`https://YOUR_PROJECT.supabase.co/functions/v1/google-callback`. Enable Calendar,
Drive and Picker APIs, and authorize the actual Pages origin. Request Calendar
read-only and drive.file for selected files, not all Drive access.

For External consent, add pilot accounts in Testing, then follow Google's
production/verification requirements. Sensitive scopes can require verification;
Testing refresh grants may expire after 7 days. An organization's policy can
still block an External app. STeP manages its own accounts; do not assume CMU
administration is needed. Calendar reads use private conversations to avoid
sharing personal appointments through a team answer.

## Activation

```sh
npm run bootstrap -- --owner-email OWNER_GOOGLE_EMAIL --name STeP
npm run harness:export -- --source /authorized/STeP-AI-Harness
npm run harness:verify -- --source /authorized/STeP-AI-Harness --pack .exports/harness-pack.json
npm run harness:import -- --tenant TENANT_UUID --file .exports/harness-pack.json
```

The first-owner reservation and baseline import are already present in the initial
project. Verified Google sign-in claims ownership. AI budget remains zero. After
credentials work, set current input/output token rates and a bounded budget in
Settings → เชื่อมต่อ AI. Rates must cover generation and embeddings; reconcile
estimates against Google billing.

Create Vault entries `step_worker_url` (this project's worker URL) and
`step_worker_secret` (same value as the function's WORKER_SECRET) using Supabase
Vault. Minute cron dispatch is inert until these exist; API also wakes a worker
immediately. Never commit a real secret to a migration.

Before inviting staff, test actual Google login, first-owner assignment,
invitation, suspension, privacy, consent, Google pause/resume/expired grants and a
bounded paid Gemini call. Measure receipt accuracy with permitted labeled real
documents, including faint signatures, incorrect tax IDs and addresses. Check
Word output in installed Word/LibreOffice and complete a backup restore drill.
Synthetic tests do not certify live OAuth, provider billing or OCR accuracy.

## Optional administrator free trial

Apply all pending sandbox/shared-quota migrations and deploy the reconciled API,
worker, callback and frontend before enabling this channel. Set `OPENROUTER_API_KEY` and
`OPENROUTER_TRIAL_TENANT_ID` together as Supabase Edge Function secrets. Removing
either disables the trial. Never use `VITE_` for the key or place it in Git, a
migration, browser storage or frontend input. Replace any key previously pasted
into a chat before activation; this change does not install that transcript key.

An active tenant owner/admin opens การตั้งค่า → เชื่อมต่อ AI → ทดลอง OpenRouter Free,
loads the live model list and confirms each synthetic prompt before sending.
Members and admins of other tenants are denied server-side. Test with both
permitted and denied real accounts after deployment. The sandbox caps attempts at
5/minute for the selected tenant; both trial channels share 40/day UTC and 15/minute
across the account. OpenRouter can impose lower limits. A failed attempt still counts. Rate limiting never causes
automatic retries or upgrades, and a 402 never initiates a credit purchase.

Check the exact model and $0 cost in OpenRouter Activity during real-account
acceptance. Do not send confidential information to free providers. Pay-as-you-go
procurement and production AI activation remain separate organizational choices.
See the official [model catalog API](https://openrouter.ai/docs/api/api-reference/models/get-models),
[provider price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection#max-price)
and [account limits](https://openrouter.ai/docs/api/reference/limits).
