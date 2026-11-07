# Native quota broker — owner-run XFS privileged acceptance

Status: **prepared, NOT yet run.** Nothing here has been executed as root. The
acceptance-enabled binary has only been compiled, analyzed and run on its
unprivileged refusal paths. The production compile-time gate in `xfs.c` is unchanged
(default build still returns `ENOTSUP`). A PASS from this harness is evidence for
gate 5 of `docs/native-quota-broker-xfs.md`. It does not approve production use.

## What it is

- `native/quota-broker/xfs-acceptance.c` (built by `make acceptance` with
  `-DQB_XFS_PRIVILEGED_ACCEPTANCE=1`, reproducibly via `-ffile-prefix-map`). It
  combines the real `core.c` with the real `xfs.c` adapter. There is no fake syscall
  seam. Independent readback uses its own `quotactl_fd`/`FS_IOC_FSGETXATTR` calls.
  It refuses unless all of these hold: euid 0; the mount path is canonical; the path
  is a mount root; the filesystem is XFS, ≤ 1 GiB and empty; project accounting and
  enforcement are on. It never execs anything.
- `native/quota-broker/acceptance/run-xfs-acceptance.sh`, the owner-run wrapper:
  - It refuses unless all of these hold: uid 0; it runs as the installed copy
    `/usr/local/libexec/step-xfs-acceptance/run`; it, the binary and every ancestor
    are root-owned and not group/other-writable; `step-runner` is 995:983.
  - It makes `mktemp -d /var/tmp/step-xfs-acceptance.XXXXXXXX` and verifies the
    directory is root:root 0700.
  - It copies **only** the binary into that directory and checks the copy's SHA-256
    against the pin in the script before running it.
  - It creates a sparse image, runs `mkfs.xfs` on the image file, attaches it with
    `losetup --find --show`, and mounts it with
    `mount -t xfs -o pquota,nodev,nosuid,noexec` on `$T/mnt` (0700).
  - It runs the binary under `timeout -k 15 600`.
  - The EXIT trap (also triggered by INT/TERM/HUP) always does the following. It
    stops the binary first. It unmounts with retries and detaches every loop device
    backed by the image. It writes `/var/tmp/step-xfs-acceptance.log`, owned by
    root, mode 0644 (readable by itsara), through mktemp + atomic rename, so a
    planted symlink cannot redirect it. It removes `$T` with
    `rm -rf --one-file-system`. If unmount or detach fails, it leaves `$T` in place,
    says so in the log and exits nonzero.
  - Nothing else on the host is touched. `/mnt/step-work` and `/mnt/step-backup` are
    never referenced.
  - `--dry-run` prints the plan without privilege and checks the installed binary's
    hash and ownership when present.
- **Image size is 320 MiB, not 256 MiB.** `mkfs.xfs` 6.18 on this host contains
  "Filesystem must be larger than 300MB." It only bypasses that check with the
  fstests-only `TEST_DEV`/`QA_CHECK_FS` variables or `--unsupported`, and none of
  those are used. The image is sparse.

### Checks (exit 0 only if all 12 PASS)

Policy: 16 MiB bytes / 64 inodes per project, projects 100000–100003 (exactly
four). Workspaces A–E are on the authenticated peer 4242.

