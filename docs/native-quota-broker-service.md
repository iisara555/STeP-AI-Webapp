# Native quota broker — per-user pools and root-local operations

Status: **prepared, unprivileged evidence only; not installed or enabled.**
The production gateway still refuses startup (`refuseUnsafeGateway()`). Nothing
in this increment enables it, changes sudoers, installs software, or executes a
real quota mutation. Real data remains in Supabase.

## Owner decision and capacity

One user has one XFS project and a **15 GiB shared pool**, not 15 GiB per workspace.
All that user's workspace directories inherit that project's id and hard limits.
The target is 50 users now and 300 after the SSD upgrade; these are capacity
planning targets, not users provisioned by this change. The inode example remains
750000 per user. Limits already granted are never lowered.

Root-local add/raise admission uses a conservative reservation ledger:

```text
C = sum(FULL journal/policy hard-byte limits AFTER the proposed operation)
C + reserve_bytes <= filesystem total bytes (f_blocks * f_frsize)
C + reserve_bytes <= current unprivileged free bytes (f_bavail * f_frsize)
```

The first inequality is a total-based reservation ceiling bound to the root-owned
policy reserve and pinned filesystem. The second is an additional **conservative
occupancy veto**: it double-charges ALL existing occupancy, even managed user data,
rather than trying to infer unmanaged occupancy by subtracting asynchronous user
usage. This can refuse a grant that would safely fit; usage is report-only and is
never credited toward admission. No atomic usage/free snapshot is assumed.
Deleting user data cannot decrease `C`; writes cannot increase the total ceiling.

Every grant counts its full hard limit, including never-allocated, revoked and
pending/unapplied raises. Replay reconstructs that same ledger after restart.
Every allocated pool must still be independently observable with nonzero hard
limits, correct project/inheritance and limits not above the journal. Unknown
quota evidence, identity/mount failure, malformed geometry, multiplication overflow,
or missing limits denies admission without a new journal record or quota write.
Filesystem-reserved blocks are excluded by `f_bavail`, never offered as `f_bfree`.

**Limitations:** the free-space veto is only a point-in-time conservative check,
not a fence against unrelated/root writers. Unknown external consumption after
the read, filesystem metadata growth, reflink/accounting overhead and future host
changes can still exhaust disk space. `--reserve-bytes` is explicit operator
headroom, not a physically isolated reservation or a kernel-enforced non-user
quota. Its adequacy requires an operator census, bounds on non-user writers and
monitoring; reserve zero is only a test/example, not a production recommendation.
Physical inode capacity is not reserved by this check. Stopping the broker only
serializes operator journal operations; already-running workloads keep writing.
The fix does not depend on stopping those workloads or reversing the read order.

## Ownership and protocol

```text
/mnt/step-work/step-ai-broker                  root:root    0755
├── state/                                    root:root    0700  manifest + journal
└── root/                                     root:itsara  0710
    └── p<ID>/                                root:itsara  0750  project + PROJINHERIT
        └── <workspace-uuid>/                 step-runner:itsara 02750
```

The workload cannot write the pool boundary. Its sandbox must bind only its own
workspace, never the user pool. Exact owner/mode and directory identity drift is
denied, never repaired. A partially provisioned directory is not adopted.

Gateway requests (one exact frame, then EOF, peer checked with `SO_PEERCRED`):

```text
ENSURE/1 <user-uuid>\n
WORKSPACE/1 <user-uuid> <workspace-uuid>\n
USAGE/1 <user-uuid>\n
```

Replies remain `OK/2`, `OK/3`, `USAGE/1`, or `DENIED/1`. The gateway has **no add
or raise request**. `USAGE/1` never allocates and reads the user's current journal
limits and kernel usage. The existing socket API's `usageLevel()` returns `ok`,
`warning` at 80%, `critical` at 95%, and `full` at/over 100%; the worse of bytes
and inodes decides. This API is tested; HTTP/UI warnings and upload refusal are
not wired into production.

## Policy migration

Service policy is now **version 2**, with `reserve_bytes` required and **no
`user=` lines**. All users are root-local journal grants, so adding one does not
edit immutable policy. Required keys:

```text
version=2
epoch=<32 lowercase hex, nonzero>
mount_uuid=<canonical nonzero filesystem UUID>
root_device=<device of root/>
root_inode=<inode of root/>
bytes_hard=16106127360
inodes_hard=750000
reserve_bytes=<operator-chosen headroom in bytes>
first_project=100000
last_project=199999
gateway_uid=1000
gateway_gid=1000
workload_uid=995
```

