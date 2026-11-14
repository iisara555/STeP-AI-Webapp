# Conversation history import (#63) — synthetic only

`server/src/workspace/history-import.ts` imports migrated conversations into the owner's Cloud Workspace.
It has only been run on synthetic data, from `spikes/063-migration-preview/synthetic_history.json` through
`import_batch.py`. **No real Supabase data, export or credential has been read or used.** Production data
stays in Supabase.

## Why a server-side seam, not an engine change

The pinned Desktop engine (`harness` @ `90ee71ca`) has no import contract. `Store.create()` makes its own
UUID, `Store.save()` sets `updatedAt` to now, messages have no ids, and the runtime's public
`newConversation`/`ask` only add new turns. `runtime-main.ts` `messages` also hides `status` entries. The
pinned harness is not modified. The importer instead writes the engine's own record format using the pinned
engine's public `Store.put()` and `Store.transaction()`: `put` does not touch `updatedAt`, and it maintains
the engine's FTS search row. A test checks that the imported session has the same set of keys as a session
the pinned engine creates itself. The earlier proof branch
(`step-history-import-proof`, ending at 8f3e6a1) patched the engine store, kept a plaintext snapshot and had
no owner binding. None of that code is reused here.

## Contract

`importHistory({ dataRoot, owner: Identity, workspaceId, mappings, conversations, digestKey })`

- **Input** `HistoryImportV1` (strict, unknown fields rejected): `schemaVersion: 1`, `source: 'supabase'`,
  `sourceConversationId` and `sourceOwnerId` (UUIDs), `title`, `createdAt`, `updatedAt` (ISO with ms),
  and ordered `messages[]`. Each message is `{sourceMessageId, role: user|assistant|status, text, at,
attachments[]}`. Each attachment is a metadata reference only: `{sourceAttachmentId, name, mediaType,
byteLength, sha256}`. Duplicate message ids, duplicate attachment ids, sparse arrays, bad timestamps and
  `createdAt > updatedAt` are each reported as `invalid`, without echoing any value.
- **Owner binding:** the target owner is `owner.userId`, which comes from the gateway Authenticator. It is
  checked with `credentialStillValid`. The Workspace is resolved with `readRecord`, so a foreign workspace id
  gives `WORKSPACE_NOT_FOUND`. A conversation is imported only when its `sourceOwnerId` maps to that same
  user through an administrator-approved one-to-one mapping (decision §1). The input has no target-owner
  field.
- **Exactly once:** the ledger key is `sha256(owner, source, sourceConversationId)`, and the engine session id
  is a v8 UUID derived from that key. Possible dispositions per conversation:
  - `imported`
  - `unchanged`: identical re-run, nothing is written
  - `conflict`: same source id with different content, including reordered messages; nothing is written,
    never an overwrite
  - `refused_owner`
  - `imported_elsewhere`: already in another Workspace of the same owner
  - `invalid`
- **Atomicity:** for each conversation, the session row, its FTS row and its ledger row are written in one
  `BEGIN IMMEDIATE` transaction. A SIGKILL inside the transaction leaves nothing. A re-run then imports the
  missing conversation and reports the committed ones as `unchanged`. `conversations.json` is rewritten
  afterwards by temp file and rename. The runtime also rewrites it on start.
- **Exclusivity:** the importer holds the storage root's writer fence (#62). It therefore refuses
  (`WORKSPACE_WRITER_FENCE_HELD`) while any Runtime Manager is alive, and so while any runtime could be
  writing the same `workspace.sqlite`. Import is an offline, pre-cutover operation.
- **Where data lives:** the engine fields hold the title, `updatedAt`, and the ordered messages with role
  (status included), text, `at` and attachment names as `files[{name}]`. The ledger row (`kind =
history-import`) sits in the same `workspace.sqlite`. It holds `createdAt`, the stable message ids, the
  attachment metadata, the source id and the content sha256. It holds no text. The only other file written
  is the empty writer-fence file at the root. Engine files are chmod 0600 inside the 0700 workspace folder.
- **Report:** `{schemaVersion, conversations: [{position, disposition, ref, messages, statuses,
attachments, digest}], counts}`. `ref` and `digest` are HMAC-SHA256 values under the operator's migration
  key (at least 32 bytes, never stored), so the report contains no text, titles or source ids. For #65:
  `sourceDigest(conversation, key)` computes the expected entry from the source side alone.
  `verifyHistoryImport(...)` re-derives each imported or unchanged entry read-only from the Workspace (engine
  session plus ledger) and reports `match`, `mismatch` (drift or tampering) or `missing`. It is owner-bound
  in the same way as the import.

## Synthetic input

`spikes/063-migration-preview/import_batch.py` runs `propose_mappings`, simulates the administrator's
approval, then runs `approved_mappings` and `adapt`. It emits only `candidate_only` private sessions as
`HistoryImportV1`. Every other row is counted in `held_back`: shared rows are deferred, memories are not
conversations, documents are unsupported, and rows that are unmapped or missing content are blocked.
Identities are bridged by convention: `user-N` maps to the Supabase UUID with integer N, and an approved
`sub-M` maps to gateway user id `gM`.

## Remaining

- Documents and attachments importer. Only metadata references are carried today; there are no bytes, no
  `document-asset` records and no draft or version history.
- Memories importer.
- A real-data dry run, after owner approval, against a protected export. It needs a real export reader that
  produces `HistoryImportV1`, a key-handling procedure, and preview and report review by an administrator.
- The CLI or gateway entry point that obtains the authenticated owner `Identity` and runs the batch. Today
  this is library code and tests only.
- Composition with non-default storage. The native `p<project>` runtime roots resolved through
  `WorkspaceStorage.runtimePaths` are not supported: the importer uses the default layout under `dataRoot`.
- The runtime's `messages` method still hides `status` entries. They survive in the store and in digests,
  but are not shown through the public API.
- The final source-side role, status and attachment shape must be confirmed against the real Supabase schema.
  `role: status` here is the engine's own role.
