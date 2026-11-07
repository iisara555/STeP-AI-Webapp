# FD-based XFS quota adapter — implemented, disabled, NOT accepted

## Status and scope

`native/quota-broker/xfs.c` implements the native Linux adapter to `core.h`.
It is a library only, with no CLI, service, installer, socket, root invocation or
production selection. Built in isolated worktree
`/home/itsara/projects/step-native-quota-broker-xfs`, branch
`feat/xfs-backend-0681439`, from `0681439`. The cached-revoke fix
`448bb00cbed80af8ed2a3ba49fc41693204569a6` was cherry-picked as `4a9762a`.
The original and reviewer worktrees were not edited.

**Default `qb_xfs_open` returns `-1/ENOTSUP`, clears both outputs and performs no
quota/ioctl calls.** The real constructor is compiled in only when
`QB_XFS_PRIVILEGED_ACCEPTANCE=1` is explicitly supplied at compile time. There is
no runtime flag, environment variable or request bypass. This opt-in is a future
acceptance-build mechanism, NOT evidence of completed privileged acceptance or
permission to install this user-writable checkout. The acceptance-enabled source
was compiled/analyzed, never executed. `QB_XFS_TESTING` exposes a fake syscall
constructor only in the test build; its symbol is absent from the normal archive.

## Kernel ABI evidence

Authoritative definitions read from installed Linux UAPI headers, not locally
invented ioctl structures or copied numeric constants:

- `/usr/include/linux/fs.h:91–94`: `struct fsuuid2` has one-byte `len` and
  16 UUID bytes. `FS_IOC_GETFSUUID` is defined at line 328. A result must have
  length exactly 16 and match protected policy; unsupported ioctl is fatal.
- `linux/fs.h:204–213,236–253,323–324`: `struct fsxattr`,
  `FS_IOC_FSGETXATTR`, `FS_IOC_FSSETXATTR`, `FS_XFLAG_PROJINHERIT`.
  `fsx_projid` is a 32-bit project ID; inheritance is an xflag, not an xattr name.
  Extent-size/CoW hints and unrelated flags are preserved; get-only nextents and
  padding are zeroed on set. Realtime/RT-inherit flags are refused.
- `/usr/include/linux/dqblk_xfs.h:45–81`: `fs_disk_quota` version 1,
  **512-byte basic blocks**, not filesystem blocks or 1 KiB quota blocks.
  The synthetic 4,194,304-byte policy becomes exactly 8,192 basic blocks.
- `dqblk_xfs.h:35–43,84–93,135–146,179–226`: XFS `Q_XGETQUOTA`,
  `Q_XSETQLIM`, versioned `Q_XGETQSTATV`; the set fieldmask is **only**
  `FS_DQ_BHARD|FS_DQ_IHARD`. Both `FS_QUOTA_PDQ_ACCT` and
  `FS_QUOTA_PDQ_ENFD` are mandatory, independent of mount option strings.
  The quota record must independently identify `FS_PROJ_QUOTA` and the requested
  project. No quota-on/off/remove command is present.
- `/usr/include/linux/quota.h:43,61–63`: `PRJQUOTA=2` and `QCMD` encoding.
- `/usr/include/x86_64-linux-gnu/asm/unistd_64.h:360` and
  `bits/syscall.h:1802–1803`: `SYS_quotactl_fd`; syscall arguments are retained
  mount FD, encoded command, project ID and quota/status buffer. No legacy
  `quotactl(path)` or `/proc/self/fd/...` target-path fallback exists.

An ordinary-user compiled ABI probe on x86-64/GCC 15.2 returned:

```text
fsxattr=28 fsuuid2=17 fs_disk_quota=112 fs_quota_statv=160
FSGETXATTR=0x801c581f FSSETXATTR=0x401c5820 GETFSUUID=0x80111500 quotactl_fd=443
project commands: getstatv=0x580802 getquota=0x580302 setqlim=0x580402 hardmask=0xa projflags=0x2 enforcement=0x30
```

These values document this host ABI; implementation uses header definitions and
`sizeof`, not these literals. Kernel reported `7.0.0-30-generic`. Merely having a
header definition or compiling the syscall is NOT proof that the running XFS
implementation supports it, that seccomp allows it, or that quota enforcement
works. Missing/denied/unknown APIs fail closed with no alternate route.

## Identity and mutation rules

Operator-only construction copies fixed policy and duplicates the startup root
FD with `F_DUPFD_CLOEXEC`. Every operation compares retained root and supplied
broker root against original device, inode and `statx` mount ID. Directories must
be linked directories on that same mount, not merely the same device. The mount
ID must still occur in `/proc/self/mountinfo` in the current namespace: a retained
FD/statx alone is insufficient to recognize lazy detachment. Failure to read this
mandatory proc evidence is fatal. `fstatfs` must identify writable XFS; UUID and
project accounting/enforcement are independently checked before/after operations.

Quota syscalls always use the adapter's own retained root FD. Attribute ioctls
always use the exact directory FD supplied by the core, never a reopened name.
A renamed/replaced name cannot redirect the adapter's mutation. The core's final
name/identity check separately rejects a substituted directory before a receipt.
There are no caller-supplied paths, IDs or limits in the wire protocol. Callbacks
are trusted internal interfaces under the core mutex; they additionally reject
IDs outside the copied policy range or limits unequal to the copied fixed policy.
Lifetime: drain and close the broker before closing its adapter context.