All lines are strict canonical `key=value` (the placeholders above must be
replaced); no inline comments. File ownership/mode/link/size and ancestor trust
checks are unchanged. Both native and TS readers reject version 1 and `user=`.
The native manifest ABI is also version 2. **There is no automatic migration of
an existing version-1 manifest/journal. Do not delete/rebootstrap existing state
or recycle project ids.** Existing populated installations need a separately
reviewed offline migration/restore tool; that is not implemented here. The fresh
installer refuses existing paths.

## Operator commands and recovery

Production binary: fixed paths, euid 0, real XFS adapter. Only these additional
root-local operations take caller values (canonical UUID and bounded decimals):

```text
step-quota-broker --add-user UUID
step-quota-broker --raise-user UUID BYTES INODES
```

Stop the service first; both commands require its exclusive journal lock and
refuse while it is running. No gateway mapping or authority is derived from a
command supplied over the socket.

- **Add:** capacity check, then fsynced GRANT record reserving a fresh id. The pool
  directory is created only by first ENSURE/WORKSPACE. Duplicate or revoked users
  are never granted again. No ids are reused; 512 grants maximum.
- **Raise:** allocated, unrevoked pools only; neither hard limit may decrease.
  Capacity check precedes a fsynced RAISE record; then set only XFS block/inode
  hard fields and independently read both back. Maximum 4096 raises per journal.
  An identical, already-applied request is a no-write success.
- **Interrupted raise:** durable record may lead kernel state. ENSURE/WORKSPACE
  and USAGE deny that pool until the operator repeats the same raise. Replay does
  not mutate quotas. If journal fsync was uncertain, the live broker is poisoned;
  reopen and inspect. A complete GRANT may have survived even if add reported an
  error (a duplicate on retry is not evidence of a new grant). A torn journal is
  refused, never truncated or repaired automatically.
- Keep the service stopped on an operator failure; inspect the exact error before
  retry/restart. Service `--check` verifies policy, mount and journal, **not every
  allocated pool's live limits**; it is not proof an interrupted raise was applied.
- Uninstall keeps policy/state/pools. `--purge-empty` now refuses even an
  unallocated grant if the journal is nonempty, preserving id reservations.

The installer writes a v2 policy, bootstraps once, calls `--add-user` for each
initial `--user`, checks, then enables the service. Failure is not rolled back;
inspect the retained journal before doing anything further.

## Build, pins and owner handoff

Build unprivileged from `/home/itsara/projects/quota-pool-operations`:

```sh
make -C native/quota-broker clean all acceptance
make -C native/quota-broker service-check acceptance-check
```

Reproducible binary SHA-256 values (independent scratch-directory builds were
byte-identical):

```text
65bc1819e38d747285aa77d13aa5e639251a3c098e0ac8de19e1fc62ad2aeae5  step-quota-broker
2d86101468b2af0622680ffa5e1004ba1ef55239a82192a6e16f4f7082e39394  service/step-quota-broker.service
f53c5d1d974ca3bb8a7d83a7c997af36b12d4097fb98d210a37adba60f3f5452  service/install-quota-broker.sh
52d918387d3353ba46b5fdfa96eb26802eaca7692120443db7f5b4597ff931e4  xfs-acceptance
bcf4675b945becca59bb8ea881abd3e8c95bc7d61cef21c9ea3947b43c3f9a0c  acceptance/run-xfs-acceptance.sh
```

Only the owner may install root-owned copies. The installer requires its exact
installed path `/usr/local/libexec/step-quota-broker/install`, a trusted root-owned
ancestor chain, and matching binary/unit pins. Its options are:

```text
install --dry-run|--install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes N --user UUID [--user UUID...]
install --uninstall [--purge-empty]
```

These are **not commands executed during this recovery**. Do not enable the
gateway after installing this service. See `native-quota-xfs-acceptance.md` for
the separate owner-run acceptance; installed acceptance copies still have the
old `c2246ba2…09ae` binary and must be replaced by the owner before testing this
increment. The current wrapper correctly reports that mismatch in dry-run.

## Verification and remaining increments

Unprivileged verification:

- Native `all`, `test`, `analyze`, `sanitize` pass: 25 core tests, 12 deterministic
  capacity-race schedules (add/raise; writes/deletion before/after statvfs), XFS syscall seam
  (including 17 raise fault points), transport, 5 policy groups, 7 fake-broker
  groups, and SQLite self-test. Sanitized root binaries exercise refusals only.
