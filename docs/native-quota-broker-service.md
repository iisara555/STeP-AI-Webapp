# Native quota broker — installable system service (per-user pools), NOT yet installed

Status: **prepared, unprivileged evidence only.** Nothing was installed, run as root or
enabled. The production gateway entry is unchanged and still refuses to start
(`refuseUnsafeGateway()`); no gateway composition uses the broker yet.

## What changed in this increment

| Part                                                                                     | Files                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Per-user pool in the core (`QB_LAYOUT_SHARED`), workspace directories, usage             | `native/quota-broker/core.{c,h}`                                                  |
| Usage readback in the real adapter (`d_bcount`×512, `d_icount`)                          | `native/quota-broker/xfs.c`                                                       |
| Request dispatch `ENSURE/1`, `WORKSPACE/1`, `USAGE/1`; replies `OK/2`, `OK/3`, `USAGE/1` | `native/quota-broker/transport.{c,h}`                                             |
| Strict root-owned policy file loader                                                     | `native/quota-broker/policy.{c,h}`                                                |
| Service main program (`--check`, `--bootstrap`, `--serve`)                               | `native/quota-broker/broker-main.c`                                               |
| Hardened system unit + unprivileged validation                                           | `native/quota-broker/service/step-quota-broker.service`, `service/verify-unit.sh` |
| Owner install/uninstall script + stubbed lifecycle test                                  | `service/install-quota-broker.sh`, `service/test-install-script.sh`               |
| Gateway socket client, policy reader, usage levels                                       | `server/src/workspace/native-quota-socket.ts`                                     |
| Broker-mode manager composition (`brokerQuotaBoundary`)                                  | `server/src/workspace/native-quota.ts`                                            |
| Runtime writes `conversations.json` 0640 (gateway group via setgid)                      | `server/src/workspace/runtime-main.ts`                                            |

## Owner decision: one quota pool per user (2026-11-07)

- One XFS project id per **user**, hard limits are install-time policy values
  (placeholder 15 GiB = `16106127360` bytes and `750000` inodes per user). Every
  workspace of that user is a subdirectory of the user's project directory and
  inherits its project id (XFS `PROJINHERIT`), so all of them share the pool.
- Capacity: 50 users × 15 GiB = 750 GiB on the current 954 G SSD; no overcommit.
  The installer refuses when `users × bytes_hard` exceeds the space available on
  `/mnt/step-work` at install time. A bigger SSD is needed for the 300-user target
  (`QB_MAX_GRANTS` is now 512 so the format allows it).
- The sandbox still binds **only one workspace directory** (`--bind-fd` of
  `p<ID>/<workspace-uuid>`), never the user directory.

## Directory layout and ownership (decision + trade-offs)

```text
/mnt/step-work/step-ai-broker            root:root     0755
├── state/                               root:root     0700   manifest + journal (core)
└── root/                                root:itsara   0710   traverse only for the gateway group
    └── p<ID>/       (one per user)      root:itsara   0750   quota project + PROJINHERIT
        └── <workspace-uuid>/            step-runner:itsara 02750   bound into ONE sandbox
            ├── files/                   step-runner:itsara 02750
            └── snapshots/               step-runner:itsara 02750
```

Why:

- **The user directory stays root-owned and never workload-writable.** The quota
  boundary (its project id and inheritance flag) can only be changed by its owner
  outside a user namespace; root ownership removes even that path. Workloads never
  see it (only their own workspace directory is mounted).
- **Workspace directories belong to step-runner** because the runtime must write
  `workspace.sqlite`, `conversations.json`, `files/` and `snapshots/` directly in it.
- **The gateway group (itsara, gid 1000, no other members — the installer checks)**
  can traverse `root/` (0710, cannot list it), read `p<ID>` (0750) and read the
  workspace directory (02750). Setgid makes new runtime files group `itsara`; the
  runtime now writes `conversations.json` 0640 (explicit chmod) so the gateway can
  list a stopped workspace's conversations. The gateway can open each directory
  `O_DIRECTORY|O_NOFOLLOW` to re-verify identity and pin it at launch, but it can
  write nothing inside the pool.
- Nobody else can traverse `root/`, so "other" permission bits inside it are
  unreachable for every other local user.

Trade-offs / residuals (all fail closed):

- step-runner owns the workspace directory and its files. Outside a user namespace
  a file owner can change `fsx_projid` and escape the quota (measured in the XFS
  acceptance). Enforcement therefore still depends on every workload launch using
  `--unshare-user --disable-userns`, and **the current sudoers rule lets itsara run
  `/usr/bin/bwrap` as step-runner with arbitrary arguments**. An exclusive launcher
  that enforces those flags is still required (gate below).
- If the workload changes its workspace directory mode/owner, the broker denies
  that workspace from then on (never repaired); the gateway then cannot start it.
