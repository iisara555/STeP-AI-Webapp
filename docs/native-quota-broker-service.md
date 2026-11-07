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

Root-local add/raise admission requires:

```text
sum(each pool's hard bytes minus min(used bytes, hard bytes)) + reserve_bytes
    <= current filesystem free bytes (fstatvfs on the pinned broker root)
```

Never-allocated grants count their full limit. Revoked allocated pools still
count; revoked unallocated grants cannot allocate and promise zero. Every
allocated pool must be independently observable with nonzero hard limits,
correct project/inheritance and limits not above the journal. A pending raise
can leave kernel limits below the journal; its full journal promise still counts.
Unknown usage, identity/mount failure, or missing limits denies admission.

This is byte-capacity admission, not a guarantee against unrelated root writers,
filesystem metadata overhead or future host changes. Choose protected headroom
explicitly using `--reserve-bytes`; the dry-run test uses zero only as an example.
Physical inode capacity is not reserved by this check.

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
1274e38e3be4e43893416384756fd308fff77db3baf8c33ea26dd83990d207f3  step-quota-broker
2d86101468b2af0622680ffa5e1004ba1ef55239a82192a6e16f4f7082e39394  service/step-quota-broker.service
b623274e8d9397ce36042c80422f8a5bf904084ad66b6ee1f9985e6fcaec633a  service/install-quota-broker.sh
874a5a809c5464ffa60f00d310287ee73f9e0ca57f60157c151850f11b1dea70  xfs-acceptance
08bdda340e51ee91af9a84caabf16388ff465d9f3923c4db82590042b9166d54  acceptance/run-xfs-acceptance.sh
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

- Native `all`, `test`, `analyze`, `sanitize` pass: 24 core tests, XFS syscall seam
  (including 17 raise fault points), transport, 5 policy groups, 7 fake-broker
  groups, and SQLite self-test. Sanitized root binaries exercise refusals only.
- Installer lifecycle and acceptance wrapper lifecycle pass with stubs; no real
  quota, mount, loop, installation or systemd service mutation. Offline unit
  validation passes (exposure 1.6).
- `npm run check`, `npm test` (118), `npm run test:db` (29), and
  `npm run test:engine` (320) pass. The check retains the existing 17 upstream
  engine diagnostics noted by the server type checker.
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
2. **Gateway per-user raised-limit expectations.** Socket receipts carry raised
   limits, but the existing manager boundary still compares against its configured
   exact default limits and safely refuses a raised user. A trusted per-user
   expectation policy and tests are needed; do not loosen it to accept arbitrary
   larger receipts. The parser update here is read-only v2 compatibility only.
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