| check                                              | what is proven                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allocation_and_limit_readback`                    | `qb_ensure(A)` → project 100000. Independent `Q_XGETQUOTA` shows blk_hard×512 = 16 MiB, ino_hard = 64, soft/rt = 0. The dir has projid + PROJINHERIT. Re-ensure returns the same project and inode.                                 |
| `new_files_and_dirs_inherit_project`               | Nested dirs/files made by root, and a file made by the writer in `w/`, all carry projid 100000. Dirs carry PROJINHERIT.                                                                                                             |
| `writer_stops_at_byte_hard_limit`                  | Writer (995:983, no groups, no caps, no_new_privs, only an inherited dir FD) writes until `ENOSPC`/`EDQUOT`. Written bytes and quota usage are ≤ 16 MiB and within 2 MiB of it, and the filesystem still has more than 64 MiB free. |
| `space_usable_again_after_deletion`                | The writer unlinks the file. Usage drops (`syncfs` + wait for deferred inactivation). An 8 MiB write then succeeds.                                                                                                                 |
| `writer_stops_at_inode_hard_limit`                 | The writer creates empty files. It gets exactly `64 − baseline` before `ENOSPC`/`EDQUOT`, and icount = 64.                                                                                                                          |
| `inodes_usable_again_after_deletion`               | After unlinking, 8 new files can be created.                                                                                                                                                                                        |
| `workload_userns_cannot_reassign_or_clear_inherit` | The writer in a new user namespace (the bwrap `--unshare-user` model) cannot set projid 0, clear PROJINHERIT on its own dir, or set REALTIME on its own file.                                                                       |
| `wrong_filesystem_uuid_refused`                    | The adapter refuses a flipped-UUID policy with `EXDEV`. The core refuses a mismatching policy.                                                                                                                                      |
| `revocation_survives_broker_restart`               | B is allocated as 100001 and revoked. Ensure returns `EACCES` before and after a full close/reopen from disk. B's quota record is kept.                                                                                             |
| `project_ids_never_reused`                         | After restarts: A keeps 100000, C → 100002, D → 100003, and E → `ENOSPC` (B's id is not recycled).                                                                                                                                  |
| `nested_and_bind_mount_refused`                    | In a private mount namespace, a tmpfs mounted over `broker/p100000` is refused with `EXDEV`. A same-device bind of `/other` over it is also refused with `EXDEV`.                                                                   |
| `lazily_detached_mount_refused`                    | In a private mount namespace, `umount2(MNT_DETACH)` of the XFS mount makes ensure fail with `ESTALE`.                                                                                                                               |

The `INFO init_userns_owner_reassignment` line is a measurement and not a gate. The
same reassignment is tried **without** a user namespace. On Linux, a file owner in
the initial user namespace is expected to be _able_ to change `fsx_projid`, which
escapes the quota. If the line says `ALLOWED`, the launcher must keep workloads
inside a user namespace, as `process-driver.ts` does with `--unshare-user`. Record
the observed value.

## Pinned values (this commit; build with `make -C native/quota-broker acceptance`)

```text
c2246ba25f3c67bbbd1a5071e4b5d328de19cb67ec66782099363a09272309ae  xfs-acceptance   (= BIN_SHA256 in run)
5aea009fbba42ac36dba917e23dbad7662bffc990163c22d5437a0b902d6ba65  run (acceptance/run-xfs-acceptance.sh)
```

## Exact owner commands

Run from the worktree `/home/itsara/projects/step-xfs-privileged-acceptance` at the
commit named in the handoff:

```sh
cd /home/itsara/projects/step-xfs-privileged-acceptance/native/quota-broker
sudo install -d -o root -g root -m 0755 /usr/local/libexec/step-xfs-acceptance
sudo install -o root -g root -m 0755 acceptance/run-xfs-acceptance.sh /usr/local/libexec/step-xfs-acceptance/run
sudo install -o root -g root -m 0755 xfs-acceptance /usr/local/libexec/step-xfs-acceptance/xfs-acceptance
sha256sum /usr/local/libexec/step-xfs-acceptance/run /usr/local/libexec/step-xfs-acceptance/xfs-acceptance
#   must print exactly the two hashes given in the handoff (compare BEFORE running)
/usr/local/libexec/step-xfs-acceptance/run --dry-run      # optional, no privilege
sudo /usr/local/libexec/step-xfs-acceptance/run
```

Verify the **installed root-owned copies**, not the user-writable checkout. The
binary hash is also pinned inside `run`, and `run` checks it again on its private
copy before executing.

Undo (removes everything installed; the run itself leaves only the log):

```sh
sudo rm -r /usr/local/libexec/step-xfs-acceptance
sudo rm -f /var/tmp/step-xfs-acceptance.log    # optional
```

### Expected output (shape; values such as UUID/mount id/free space vary)

```text
<ts> step-xfs-acceptance start; kernel 7.0.0-30-generic; mkfs.xfs version 6.18.0; losetup from util-linux 2.41.3
<ts> binary copy verified: sha256 <pinned>
<ts> mounted: /dev/loopN /var/tmp/step-xfs-acceptance.XXXXXXXX/mnt xfs rw,...,prjquota
INFO filesystem: ~3xx MiB XFS, mount id N, project quota accounting+enforcement on
INFO broker: real core + xfs adapter open; policy 16777216 B / 64 inodes, projects 100000-100003, writer 995:983
PASS allocation_and_limit_readback: project=100000 ... blk_hard=32768*512 ino_hard=64 ...
PASS new_files_and_dirs_inherit_project: expected project 100000: sub=100000+inherit ...
PASS writer_stops_at_byte_hard_limit: writer uid=995 gid=983 (no groups/caps)=yes wrote ~16777216 B then errno=ENOSPC ...
PASS space_usable_again_after_deletion: ...
PASS writer_stops_at_inode_hard_limit: baseline icount=2, writer created 62 empty files (expected 62) then errno=ENOSPC; icount now 64, hard 64
PASS inodes_usable_again_after_deletion: ...
PASS workload_userns_cannot_reassign_or_clear_inherit: ... set projid 0 -> Invalid argument ...
INFO init_userns_owner_reassignment: ... (record the actual value)
PASS wrong_filesystem_uuid_refused: adapter open with flipped UUID -> EXDEV; core open with mismatching policy -> EILSEQ; restart ok
PASS revocation_survives_broker_restart: B allocated project 100001, revoked (ok); ensure before restart -> EACCES; ... after restart -> EACCES ...
PASS project_ids_never_reused: A kept 100000 after restart; C (after B's revocation) -> 100002; restart; D -> 100003; E ... -> ENOSPC
       tmpfs over broker/p<A> -> refused with EXDEV
       same-device bind of /other over broker/p<A> -> refused with EXDEV
PASS nested_and_bind_mount_refused: ...
       lazy detach of the XFS mount -> refused with ESTALE
PASS lazily_detached_mount_refused: ...
RESULT: PASS (12 passed, 0 failed)
<ts> ACCEPTANCE PASSED
<ts> cleanup: unmounted ...; cleanup: detached /dev/loopN; cleanup: removing ...
log: /var/tmp/step-xfs-acceptance.log
```

Exit status: 0 = all PASS; 1 = some FAIL (read the detail on the line); 2 = refused
precondition; 124 = timeout; 130 = interrupted; 3 = cleanup incomplete (the log says
what to inspect). Afterwards `findmnt | grep step-xfs`, `losetup -a | grep step-xfs`
and `ls -d /var/tmp/step-xfs-acceptance.*` should print nothing. Send
`/var/tmp/step-xfs-acceptance.log` back.

## Unprivileged verification done (as itsara)

```sh
make -C native/quota-broker clean all test analyze   # 17 core + xfs seam + transport; -fanalyzer incl. xfs-acceptance.c: clean
make -C native/quota-broker sanitize                 # ASan+UBSan tests; sanitized acceptance binary refusal paths (exit 2)
make -C native/quota-broker acceptance acceptance-check acceptance-dry-run acceptance-wrapper-test
shellcheck -s bash native/quota-broker/acceptance/*.sh   # ShellCheck 0.11.0 (pip shellcheck-py in a scratch venv): clean
```

- The binary built in a separate directory has an identical SHA-256, so the build
  is reproducible.
- `acceptance-wrapper-test` runs a derived copy of the wrapper as itsara. `id`,
  `stat`, `install`, `mkfs.xfs`, `losetup`, `mount`, `umount`, `mountpoint` and
  `findmnt` are stubbed, and the binary is a pinned stub. Results:
  - pass → 0, fail → 1, hash mismatch → 2 (nothing formatted);
  - SIGTERM mid-run → 130, with the binary stopped first and its output kept;
  - every case leaves the stub unmounted and detached, removes the temp dir and
    leaves a 0644 log;
  - the real script run unprivileged refuses with exit 2.
- The ownership/ancestor trust check is stubbed in that test. It is exercised by
  `--dry-run` and by the real run.
- Ubuntu's AppArmor userns restriction blocks unprivileged `uid_map`, so no
  fake-root namespace test is possible.

Not verified: any real XFS behaviour, the mount or loop path, and the root-only
code in `xfs-acceptance.c`. That is exactly what the owner run is for.

## สรุปภาษาไทยแบบง่าย

- เตรียมชุดทดสอบ quota ของ XFS ไว้ให้เจ้าของเครื่องรันเองด้วย root แต่ยัง **ไม่ได้รัน** เลย
- สคริปต์จะสร้างดิสก์จำลองขนาด 320 MiB แบบชั่วคราว (mkfs.xfs ไม่ยอมสร้างที่เล็กกว่า 300MB) แล้วเมานต์ด้วย pquota และรันการทดสอบ 12 ข้อ ได้แก่ การจำกัดพื้นที่ การจำกัดจำนวนไฟล์ การสืบทอด project id การปฏิเสธ mount ซ้อนและ UUID ผิด การเพิกถอนสิทธิ์ที่ยังมีผลหลังรีสตาร์ต และการไม่นำ project id กลับมาใช้ซ้ำ
- เมื่อจบ ไม่ว่าจะผ่านหรือล้มเหลว สคริปต์จะ unmount ถอด loop device และลบไฟล์ชั่วคราวเสมอ เก็บไว้แค่ log ที่ `/var/tmp/step-xfs-acceptance.log`
- root จะรันเฉพาะไฟล์ที่ติดตั้งเป็นของ root แล้ว และตรวจ SHA-256 ก่อนทุกครั้ง
- วิธียกเลิก: `sudo rm -r /usr/local/libexec/step-xfs-acceptance`