Fresh configure independently rereads attributes and the requested project's quota.
Nonblank project/inheritance, hard limits or usage cause refusal. Soft/realtime
limits or realtime usage are unsupported and refused even during observation;
block-to-byte overflow, wrong record type/ID/version and unknown status version
are errors. `ESRCH`/`ENOENT` are NOT treated as a blank project; privileged
acceptance must establish how absent quota records behave on the target kernel.

Order is: exact block+inode limits first; read both back; recheck mount; assign
project+inheritance on the retained directory; fsync; independently observe all
four properties and mount again. Failed/ignored writes cannot report success.
There is no rollback, recursive adoption, quota reduction, repair or ID reuse.
The core durably binds the fresh empty protected directory before invoking this
adapter; retries observe only, never reconfigure a partially provisioned allocation.
The core still owns authorization, allocation, freshness, directory protection,
revocation serialization and receipt checks; the adapter is not a standalone
privileged request handler and must not be exposed as one.

Mount checks do not atomically fence a hostile privileged unmount/remount or
namespace switch between checks/syscalls. Production must protect the startup
mount namespace, mount administration, ancestors and FDs from callers/workloads,
and test the required mount-race denials. No untrusted-writer access is granted
before successful final readback; privileged actors are not sandboxed by quotas.
Realtime storage remains unsupported; acceptance must prove workloads cannot
enable a realtime/inheritance escape or reassign projects/clear inheritance.

## Reproduction and actual results

As the ordinary user with existing `TMPDIR` pointing to user scratch:

```sh
make -C native/quota-broker clean all test analyze
make -C native/quota-broker sanitize
```

Both completed successfully after integrating the revoke fix:

- Hardened GCC C11 static libraries and tests (`-Wall -Wextra -Werror
-Wconversion -Wshadow -Wstrict-prototypes`, fortify and stack protector).
- **17 core tests**, including cached-revoke live-loss/mount-health regressions.
- XFS syscall-seam test with exact command/type/mask/512-byte conversion checks,
  independent block/inode/project/inheritance observation, default disable gate,
  retained/CLOEXEC/closed startup-FD checks, renamed directory FD targeting,
  wrong root/invalid FD/range/limits denials, malformed UUID/status/quota responses,
  readonly/non-XFS/unenforced state, overflow, foreign/used/realtime/soft state,
  ignored successful writes and **fault injection at all 22 configure seam calls**.
- Real core + native adapter + fake ioctl/quotactl integration exercises bootstrap,
  ensure, receipt identity, retry without rewrite, inode-limit mismatch denial and
  unhealthy-mount revoke refusal. Real unprivileged directory/fsync/statx/journal
  behavior, fake XFS behavior; this is not a real XFS test.
- GCC `-fanalyzer` on core, test-enabled adapter and acceptance-enabled adapter.
- AddressSanitizer + UndefinedBehaviorSanitizer runs of both test executables.

Test executables refuse effective UID 0. **Zero real XFS attribute/quota ioctls,
quotactl calls, quota mutations, mounts, root/sudo/Docker operations or production
writes were executed.** App/DB/engine/browser suites were not rerun for this
isolated native-library change. No daemon/launcher/runtime integration is implied.

## Exact remaining gates — still blocked for production

1. Independent security review of this adapter and the integrated core. Local
   standards/spec self-review is not independent review; the parent retains this
   integration gate. Resolve unsupported target-kernel behavior without path-based
   or permissive fallback. No native implementation has privileged acceptance yet.
2. Operator-approved exclusive census/reserved range, mount UUID/root identity,
   fixed byte/inode policy, identity/delegation mapping, protected startup FD
   acquisition, protected ancestors/state/binary/dependencies and one allocator.
   Do not stack native allocation behind another independently writable ledger.
3. Independently protected epoch/anti-rollback witness and restore/reconciliation
   procedure. The integrated revoke fix detects and poisons **live journal loss**;
   it cannot detect an older **well-formed rollback after restart**. A nonzero
   manifest epoch is not an external witness and does not solve that blocker.
4. Protected authenticated bounded transport and FD-consuming launcher sharing the
   mutation/revocation fence; caller/workload project/attribute/mount privileges
   removed; no alternate launch/quota route; manager metadata/publication and
   least-privilege access policy integrated. A receipt alone is not a launch token.
5. Separate host-change approval and root-owned reviewed disposable acceptance
   harness/build, never execution of this checkout as root. In an isolated
   approved XFS fixture prove UUID/attached identity/accounting/enforcement,
   fresh/absent quota record semantics, both exact limits and inherited descendants,
   real byte exhaustion with free filesystem space, separate inode exhaustion,
   observed errno/usage, delete/recovery and unchanged peer projects. Prove
   reassignment/inheritance/realtime escapes fail; symlink, rename, same-device
   nested/bind mount, lazy detach and replacement fail; concurrent unique projects,
   mutation+launch revocation, interrupted provision/restart/restore and durable
   storage recovery meet the core acceptance matrix. Confirm workload stop before
   narrow cleanup; do not clear/reuse reservations.
6. Only after those proofs, independent review and explicit deployment approval
   consider removing/replacing the compile-time disable gate and installing a
   protected service. No production gate is removed by passing the mocked tests.
