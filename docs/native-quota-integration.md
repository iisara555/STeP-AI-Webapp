# Single-authority native quota integration (nonprivileged only)

## Implemented boundary

Integration base: `1f0150e`. Native contract inspected read-only at `0681439`
(`native/quota-broker/core.h`, `core.c`). The separate native core/XFS worktrees are not modified
or assumed integrated. This is runnable manager/storage integration, **not a root RPC transport**.

`nativeQuotaBoundary(options, driver)` returns the paired `storage` and `driver` options for the
existing `RuntimeManager`. It accepts only `mode: 'synthetic-only'`; omitted/other modes refuse.
There is no production composition or environment opt-in. Existing production gateway refusal stays.

- Native `qb_ensure` alone owns permanent project allocation and `p<project>` root creation.
  The adapter never imports/constructs/reserves in `DiskQuotaLedger` or calls `DiskQuotaAuthority`.
  The old TS allocator remains an alternate protocol artifact, **not another native allocator**.
- Validate the original `ws_<32 lowercase hex>` identity, then map it bijectively to the native
  lowercase hyphenated UUID. No truncation, case folding, repair, random replacement or hashing.
  Send exactly the native 46-byte `ENSURE/1 <uuid>\n` frame. No owner, UID, paths, project IDs,
  quota limits, revoke or clear operation is a request field.
- `forOwner` is a trusted out-of-band owner-to-authenticated-peer binding, **not authorization
  supplied by a browser**. Native must still enforce its protected peer/workspace grants and
  serialized durable revocation. This callback does not replace native authorization.
- Require strict, exact evidence: request UUID, configured mount UUID and both fixed hard limits,
  native-selected project within the configured range, inheritance/enforcement true, canonical
  uint64 decimal device/inode. Reject unknown keys. Compare receipt device/inode against the
  named synthetic directory. No missing-project mkdir, adoption, reset, reuse or rollback.
- `users/<owner>/workspaces/<ws>/workspace.json` is control metadata only. Existing workspace-count
  SQLite policy and synchronous publication admission remain authoritative for metadata visibility.
  Native provisioning finishes **before** publication. Failed/revoked/over-count publication leaves
  native reservations intact; native must never recycle them. Native failure publishes nothing.
- Actual runtime content is `<projectRoot>/p<project>`, with `files/` and `snapshots/` inside it.
  TS creates those workload-content children only, never the native project root or protected parent.
  The control-metadata directory contains no runtime files, symlink or project/path alias.
  Start/resume freshly provision. Stopped conversation indexes read the same native content root.
- Storage and driver halves are paired through a one-use, immutable internal `RuntimeSpec` object.
  Arbitrary/copied/replayed specs fail. This marker is **not** authorization: the actual synchronous
  spawn still runs inside the existing admission callback, **after** async native preparation.
  Unfenced start and drivers without synchronous admission refuse. Handles/cleanup errors pass
  through unchanged; manager capacity, failed startup, stop and shutdown semantics remain intact.

The `WorkspaceStorage` seam defaults to the existing layout for every ordinary manager caller;
all manager metadata lookup/save/list operations use that seam. It is trusted composition, not a
request-selectable storage plugin. Supply the returned pair together and the same `dataRoot` to
the manager. Do not combine it with `withDiskQuota` or put either root inside the other.

## RPC seam is not an invented native wire response

`NativeQuotaRpc.ensure(frame): Promise<unknown>` is the application adapter seam. Its strict response:

```ts
{
  workspaceUuid, mountUuid, projectId,
  bytesHard, inodesHard,
  device, inode, // canonical decimal strings, never lossy JS numbers
  projectInherit: true, quotaEnforced: true,
}
```

The C `qb_receipt` actually contains a retained `directory_fd`, project, device/inode and both limits.
It does **not** contain UUID/mount/inheritance/enforcement fields. A future trusted transport must
bind the UUID to the exact framed request and mount/observations to protected broker policy and
successful native read-back, validate the retained FD, and close all received FDs on every outcome.
No decoder/socket/authentication/SCM_RIGHTS implementation is claimed or silently substituted here.
The fake RPC in the integration tests provides synthetic success/denial at this seam; it is not a
replacement C broker, an authorization-policy proof, or evidence of XFS enforcement.

