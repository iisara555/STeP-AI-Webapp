# Workspace disk + inode provisioning: integration protocol, NOT installed

## Outcome and boundary

This change advances the disk/inode gate with code under `server/src/workspace/`, not another executable spike:

- `validateDiskQuotaRequest`: strict `{workspaceId}` only. No owner, path, mount, project ID, quota value, operation or clear request is accepted.
- `initializeDiskQuotaLedger` / `DiskQuotaLedger`: explicit one-time authority bootstrap and SQLite `BEGIN IMMEDIATE` allocation, permanent unique IDs in an explicitly reserved subrange of 100000–199999, pinned mount UUID/range, fixed per-workspace disk/inode policy, idempotent retry. Startup never creates/recreates a missing ledger. Reservation commits **before** a privileged adapter could run. Failed/unknown provisioning never frees an ID. No reset/delete/reuse API exists.
- `DiskQuotaAuthority.ensure`: authenticated subject is supplied out of band by the trusted broker transport, not parsed from request data. Protected broker policy resolves owner and both limits and authorizes the workspace. Reserve, provision/read-back, strictly validate the matching tuple plus enforced quotas/inheritance, then reauthorize before returning. Every attempt re-observes; there is no persisted `ready=true` shortcut. Changed policy and incomplete/foreign evidence fail closed.
- `withDiskQuota`: explicit driver composition for the existing `RuntimeManager`. Refuses unsafe spec paths, missing/malformed/foreign/weaker evidence and broker errors before any driver launch. Snapshots paths/configuration across async waits. Start and resume both provision afresh. Leaves the underlying driver's **actual synchronous spawn** in the existing admission fence; never invents admission support for a driver without it.
- The old shell helper now unconditionally refuses all operations; its sudoers proposal grants nothing. Old validation-only results are withdrawn as security acceptance.

**Not implemented/installed:** privileged native backend, protected broker process/transport/policy store, root-owned installation, production composition or real quota acceptance. The protocol's injected adapters in tests are synthetic evidence, not kernel observations. `withDiskQuota` is an opt-in integration boundary, not protection against a compromised manager calling another driver. Ordinary startup remains unchanged and the production gateway remains refused.

`server/src/workspace/provision-quota.ts` / `npm run workspace:quota:init` controls **workspace count**, not disk bytes or inodes; it is deliberately not repurposed and does not bootstrap this separate privileged authority.

Inspected integration base `3c5a2db` and reviewed assembly `62af7bb`, especially `docs/runtime-runner-assembly.md` release gates 1–4. This artifact targets that assembly's driver/provisioning seam without cherry-picking or editing the assembly checkout. It does not certify the final authenticated runner path.

## Concrete protocol and state transitions

```text
trusted transport peer -> protected policy(subject, workspaceId) -> owner + fixed limits
  -> BEGIN IMMEDIATE -> existing exact allocation OR next never-reused ID -> COMMIT
  -> native provisionAndVerify(allocation)
  -> independent exact read-back of UUID/project/both limits/inherit/enforcement
  -> protected policy recheck -> receipt -> driver admission fence -> real spawn
```

`DiskQuotaAllocation` includes owner ID, workspace ID, broker-selected project ID, pinned mount UUID, byte hard limit (4096-byte aligned, 4096..1099511627776) and inode hard limit (1..10000000). The adapter accepts this immutable allocation, **not a client path**. No arbitrary shell commands are part of the protocol. A receipt is not an authorization capability or a reusable launch token.

The ledger is authoritative only when an independently protected broker exclusively owns its DB/WAL/SHM and all writers use the same ledger. Supplying an operator-writable DB to this library does not create a root authority. A public `reserve` call is an internal broker seam; it is never exposed on the request socket. Loss/corruption of established state must stop service, not invoke the explicit initializer. Bootstrap needs an external protected establishment/epoch witness and operator recovery policy before host deployment; this library cannot detect replacement with an entirely new empty database. Range tombstones must survive backup/restore; never restore older allocation state while newer IDs may still exist on disk. `FULL` synchronous SQLite commits must be verified on the actual local storage stack. A COMMIT error means unknown reservation outcome; do not perform a kernel write on that attempt.