- Regression sensitivity: compiling the new race test against the pre-fix
  `70bd3d8` core in scratch fails its deletion assertion for BOTH add and raise:
  the old code admits 2 MiB of hard limits plus 1 MiB reserve against 2 MiB
  free, charging only 1 MiB. The fixed core refuses without journal/quota changes;
  roomy post-statvfs schedules admit full limits and retain that charge on replay.
- Installer lifecycle and acceptance wrapper lifecycle pass with stubs; no real
  quota, mount, loop, installation or systemd service mutation. Offline unit
  validation passes (exposure 1.6).
- `npm run check`, `npm test` (118), `npm run test:db` (29), and
  `npm run test:engine` (320) pass. The check retains the existing 17 upstream
  engine diagnostics noted by the server type checker. `npm run build` passes
  with the existing large-chunk warning.
- Browser suite: 84 passed, 2 skipped, 2 failed (88 collected). The two
  `owner-trial.spec.ts` cases fail before browser actions because the trial starts
  a fresh RuntimeManager without explicit quota-policy provisioning:
  `QUOTA_POLICY_REQUIRED` (also reproduced directly with a fresh scratch data
  directory). This increment does not change the trial or weaken that fail-closed
  requirement. Chromium initially could not load `libatk-1.0.so.0`; rerunning with
  existing scratch-only libraries via
  `LD_LIBRARY_PATH=/home/itsara/.hermes/cache/scratch/step-e2e-libs/root/usr/lib/x86_64-linux-gnu`
  produced the counts above without a host package installation. Browser traces
  and reports are ignored generated output, not committed artifacts.
- The SQLite self-test uses real SQLite 3.46.1 plus `RLIMIT_FSIZE`, **not XFS**:
  200 committed history rows retain checksum/integrity, 20 small writes reported
  success remain present after reopen, the 6 MiB write fails with extended code
  778 (disk I/O error), and succeeds after lifting the limit. Do not promise only
  `SQLITE_FULL`: full-disk SQLite failures can surface as extended I/O errors.

Remaining work, split into explicit gates:

1. **Owner-run real XFS acceptance and real root-service check.** Harness now adds
   service-model add/raise, no-overcommit refusal, shared-pool SQLite exhaustion
   from another workspace, committed-history verification and write recovery.
   None of these new root paths was executed. The prior recorded PASS covers
   only the older private-layout binary, not this increment.
2. **Gateway per-user raised-limit expectations: bounded application gate closed.**
   An optional protected operator metadata reader now binds each user's exact
   project/limits to the service v2 policy, installation identity and mount. The
   broker boundary accepts only exact matches and rereads claims after asynchronous
   operations; arbitrary larger receipts, unknown users and stale claims refuse.
   See [trusted-source boundary and evidence](native-quota-raised-expectations.md).
   This is unprivileged/synthetic evidence, not installed root-service acceptance.
   Owner-reviewed metadata provisioning and real raised-user XFS/service checks
   remain host gates. The legacy synthetic RPC remains exact-default-only.
3. **Protected launcher and revocation-through-spawn fence.** Integrate/review the
   separate launcher work, retire the broad sudoers bwrap permission, enforce user
   namespaces and one-workspace binds, then perform owner host acceptance. Those
   files were not touched here. `/mnt/step-work` root ownership also remains a
   recommended host hardening step against gateway rename denial-of-service.
4. **History/runtime/UI behaviour.** Wire 80/95/full warnings and upload refusal;
   show explicit write/start failures without silent partial saves. The acceptance
   uses the Store schema/WAL setup via the system C SQLite library, not the exact
   Node runtime or browser UI. A fresh Store's index-rebuild writes may prevent
   startup while full even when old rows are readable; this is measured, not
   disguised as successful startup.
5. **Anti-rollback witness, offline v1 migration and restore procedure.** Well-formed
   journal rollback after restart is not detected by the current journal alone.
6. Only after those gates: explicit production composition and owner approval.
   Production refusal remains unconditional until then.

## สรุปภาษาไทยแบบง่าย

กู้งานเดิมไว้แล้ว เพิ่มผู้ใช้และเพิ่มพื้นที่แบบไม่ลดของเดิมได้ทางคำสั่งของ root
เท่านั้น ผู้ใช้หนึ่งคนยังแชร์พื้นที่ 15 GiB ระหว่างหลาย workspace การทดสอบแบบ
ไม่ใช้ root ผ่าน แต่ **ยังไม่ได้ทดสอบชุดใหม่กับ XFS จริงและยังไม่ได้ติดตั้ง**
gateway จริงยังปิดอยู่ และข้อมูลจริงยังอยู่ใน Supabase ต้องผ่านการทดสอบจริง
และเชื่อม launcher/การแจ้งเตือนก่อนใช้งานจริง