## Precise next blockers: do not enable production

1. **Native receipt is not a launch capability.** Native explicitly requires a protected launcher
   to consume the retained FD under the same authority, rather than reopening a pathname. This
   adapter's `lstat`/pathname checks cannot prove mount identity or fence hostile concurrent swaps,
   and existing gateway admission does not serialize an independent native `qb_revoke`. The
   `synthetic-only` refusal must remain until protected FD handoff and mutation/launch/revocation
   coordination exist. A pre/post async authorization check is not a substitute.
2. **Protected access is not provisioned.** Native creates protected `0700` roots. A non-root manager
   cannot simply write there. The eventual trusted launcher/storage endpoint must prepare content
   and give the workload only the approved descriptor/bind access, without weakening parent
   ownership, chmodding roots broadly, or exposing caller-selected paths/UIDs. Our disposable
   fixtures are deliberately same-user directories and do not prove this access model.
3. **Workspace grant establishment is unresolved.** Native policy is a fixed protected list of
   peer/UUID grants (max 64); manager create generates a new workspace UUID. An unknown UUID
   must be denied, never implicitly granted by this adapter. Positive fake RPC results assume an
   operator-approved fixture identity. A protected pre-registration/onboarding contract is needed
   for real create; there is no client “authorize/register” extension in the ENSURE frame.
4. **Root transport/backend acceptance is separate.** Integrate/review the independently fixed
   native core/XFS backend, then implement bounded authenticated transport and exclusive launcher.
   Real mount/byte/inode exhaustion, descriptor substitution, native revocation and recovery tests
   still require separately approved privileged synthetic acceptance. No such tests ran here.

These are security blockers, not reasons to fall back to the TS allocator or the retired shell helper.
No host configuration, root/XFS operations, real data, permissions changes or push were performed.

## Verified in this integration worktree

Node `26.12.1`; pinned Harness `90ee71c` (`desktop-v0.6.20`), unchanged. Dependencies are local copies;
a node_modules symlink was rejected by the existing isolated runtime's mount boundary and replaced
with a worktree-local copy rather than weakening that boundary.

- New nonprivileged public manager/storage integration tests: **15 passed**. Covers strict identities/
  evidence, native-only allocation/root creation, failed create, child symlink denial, owner isolation,
  persisted metadata/content paths, restart/resume, create/start races, concurrent count admission,
  deferred native reply revocation/shutdown, paired spec rejection, exit during provider grant,
  retained failed cleanup handles/capacity and successful cleanup retry.
- Focused native + existing disk + production refusal suite: **27 passed**.
- Full application: **118 passed**. Database: **29 passed**. Ungated engine: **270 passed**, zero
  failures/skips. These suites do not count privileged runner/XFS acceptance.
- `npm run check` passed (existing 17 upstream engine diagnostics remain assigned to Desktop CI).
  `npm run check:engine-pin` and `npm run build` passed (existing large-chunk warning remains).
- TDD red was observed for the absent adapter and for the direct driver half accepting arbitrary
  paths; the paired one-use spec check fixes that reproduced bypass. Native's all-zero mount UUID
  rejection was also observed red before adding the matching client policy check. Other cases are regression
  coverage, not claimed as separately observed failing cycles.

Reproduce without privilege:

```sh
export PATH=/home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin:$PATH
node --import tsx --test server/test/workspace-native-quota.test.ts server/test/workspace-disk-*.test.ts server/test/gateway-entry.test.ts
npm run check
npm test
npm run test:db
npm run test:engine
```

Review: local standards/spec review against the requested single-authority gate, ADR 0001 and the
existing disk protocol; no independent subagent review capability is exposed to this delegate.
Parent must independently review/test before merging. This artifact is committed separately, not
installed or integrated into the main integration branch.