- A crash between creating a directory and handing it over leaves a directory the
  broker denies forever (`EPERM`); the user's other workspaces are unaffected.
- `/mnt/step-work` itself is owned by itsara, so the gateway account can rename
  `step-ai-broker` away (denial of service). It cannot create a root-owned
  substitute; the broker detects identity changes (policy `root_device/root_inode`)
  at its next start. Making `/mnt/step-work` root-owned is a recommended host change.

## Protocol (one request per connection, write EOF, exact bytes)

Requests (the peer must be the gateway uid by `SO_PEERCRED`, checked before any read):

```text
ENSURE/1 <user-uuid>\n                          46 bytes  ensure the user's pool
WORKSPACE/1 <user-uuid> <workspace-uuid>\n      86 bytes  ensure pool + workspace directory
USAGE/1 <user-uuid>\n                           45 bytes  usage of an existing pool, never allocates
```

Replies (anything else, or a partial reply, is a failure):

```text
DENIED/1\n
OK/2 <project> <device> <inode> <bytes_hard> <inodes_hard> <mount-uuid>\n
OK/3 <project> <device> <user-inode> <workspace-inode> <bytes_hard> <inodes_hard> <mount-uuid>\n
USAGE/1 <project> <bytes_used> <bytes_hard> <inodes_used> <inodes_hard>\n
```

This is the smallest extension that lets the gateway build its receipt without
inventing evidence: every value is what the core just verified under its mutex
(project + inheritance read back, both hard limits read back, live mount UUID and
project enforcement checked against the fixed policy). No paths (directories are
the fixed `p<project>/<workspace-uuid>` names), no errno, no FDs, no `SCM_RIGHTS`.
The TS side (`brokerQuotaBoundary`) then opens `p<ID>` and the workspace directory
with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and requires on the **descriptor** the
replied device/inode plus exact owner/group/mode (root/itsara 0750 and
step-runner/itsara 02750); the launch pin re-checks the workspace inode again
inside admission.

The mapping from a gateway user id (e.g. a Google-derived id) to the broker's
user UUID is an explicit trusted option (`userUuidFor`), never a request field. An
unmapped user fails (`NATIVE_QUOTA_NO_USER_POOL`); a mapped user that is not in the
policy is denied by the broker.

## Policy file `/etc/step-quota-broker/policy` (root 0644)

Readable by the gateway (it contains no secret) so `readBrokerPolicy()` can supply
the expected mount UUID, limits, range and principals. Strict `key=value` lines,
`#` comments; unknown/duplicate/missing keys, whitespace, non-canonical numbers or
UUIDs and out-of-range values are refused with the line number. The broker refuses
the file unless it is a regular file owned by root with mode exactly 0600 or 0644,
one link, ≤ 32 KiB, in a root-owned directory chain not group/other-writable.

```text
version=1
epoch=<32 hex>                 # random at install
mount_uuid=<filesystem UUID of /mnt/step-work>
root_device=<st_dev of root/>   root_inode=<st_ino of root/>
bytes_hard=16106127360          # placeholder 15 GiB per user, owner's choice
inodes_hard=750000              # placeholder, owner's choice
first_project=100000            last_project=199999   # excludes the old test id 424242
gateway_uid=1000  gateway_gid=1000  workload_uid=995
user=<uuid>                     # one line per user pool, 1..512
```

The core manifest binds **every** value at bootstrap: any later edit (including
adding a user or raising a limit) makes `--check`/`--serve` refuse. That is
deliberate until the operator RAISE / onboarding operations exist (gates below).

## Service program and unit

- `step-quota-broker --check | --bootstrap | --serve` (production build: fixed
  paths, euid 0 only, real XFS adapter compiled with
  `QB_XFS_PRIVILEGED_ACCEPTANCE=1`, `no_new_privs`, `close_range(3, …)`). `--serve`
  **never bootstraps**: an empty/lost state must not restart allocation silently.
  `--bootstrap` refuses unless root/ and state/ are empty and the live mount matches.
- Socket: systemd creates `/run/step-quota-broker` 0700; the broker binds
  `broker.sock` relative to the pinned directory, makes it root:itsara 0660,
  listens, then makes the directory root:itsara 0710. A leftover socket refuses.
  Readiness is `sd_notify READY=1` (Type=notify).
- Unit hardening: `ProtectSystem=strict`, `ReadWritePaths=/mnt/step-work/step-ai-broker`
  only (+ the RuntimeDirectory), `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
  `PrivateNetwork`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`,
  `NoNewPrivileges`, `CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER
CAP_FSETID` (quotactl; hand-over chown; chmod 02750 of a directory root no longer
  owns, with a group root is not in), `RestrictNamespaces`, `MemoryDenyWriteExecute`,
  `SystemCallFilter=@system-service quotactl quotactl_fd` minus
  `@resources @mount @swap @reboot @raw-io @module @debug @cpu-emulation @obsolete
@clock @setuid`, `UMask=0077`, `LimitNOFILE=256`, `TasksMax=4`, `MemoryMax=64M`,
  `RestartPreventExitStatus=2`. `RestrictSUIDSGID` is **not** set: it would forbid
  the setgid hand-over mode.
