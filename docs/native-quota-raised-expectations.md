# Raised-user quota expectations (bounded gateway integration)

Status: **unprivileged/synthetic verification only; production remains refused.**
This closes the application-side default-only comparison gate with an optional,
protected operator expectations source. It does not export or modify the native
journal, native core, native transport, or launcher. It installs nothing.

## Exact trust boundary

`brokerQuotaBoundary()` optionally takes `expectations`, created exclusively by
`brokerQuotaExpectations()`. The boundary rejects structurally copied or invented
sources. This is an application composition boundary, not a defence against code
execution inside the gateway process.

- **Authority:** a separate operator-authored expectations JSON file and the
  existing native service v2 policy. Neither receipts, browser requests, gateway
  users, nor usage observations can create or increase expectations. There is no
  socket mutation or expectations writer in this change.
- `mode: 'protected'` anchors descriptor-relative traversal at `/`, requires uid 0
  on every ancestor and both files, forbids group/other-writable ancestors,
  follows no symlinks, and rejects nonregular, multiply linked, oversized or
  incorrectly permissioned files. Files must be exactly 0600 or 0644. Configured
  paths are relative to `/`, with no empty, `.` or `..` components.
- `mode: 'synthetic-only'` instead anchors at an explicit disposable `trustRoot`
  owned by the current uid. This is solely the unprivileged test seam, not an
  alternative production trust root. Production composition is still absent.
- The reader validates the full strict document on **every** lookup: installation
  epoch, mount UUID and broker root device/inode must match the independently
  parsed protected service policy. Users and project IDs must be unique, limits
  bounded and aligned, projects within range, and neither hard limit below its
  policy default. Unknown users refuse; they never fall back to defaults.
- The boundary additionally matches the source's defaults, range and relevant
  identities to its configured policy and the actual broker root directory.
  WORKSPACE receipts must match the exact user, workspace, mount, project and
  **both exact per-user hard limits**. USAGE must match the same exact project
  and limits. Existing ownership, directory identity and pinned-launch checks
  remain in place. No `receipt >= default` admission exists.
- Both files are reread after each asynchronous broker operation (and path
  verification). A changed content revision denies the in-flight claim. Nothing
  caches per-user limits between calls. Old expectations vs new broker limits,
  or new expectations vs old broker limits, deny rather than silently adopting
  either side.
- Without a source, the existing exact-default behaviour remains. The legacy
  synthetic `NativeQuotaRpc.ensure()` boundary deliberately remains default-only;
  it is not a source of durable per-user authority.

## Operator metadata format and lifecycle

Example shape only; all installation and user identifiers must come from the
operator's verified deployment and durable grant records:

```json
{
  "version": 1,
  "epoch": "00112233445566778899aabbccddeeff",
  "mountUuid": "6b52590c-aed0-4f2e-bcb1-204a09a49304",
  "rootDevice": "1",
  "rootInode": "2",
  "users": [
    {
      "userUuid": "a11ce000-0000-4000-8000-000000000001",
      "projectId": 100000,
      "bytesHard": 32212254720,
      "inodesHard": 1000000
    }
  ]
}
```

The reader is deliberately read-only. The owner must separately review/install
and publish this root-owned metadata from successful, independently verified
native grants/raises. Do not publish an interrupted or unapplied raise, derive
metadata from untrusted receipt contents, or make the file gateway-writable.
Include every mapped user when enabling the source, including default-limit
users. Update by protected atomic replacement under offline maintenance; changes
during operations can conservatively refuse unrelated users because the revision
covers the whole document. Existing installer/policy v2 format is unchanged.

This metadata is a second operator assertion, **not an automatic journal export**.
A stale snapshot cannot authorize different live broker limits. It does not
solve coordinated rollback of the policy, metadata and native journal, or detect
an operator changing and restoring identical content between reads. The existing
anti-rollback witness gate remains open. Nor is async TS rereading a synchronous
revocation-through-spawn fence: native protected launch/revocation remains a
separate required gate.

## Evidence and remaining host gate

`server/test/workspace-quota-expectations.test.ts` exercises the protected-reader
and broker storage/usage seams with disposable current-user fixtures. It accepts
an explicitly approved raised user, rejects an unapproved elevated receipt,
unknown users, stale in-flight/next-call claims, lowered or inconsistent limits,
wrong identities/projects, malformed metadata, unsafe permissions, symlinks and
hardlinks. The production reader refuses these current-user scratch paths.
Existing real Unix socket/fake-native-broker and legacy boundary tests also pass.
Verification at this increment:

- `npm run check`: pass (the existing 17 upstream engine diagnostics remain
  delegated to Desktop CI).
- `npm test`: 118 passed; `npm run test:db`: 29 passed.
- `npm run test:engine`: 332 passed, no failures or skips.
- `npm run check:engine-pin`: recorded harness pin `90ee71c` unchanged.
- Regression sensitivity: temporarily replacing exact receipt byte-limit equality
  with a lower-bound check makes two new tests fail with missing rejections.
  Exact equality was restored before final verification.

These are **not** real XFS, installed root-service, or production-launch results.

Remaining gates: owner-reviewed metadata provisioning plus real root-owned reader
and raised-user service/XFS acceptance; protected launcher, authenticated native
transport and revocation-through-spawn acceptance; production composition and
explicit owner approval. `refuseUnsafeGateway()` stays unconditional. No root,
sudo, host configuration, real data mutation, or push was performed.
