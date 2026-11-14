# Native quota broker core — unprivileged validation, NOT installed

Follow-up: [FD-based XFS adapter](native-quota-broker-xfs.md) now supplies a real
syscall implementation, disabled by default and not privileged-accepted. The
original implementation-status statements below describe the core-only increment.
The linked follow-up does not remove any production/launcher/anti-rollback gate.

## Delivered boundary

`native/quota-broker/core.c` is a Linux C11 library, not a root daemon, shell helper,
installer, or production quota backend. Built against existing GCC 15.2/libc/Linux
headers/pthreads with no downloaded dependencies. Rust/Cargo, pkg-config and the
SQLite/UUID development headers were not available; no packages were installed.
The test executable **refuses root**. No real ioctl, quotactl, mount operation,
XFS quota mutation, account change, Docker or sudo execution occurs in these tests.

Inspected source protocol `8f53906` and its `docs/workspace-disk-provisioning.md`,
and integration `c7ab8ce` (manager/storage/runner assembly). This dedicated branch
starts at `c7ab8ce`; neither source checkout was edited. This increment is intentionally
independent of the TypeScript protocol commit, not a claim that it is integrated.
The older shell-helper proposal still exists in this base: do not install or invoke
it. Its refusal/retirement in `8f53906` is a separate increment, not silently copied here.

Implemented at the approved storage request/allocation/provisioning seam:

- Exact 46-byte `ENSURE/1 <lowercase UUID>\n` input. No operation selection, owner,
  path, project ID, limit, JSON extras, NUL, trailing bytes or multi-request payload.
  Version 1 deliberately rejects noncanonical UUID spellings rather than normalizing.
- A copied, validated, immutable operator policy: exact root device/inode, mount UUID,
  nonzero establishment epoch, reserved range inside 100000–199999, fixed aligned
  byte/inode limits and at most 64 explicit peer-UID/workspace grants. There are
  **no production defaults**. The request cannot influence these values.
- Explicit bootstrap into an empty 0700 authority-owned state directory. Startup
  never creates/recreates a missing manifest or journal. Manifest pins the complete
  policy; changed epoch/root/limits/grants/range fails. Journal and manifest must be
  authority-owned 0600 regular single-link files; unsafe directory modes fail.
- A bounded append-only local journal, exclusive lifetime `flock`, in-process
  mutex, monotonically allocated permanent IDs and fsync **before** directory
  creation and possible quota writes. A failed/unknown append poisons the authority.
  Startup fsyncs before replay; torn/noncanonical/out-of-sequence records fail.
  Live size loss/unlinked journal fails even on a cached allocation retry. No
  delete, clear, recycling, automatic repair or quota-reduction operation exists.
- Broker-selected `p<project>` directories, created fresh 0700 beneath a retained
  root FD. Existing trees are never adopted, including empty ones. Persisted
  device/inode binding precedes the first adapter mutation. A reservation without
  a directory binding is permanently denied as `EOWNERDEAD`, never guessed/recreated.
- Real `openat2` with `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|
RESOLVE_NO_XDEV`, real FD-relative creation/fsync, `statx` mount-ID checking and
  retained directory FDs. There is no fallback to `open`/realpath/shell when these
  kernel facilities are unavailable. Same-device nested mounts are rejected by
  NO_XDEV as well; **mount rejection is implemented but not mounted/tested here**.
- Trusted synchronous adapter seam takes retained mount/directory FDs, broker ID
  and fixed limits. Fresh configuration requires blank project/inheritance/limits;
  then both hard limits, project identity and inheritance must independently match.
  UUID/enforcement must match before and after. Every retry observes again and
  never rewrites an incomplete/foreign configuration. No recursive project changes.
- Final named-directory identity mismatch is denied; mutations still target the
  originally retained FD, not a substituted path. The internal receipt includes
  the retained FD and device/inode, not just a string path. All failures return
  `directory_fd = -1`; successful trusted callers must close the returned FD.

## Revocation and launcher limits — do not overclaim

`qb_revoke` is an **operator-only internal API**, not a wire opcode. It writes an
irreversible durable deny under the **same mutex held across actual configure and
read-back**, not an asynchronous pre/post authorization check. A completed revoke
prevents every later ensure/mutation for that workspace, including after restart.
An already-running mutation may finish **before** revoke completes; the ordering is
serialized and tested. Failed revoke durability poisons the broker and returns error.
Every revoke, including an idempotent cached retry, checks journal/mount health under
that mutex before success. Detected live journal loss poisons later ensures and
revokes even if its expected size is restored. Healthy repeated revokes append no
new record. This is not an external rollback witness: an empty well-formed journal
can still lose the deny on restart, so a retry after detected live loss must never
acknowledge durable success.
Every production policy writer would have to route through this same authority;
editing an independent invitation database/file does not acquire this lock.

This does **not** stop existing workloads, revoke a returned FD, or fence a launch
performed after `qb_ensure` unlocks. A receipt is **not a launch token**. A future
protected launcher must retain the actual directory FD and atomically authorize,
bind that identity and spawn under the same revocation authority. Rechecking a
pathname/receipt around an async driver preparation would still have a race.
No launcher or runtime composition is added here. `createSyntheticAssembly` still
does not select `withDiskQuota`; `RuntimeManager.create` still creates metadata
through its existing ordinary writable storage path. No production refusal is removed.