- `bash native/quota-broker/service/verify-unit.sh` →
  `systemd-analyze verify` clean for this unit, and
  `systemd-analyze security --offline` **exposure 1.6 OK** (threshold 2.0). Remaining
  ✗ items: runs as root, CAP_SYS_ADMIN/CHOWN/FOWNER/FSETID, `@chown`/quotactl
  allowed, no PrivateUsers, AF_UNIX allowed, no RestrictSUIDSGID — each required.

## Pool full: behaviour and the chat-history decision

Defined behaviour: when a user's pool reaches either hard limit, writes inside
**that user's** workspaces fail with `ENOSPC` (XFS project quota reports `ENOSPC`,
not `EDQUOT`); other users' projects are unaffected (separate projects; proven per
project by the XFS acceptance). `USAGE/1` lets the gateway warn at 80 % and 95 %
(`usageLevel()` → `warning` / `critical` / `full`; the worse of bytes and inodes
decides).

Chat history (`<workspace>/workspace.sqlite`) — options evaluated:

1. **Outside the pool** (separate directory/project): history writes keep working
   when files fill the pool, but history then needs its own bound, or one user can
   fill the shared disk through history; a second project per user doubles ids,
   census and hand-over paths and still has a "history pool full" case.
2. **Inside the pool with reserved headroom**: XFS cannot reserve space for one file
   inside a project, so headroom could only be emulated by refusing new uploads
   above a threshold in the gateway — advisory, not enforced.
3. **Inside the pool, fail closed (chosen).** SQLite commits atomically: a write
   that hits `ENOSPC` fails with `SQLITE_FULL` and rolls back; already committed
   history stays intact and readable. The new turn fails with a clear error, never
   a silent partial save. Usage warnings at 80/95 % give the user time to delete
   files; the gateway should additionally refuse new uploads at `critical`.

**Not yet proven:** the SQLite/runtime behaviour on a real full XFS project (that
earlier history stays readable and the error reaches the UI as a clear message),
and the gateway upload refusal at `critical`. Both need an owner-run privileged
acceptance step (real XFS) and gateway/UI wiring.

## Tests (all unprivileged)

- native: `make -C native/quota-broker clean all test analyze sanitize`
  - `test-core` 19 (2 new: per-user pool/workspaces/usage; private layout unchanged)
  - `test-xfs` seam incl. usage readback/overflow; `test-transport` incl. USAGE/WORKSPACE
  - `test-policy` 4 groups (format, values, 512 users, file owner/mode/link/size)
  - `test-broker` 5 groups against the FAKE-adapter main: usage/policy refusals,
    directory/identity/mount refusals, one-time bootstrap bound to policy, socket
    refusals, served per-user pool + workspaces + usage + restart
  - `-fanalyzer` clean for policy.c and both broker-main builds; ASan/UBSan pass;
    sanitized service binary refusal paths (exit 2)
- `bash native/quota-broker/service/test-install-script.sh` (15 checks, stubbed
  privileged tools), `service/verify-unit.sh`, shellcheck clean
- TS `server/test/workspace-quota-broker.test.ts` (6): socket client against a real
  broker process; bounded/exact client (malformed, oversize, partial, silent,
  absent); policy reader; end to end manager → broker → pinned start in
  `p<ID>/<workspace-uuid>` incl. two workspaces sharing one project, conversations,
  usage levels, rename+substitute refusal; fail-closed (unmapped/unknown user,
  changed mode, broker down); production entry still refused.

The fake adapter performs no quota syscalls; it models inheritance and usage in
files. Mocked success is not enforcement evidence.

## Remaining gates before the gateway may use the broker (do not enable)

1. **Owner install** of this service (commands below) and a real `--check`.
2. **Re-run the XFS acceptance** with the current core (its binary hash changed:
   the core gained the shared layout/usage; the recorded PASS is for `c2246ba2…`).
3. **Operator RAISE** of a user's limit (never lower, never reuse ids): journal
   event + adapter set + readback, and policy/manifest handling. Not implemented.
4. **User onboarding**: the user list is fixed at bootstrap. Adding users needs a
   protected append-only grant operation. Not implemented.
5. **Exclusive launcher**: enforce `--unshare-user --disable-userns` and the single
   workspace bind for every step-runner launch (the sudoers rule is too broad).
6. **Revocation-through-spawn fence**: `qb_revoke` is not serialized with the
   gateway's admission/spawn.