Minimal composition shape (trusted seams, not an installation command):

```ts
const guardedDriver = withDiskQuota(actualDriver, {
  dataRoot: fixedDataRoot,
  mountUuid: fixedMountUuid,
  bytesHard: approvedByteLimit,
  inodesHard: approvedInodeLimit,
  provision: authenticatedBrokerClient.ensure,
});
// Supply guardedDriver to the existing RuntimeManager / explicit assembly composition.
```

The client must be a bounded authenticated transport. It must not read a `ready` file or invoke the retired helper. The broker's peer-to-subject binding and workspace authorization are mandatory: a syntactically valid subject string is not authentication. Broker auth cannot be delegated to a user-writable callback in a production process. Keep the existing RuntimeManager admission/revocation fence; reauthorization after provisioning does not undo already-applied limits and is not a replacement for an atomic authority around privileged mutation/launch. Native broker policy must fence those operations against revocation too.

## Exact minimal host prerequisites for the next gate

Read-only discovery on this task's host showed `/mnt/step-work` mounted from `/dev/nvme0n1p1`, XFS UUID `6b52590c-aed0-4f2e-bcb1-204a09a49304`, options including `rw,prjquota`. This is **not** proof of project enforcement, ownership, unused project IDs, or live byte/inode limits. No `xfs_quota` commands, quota writes, account/sudoers changes, Docker escalation or root installation were performed.

Before any privileged synthetic acceptance, an administrator must approve and provision all of:

1. **Independent protected broker/launcher.** Root-owned executable and dependencies in a non-user-writable path, fixed sanitized environment, fixed mount/root policy; separate manager/workload principals; Unix socket in a protected directory with restrictive permissions, kernel peer credentials, bounded framing/deadlines/connections, and protected subject/workspace/limit policy. No general sudo/bwrap or alternate quota/launch route may bypass this boundary. Do not execute a checkout's user-writable script as root. An installation command is intentionally not provided because there is no reviewed native backend binary yet.
2. **Exact mount and exclusive range.** Verify mounted XFS UUID/device, mount identity and enforcement using trusted kernel interfaces. Exclusively reserve an operator-approved subset of 100000–199999 only after a complete project census and reconciliation with existing administration. An absent/empty quota report is not proof of non-use. Coordinate concurrent root administration and stop on mount replacement/unmount, read-only/remount or unknown enforcement.
3. **Protected hierarchy and descriptor-based operations.** Broker owns the workspace parent hierarchy; neither manager nor runner can rename/replace roots/ancestors. Open beneath a pinned mount/root FD using `openat2` with `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV`, rejecting nested/bind mounts even on the same device. Retain the actual directory FDs and verify mount ID/UUID and persisted workspace inode identity. Use FD-based XFS project/inheritance ioctls and quota APIs, not path-check-then-`xfs_quota`. Persist directory identity in protected broker state before release, serialize concurrent ensures per allocation, fail on substitutions and reconcile unknown outcomes without clearing another project. Recursion over existing mutable trees is not safe; initially support broker-created fresh empty synthetic roots only, or require a separately verified writer fence and full tree/project census. Do not silently adopt existing user-writable trees.
4. **Protected durable allocation state and recovery.** Initialize the ledger only during explicit exclusive bootstrap after range census; pin UUID/range, protect DB and sidecars/parent, add establishment/epoch identity, verified durability, non-reusable tombstones and fail-closed restore/restart reconciliation. No online `clear`, quota reduction, project recycling or auto-repair in this protocol. The native adapter must never choose a different ID from the committed allocation.
5. **Verified directory creation/access before any writes.** Broker creates/configures the workspace and project inheritance before releasing writer access. Set and independently read back byte **and inode** hard limits plus project ID/enforcement before launching. Workload may write contents, not reassign projects or mutate protected parents; launcher binds the retained directory identity, not a caller-replaceable pathname. Broker must coordinate quota observation with launch and never reduce/remove a live allocation. Existing `RuntimeManager.create` still stages metadata under its ordinary nonprivileged parent: this artifact does **not** convert that creation path into broker-owned creation or quota-limit prelaunch metadata. Production must replace that provisioning/publication boundary, not chmod the current tree and declare it safe. Manager/runner stopped-index/backup access needs an explicit least-privilege policy, not 0777 fixtures.