The native journal is a self-contained bounded authority for this isolated core,
**not** a second allocator to stack behind `DiskQuotaLedger.reserve`. Before
integration choose exactly one protected authoritative allocation store and migrate
or bridge explicitly; never let SQLite and this journal independently assign IDs.
The native `p<project>` layout is not yet the manager's user/workspace folder layout.

## Reproduce without privilege

From this checkout, as the ordinary user, with `TMPDIR` set to the user's scratch:

```sh
make -C native/quota-broker clean all test analyze
make -C native/quota-broker sanitize
```

`all` produces `libstep-quota-core.a`; there is deliberately no install/service
or command-line ensure target. Generated binaries/objects are ignored. Tests use
only `TMPDIR/step-quota-core-*`, synthetic UUIDs, a synthetic ioctl model, real
unprivileged openat2/statx/fsync, and a link-time fsync-failure adapter. Successful
fixtures are removed. An assertion failure can retain its synthetic fixture for
inspection; it is not user data or a host quota allocation.

Validated tests cover strict framing, explicit bootstrap/missing/changed/unsafe
state, foreign UID denial, idempotent retry/restart, foreign-tree nonadoption,
symlink/rename/inode substitution, FD retention, mid-adapter substitution without
mutating the replacement, fake UUID/enforcement and both-limit/inheritance/project
mismatches, partial provisioning without repair, capacity without reuse, child
process interruption/restart, torn/live-truncated journals, failed reservation
fsync with **zero subsequent mutation**, competing process exclusion, ten concurrent
unique allocations, and revocation blocked behind the actual mutation then persisted.
The ten callers share synthetic fixture credentials; this is not ten real accounts,
end-user authentication, a launcher test or real quota enforcement.

## Exact prerequisites before any privileged acceptance

Nothing in the synthetic policy approves a host range, quota value, identity/access
mapping or production installation. Before implementation can safely advance to
installation, an operator must supply/approve:

1. Exact reserved project subrange after a complete exclusive XFS project census,
   exact mount UUID/root identity and an independently protected epoch/anti-rollback
   witness plus restore/reconciliation procedure. This journal alone cannot detect
   rollback to an older well-formed state or an entire replacement with the same
   epoch; a nonzero epoch field is **not** a solved external witness. No concurrently
   writable legacy ledger or administrator quota route can remain authoritative.
2. Fixed byte/inode policy, protected broker/launcher principals and workspace
   authorization mapping. Kernel UID is not a Google user: a shared gateway UID
   does not by itself distinguish its authenticated users. The supplied peer UID
   API is a trusted transport seam, not authentication. Define the authenticated
   delegation/revocation protocol before exposing it; deny empty/ambiguous mappings.
3. Broker-owned nonreplaceable root/state ancestors and a reviewed least-privilege
   metadata/files/index/backup access policy. 0700 staging here intentionally does
   **not** grant manager/runner writes. No chmod 0777, chown, ACL or existing-tree
   adoption policy has been invented. Define how broker-created roots replace the
   manager creation/publication path before allowing any writer.
4. A reviewed **real** native ioctl adapter. It must verify attached XFS mount UUID,
   current mount identity and project accounting **and enforcement** through kernel
   interfaces, not mount options; use FD-based project/inheritance and quota APIs,
   set only the committed exact allocation, reject foreign/nonblank state, never
   lower/remove live limits, and independently read back both hard limits. There
   is no real implementation/default in this commit: a null adapter is refused.
   The mocked adapter returning a UUID or `enforced=1` proves no kernel property.
5. Root-owned non-user-writable binary/dependencies, fixed sanitized startup and
   protected startup-FD acquisition, bounded authenticated Unix transport (kernel
   credentials, deadlines, framing/queue/connection bounds), operator-only revoke,
   and the protected FD-consuming launcher under the shared revocation fence.
   Audit/remove alternate launch/quota routes before production. Never execute this
   user-writable checkout as root. There is intentionally no installation command.
6. Durability validation on actual storage, bootstrap/crash/restore procedures and
   reconciliation of pending/tombstoned allocations. The version-1 journal uses
   local C ABI layout and is not a portable database/backup format. No online
   policy update/regrant/migration/repair is implemented. Bootstrap is exclusive;
   broken/partial bootstrap requires protected operator recovery, not deletion/retry.

Only after those implementations/review and separate host-change approval: create
one broker-owned disposable synthetic root through the final authenticated launcher;
prove byte exhaustion **while filesystem space remains free**, separate inode
exhaustion, observed errno/usage/both exact limits, descendant inheritance,
delete/recovery, concurrent unique projects, foreign UID/workspace/project denial,
workload attempts to reassign project IDs or clear inheritance (including descendants),
symlink/rename/same-device nested/bind-mount/mount-replacement denials, in-flight
revocation across mutation **and launch**, interrupted provision/restart/restore,
peer workspaces unchanged, and confirmed workload stop before narrow cleanup.
Never clear/reuse reservations or claim a mock as host acceptance.

## Verification and review

Final command results are recorded in `docs/progress.md`. Local manual standards
and spec review cover this isolated core; independent parent review is required
before integration. The focused subagent cannot launch independent reviewers.
No real disk/inode enforcement, root execution/installation, XFS mutation, Docker
escalation, live data/provider access, or completed ten-user Desktop parity is claimed.
