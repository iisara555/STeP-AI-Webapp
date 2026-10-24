# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Installable PWA (`display: standalone`, `lang: th`), used on desktop and mobile
browsers. Not a native app; the separate Electron Desktop Harness lives in
`iisara555/STeP-AI-Harness` and is out of scope for this web product.

## Users

Staff across all STeP teams (administration, programmes, communications,
finance and others), invited by Google account into the organization tenant.
No single team dominates: each uses the Skills and team starters that fit its
work. The pilot is capped at 20 invited staff.

Typical jobs: drafting Thai official documents (TOR, บันทึกข้อความ,
หนังสือราชการ, project proposals, meeting reports), asking AI questions grounded
in selected documents, memory and organization knowledge, checking receipts,
preparing internal-media briefs and Prompts, and finding earlier work.

Secondary audience: organization owners/admins, who manage members, invitations,
budget and AI connection settings, and who never gain access to members' private
contents by that role.

## Product Purpose

STeP AI is the organization's own AI workspace. It lets staff do real document
and knowledge work with AI while the organization keeps control of which model
runs, what it costs, what context it sees, and which instructions carry
authority. Success means staff finish drafts and checks faster with AI output
they can trace and verify, without private data leaking across people,
workspaces or tenants.

## Positioning

Two things a direct ChatGPT/Gemini subscription cannot truthfully offer:

1. **Org-governed AI.** AI runs only on the server through an organization-managed
   provider (Gemini on the paid path), behind per-request consent that shows the
   selected documents and memory first, a tenant budget, idempotent jobs that never
   replay provider calls automatically, and no external writes without explicit
   approval.
2. **Harness Skills with source provenance.** Versioned STeP Skills and organization
   knowledge imported from the Harness pack, with source references, visible gaps
   when a source is unavailable, and the rule that source text, memory and uploaded
   documents never grant authority.

## Operating Context

- Sign-in with an invited Google account; tenant membership is rechecked on every
  operation.
- Private workspace by default; creators can invite same-tenant members as editors
  or viewers. Conversation visibility (private/workspace) is fixed at creation.
- Files: PDF, images, Word, Excel, PowerPoint and Google Drive files the user
  explicitly picks. Text extraction runs in the browser; OCR is explicit, billed work.
- Google Workspace is a separate grant from login: Calendar read-only and
  `drive.file` for selected files. Nothing sends email or modifies Google resources.
- Drafts are version-checked before saving and export to Word (.docx, Thai
  สารบรรณ/report/letter A4 presets with page numbers) or text.
- Receipt review returns type, completeness and next steps, including signature
  marks and STeP buyer details; findings stay unverified until a person compares
  the original and saves the review.
- Keyboard: command search Ctrl/⌘+K, new conversation Ctrl/⌘+Alt+N, Ctrl/⌘+Shift+M,
  settings Ctrl/⌘+,. Collapsible desktop rail.
- A synthetic demo ("ดูตัวอย่างหน้าจอ") runs without Google, Gemini or a database.

## Capabilities and Constraints

- Thai first. Keep familiar names in English: Skill, token, AI, Google Workspace,
  Prompt.
- Every data access enforces tenant membership and resource ownership. Personal
  memory, documents, conversations and receipt reviews are owner-only; an
  administrator does not automatically see private data.
- Workspace conversations cannot use private memory or another workspace's files.
- The service worker caches public app assets only; documents, memory and
  conversations are not available offline.
- Limits: 10 MiB/file, 30 PDF pages, 200k extracted characters, 32k AI input
  tokens, 800 MB/tenant and 25 MB/member storage, 20 pilot staff. These are
  application limits, not promises of capacity or OCR accuracy.
- Paid AI stays disabled until server credentials, rates and a positive tenant
  budget exist. Usage figures are estimates, not provider invoices.
- Administrators have a separate, synthetic-input-only OpenRouter free-model trial
  in Settings → เชื่อมต่อ AI; it never enables paid chat, embeddings or OCR.
- Not on the web yet (Desktop or later work): native/CLI tools, writes back to
  Google, image generation through an API, personal Skill packs, rich-text editing
  equivalent to Desktop. The in-app 32-group Desktop reference shows supported,
  partial and Desktop-only status for each capability.

## Brand Commitments

- Name: **STeP AI** (lowercase "e"). Page title pattern `STeP AI · พื้นที่ทำงาน`.
- CI colours **#FFC709** and **#231F20**, and the original STeP symbol artwork
  (`public/step-symbol-colour.svg`, `public/step-symbol-mono-white.svg`, app icons).
- Voice: Thai first, plain and factual. Status copy is honest: never imply that an
  unbuilt, unconfigured or unverified capability works, and label AI/OCR findings as
  unverified until a person checks them. Never present OCR as reimbursement approval
  or signature authentication.

## Evidence on Hand

- Product docs: `README.md`, `docs/architecture.md`, `docs/desktop-reference.md`,
  `docs/progress.md` (verified state and outstanding acceptance).
- Brand assets: STeP symbol SVGs and icons in `web/public/`.
- Synthetic demo data only (`web/src/demo.ts`). The repository is public-safe: no
  organization documents, employee data, real receipts, credentials or exports.
- No testimonials, usage metrics, case studies or real staff content exist for use
  in UI or marketing; do not fabricate them.

## Product Principles

1. **Consent before context.** Show exactly what the AI will read, and ask, before
   any provider call. Never retry billed work silently.
2. **Provenance over fluency.** Answers, Skills and knowledge show where they came
   from and what is missing; a visible gap beats a confident guess.
3. **Private unless shared on purpose.** Ownership and tenant boundaries hold for
   everyone, administrators included.
4. **Honest capability.** The UI states what works now, what is partial and what
   still needs Desktop; nothing is mocked as working.
5. **A person signs off.** AI drafts and OCR findings are inputs to a human
   decision, never the decision.

## Accessibility & Inclusion

WCAG 2.1 AA in both light and dark themes (system/light/dark selectable, applied
before first paint), verified on desktop and mobile layouts. Thai typography
(IBM Plex Sans Thai) must stay legible at all sizes, including tone marks and
vowels above/below the line.