**Precise blocker:** a checked shell pathname plus caller-selected ID cannot provide these invariants on the current writable hierarchy. This repository has no reviewed descriptor-based XFS backend, independently protected allocation/identity broker, authenticated broker transport, or broker-owned creation/publication path. Implementing the protocol and testing its seams without privilege cannot prove those host properties. Root approval alone, installing the disabled helper, or running it through Docker does not solve the architecture gap.

## Acceptance still required on the actual deployed path

After the prerequisites are implemented/reviewed and host changes explicitly approved, use only a broker-created disposable synthetic workspace. Through the final authenticated assembled runner path, prove: bounded disk exhaustion while the filesystem itself retains free space; bounded inode exhaustion separately; observed errno/usage and exact project limits; deletion/recovery of writes and file creation; inherited project identity for descendants; concurrent project allocation uniqueness; foreign subject/path/project and symlink/rename/nested-mount denials; interrupted provisioning/restart reconciliation; unchanged peer workspaces; confirmed runtime stop before cleanup. Retain reservations and deny launch on every unknown result. Verify cleanup of only known synthetic data without clearing/reusing another allocation. Nothing in this commit is acceptance of these kernel tests.

## Reproduce nonprivileged tests/checks

Use Node 26.12.1, existing local dependencies and the unchanged Harness pin:

```sh
export PATH=/home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin:$PATH
node --import tsx --test server/test/workspace-disk-*.test.ts
bash spikes/057-workspace-quota/test-validation.sh
npm run check
npm test
npm run test:db
npm run test:engine
```

Approved seams: storage request/allocation/provisioning and existing runtime driver/real RuntimeManager admission. Tests create only disposable local synthetic SQLite/filesystem fixtures; no root check is removed, no XFS command is mocked by rewriting a privileged script, and no installed host helper is invoked. Separate-process SQLite tests exercise concurrent allocation and restart, not host quota mutations. The manager test verifies failed provisioning prevents starts/resumes; fake driver evidence must never be reported as real XFS enforcement.

## Verified on this dedicated worktree

Base `3c5a2db`, branch `work/quota-provision-authority`, Node 26.12.1, Harness unchanged at `90ee71c`:

- Targeted storage/runtime tests **10 passed**; retired-helper shell refusal checks **4 passed**.
- Application **118 passed**, database **29 passed**, ungated engine **227 passed**, zero failures/skips in those suites. No privileged runner/exhaustion test was enabled or credited.
- `npm run check`, `npm run build`, `npm run check:engine-pin`, `git diff --check` passed. Existing 17 upstream engine diagnostics remain delegated to Desktop CI; build retains its chunk-size warning.
- Relevant `cloud-workspace.spec.ts` Playwright: **2 desktop passed, 2 existing mobile skips**. Initial browser launch failed for missing `libatk-1.0.so.0`; retry used the already-present user-local `playwright-libs` directory on `LD_LIBRARY_PATH`, with no installation. A temporary focused config retained only the existing Cloud Gateway/Cloud UI web servers (8799/5175), disabled server reuse and kept the existing tests unchanged; unrelated 5173 was already occupied and not touched. Both temporary servers were absent afterward. This is a scripted UI fixture, not the real runner or a quota enforcement test.
- TDD failures were observed for the absent validator/ledger/authority/driver exports, for caller mutation changing the launched directory to `/etc`, and for the old helper not being disabled. All now pass.
- Local standards/spec review: no engine/production-entry changes, no live/private data, no privilege path. The root broker, authenticated transport, exclusive launcher and creation/publication gaps above remain blockers, not test passes. This focused subagent cannot launch independent reviewers; parent review is required before integration. Other worktrees were read only; do not infer their current revisions from the pinned inspection bases if concurrent work advances them.