7. **Pool-full acceptance** on real XFS (history intact, clear error) and gateway/UI
   wiring of `usage()` (80/95 % warnings, upload refusal at critical).
8. **Anti-rollback witness** for the state journal and restore procedure.
9. Gateway composition + an explicit documented real mode in `main.ts`, after all of
   the above; production stays fail-closed until then.

## Owner commands

See the "Exact owner commands" section at the end (hashes pinned for this commit).

## Exact owner commands

Build as itsara in this worktree and compare the hashes first (reproducible build):

```sh
cd /home/itsara/projects/step-quota-broker-service/native/quota-broker
export TMPDIR=/home/itsara/.hermes/cache/scratch
make clean service service-check          # must print pinned == actual for binary and unit
sha256sum step-quota-broker service/step-quota-broker.service service/install-quota-broker.sh
```

Expected:

```text
b9676c20683f1c64a297161dc0145a1265b031aff381bdad9d1ab64ad04b3162  step-quota-broker
2d86101468b2af0622680ffa5e1004ba1ef55239a82192a6e16f4f7082e39394  service/step-quota-broker.service
a4b4c18af60c5ad253f8c5b3d51f61a865989c10e9a7b1725c92cef18b7c9abd  service/install-quota-broker.sh
```

Install root-owned copies, verify the **installed** copies, preview, then install.
Replace the `--user` values with the real per-user UUIDs (one per user, ≤ 512) and the
limits with the owner's final choice (placeholders shown):

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec/step-quota-broker
sudo install -o root -g root -m 0755 step-quota-broker /usr/local/libexec/step-quota-broker/step-quota-broker
sudo install -o root -g root -m 0644 service/step-quota-broker.service /usr/local/libexec/step-quota-broker/step-quota-broker.service
sudo install -o root -g root -m 0755 service/install-quota-broker.sh /usr/local/libexec/step-quota-broker/install
sha256sum /usr/local/libexec/step-quota-broker/*     # must equal the three hashes above
/usr/local/libexec/step-quota-broker/install --dry-run --bytes-hard 16106127360 --inodes-hard 750000 --user <uuid-1> --user <uuid-2>
sudo /usr/local/libexec/step-quota-broker/install --install --bytes-hard 16106127360 --inodes-hard 750000 --user <uuid-1> --user <uuid-2>
systemctl status step-quota-broker.service --no-pager
ls -la /run/step-quota-broker/          # broker.sock root:itsara srw-rw----, dir root:itsara drwx--x---
```

Expected end of `--install`: `census: no quota record in 100000..199999`,
`capacity: …`, `bootstrapped: …`, `check passed: …`, then
`INSTALLED: step-quota-broker.service active; socket /run/step-quota-broker/broker.sock (root:1000 0660, dir 0710)`.
Any `REFUSED:` line means nothing further was done (exit 2); a failure after creating
directories prints what was created and the undo command.

Undo:

```sh
sudo /usr/local/libexec/step-quota-broker/install --uninstall                 # stop, disable, remove unit; keeps policy/state/pools
sudo /usr/local/libexec/step-quota-broker/install --uninstall --purge-empty   # only if no user pool was ever allocated
sudo rm -r /usr/local/libexec/step-quota-broker
```

The XFS acceptance must be re-run with the current core before relying on the
service (same commands as `docs/native-quota-xfs-acceptance.md`, new pins):

```text
3f711f7e07237b4ac06b28d0280fe01a3b305cc2ad01970fddd34518ebe3a323  xfs-acceptance
afd397b91d430c222a435b32c64dfa41a3f9155c1dd4d01360d46174b601cce2  run (acceptance/run-xfs-acceptance.sh)
```

## สรุปภาษาไทยแบบง่าย

- เตรียมโปรแกรม broker ให้ติดตั้งเป็น service ของระบบได้แล้ว แต่ **ยังไม่ได้ติดตั้ง** และ gateway จริงยังปิดอยู่
- โควตาเป็นแบบ "ต่อผู้ใช้": ผู้ใช้หนึ่งคนได้พื้นที่หนึ่งก้อน (ค่าตัวอย่าง 15 GiB / 750000 ไฟล์) ทุก workspace ของคนนั้นใช้ก้อนเดียวกัน
- gateway ถามปริมาณที่ใช้ไปได้ เพื่อเตือนที่ 80% และ 95%
- ถ้าพื้นที่เต็ม เฉพาะผู้ใช้คนนั้นเขียนไม่ได้ ประวัติแชทที่บันทึกแล้วไม่หาย (ต้องทดสอบจริงบน XFS อีกครั้ง)
- ยังไม่ทำ: การเพิ่มโควตา (RAISE), การเพิ่มผู้ใช้ใหม่หลังติดตั้ง, launcher ที่บังคับ sandbox
