# Progress

## #57 · bounded CPU enforcement acceptance (test-only increment on 92b93d80)

- Dedicated branch/worktree: `work/step-runner-cpu-acceptance` at
  `/home/itsara/projects/step-runner-cpu-acceptance`. Reviewed the existing driver and resource fixtures first;
  only test/docs changed. No production source, host settings, permissions, real data, merge or deployment.
- The existing `STEP_STEP_RUNNER_TESTS=1` opt-in gate is required. The CPU test refuses pressure unless host
  memory availability is at least 2 GiB, spare kernel task slots at least 256, one-minute load below 1, and
  sampled CPU idle at least 80% over 500 ms. Checks run before launch and again before arming.
- Reads effective scope `cpu.max=25000 100000`, `memory.max=201326592`, `memory.swap.max=0`, `pids.max=32`.
  One direct single-threaded Python worker busy-loops to a two-second monotonic deadline, with a separate
  four-second parent kill timer. Host stop watchdog is ten seconds, fixture lifetime twenty seconds,
  test deadline sixty seconds, outer command ninety seconds. No unbounded allocation/forking/host stress.
- Acceptance requires successful worker exit and post-baseline `cpu.stat` deltas: usage at least 100,000 usec,
  at least three periods and three throttled periods, positive throttled usec. Diagnostics identify the exact
  random cgroup and before/after counters. Requested CPUQuota/configuration or elapsed wall time alone is not proof.
- Red/green: missing CPU fixture behavior failed on the reply assertion. Removing the launch quota temporarily
  failed on effective `max 100000` before pressure. An idle-worker control failed (usage 23,171 usec,
  zero additional throttled periods/time). Both mutations were reverted; production driver has no diff.
- Three consecutive final CPU-only runs passed, each with **21 newly throttled periods**. Corresponding usage /
  throttled-time deltas (usec): **535,183 / 1,546,651**, **535,722 / 1,543,970**, **535,166 / 1,544,138**.
  Each run kept IPC healthy, proved cleanup and restarted the real synthetic runtime on the same workspace,
  completing health/connect/ask. `finally` checks scope emptiness and process/unit/socket cleanup even on failure;
  tracked-handle suite teardown is the fallback.
- Checks passed: `npm run check` (existing 17 upstream engine diagnostics still delegated to Desktop CI),
  `npm test` **118/118**, ungated `npm run test:engine` **221/221**, `npm run test:db` **29/29**,
  `npm run build` (existing large-chunk warning), `npm run check:engine-pin`, and `git diff --check`.
  No browser/UI behavior changed; Playwright was not rerun. Memory/task pressure tests were not rerun in
  this CPU-only increment. Initial recovery/check failed because the new worktree's Harness submodule was
  not initialized; initializing the existing pinned revision fixed it without changing the pin.
- Independent final inventory: **0** step-runner PIDs, **0** `step-rt-*` units, **0** matching scope cgroups,
  **0** `/mnt/step-work/step-driver-test-*` folders and **0** test socket directories. Command failures were
  checked rather than treating an unsuccessful inventory query as empty.
- Remaining production blockers are unchanged: disk/inode quota acceptance, orphan-scope reconciliation,
  socket group/ACL provisioning, Gateway integration, and real-provider/secret acceptance. Gateway stays fail-closed.

## #57 · bounded host memory/task exhaustion acceptance (test-only increment on 5164f81)

- Added two opt-in tests at the existing RuntimeDriver/RuntimeHandle seams, using a disposable synthetic
  `fake-resources` entry. No production source, RuntimeManager/Gateway wiring, host configuration or permissions
  changed. `STEP_STEP_RUNNER_TESTS=1` remains mandatory; without it the entire host suite is explicitly skipped.
- Both tests verify effective `memory.max=201326592` (192 MiB), `memory.swap.max=0`, `pids.max=32` **before**
  sending the pressure request. Requested CPU quota is 50%. Test-host preflight showed 58,824 MiB available
  memory and no pre-existing step-runner processes/scopes; no host-wide OOM or uncontrolled fork test was used.
- Memory: one finite worker touches at most 384 MiB, exits within 10 seconds, and raises only its own
  `oom_score_adj` to prefer itself as the victim. The kernel must report `constraint=CONSTRAINT_MEMCG` and the
  exact random `oom_memcg` scope in its durable journal. Kernel-journal read access is checked before arming;
  no permissions are installed or granted. A SIGKILL alone cannot pass. On this host systemd ends the scope after
  the worker OOM (even though `memory.oom.group=0`), so the test accepts either the killed-worker reply or the
  driver's `RUNTIME_EXITED`, always requiring independent kernel evidence. Polling `memory.events.local` alone
  was insufficient because systemd can collect the cgroup before the next read; the journal avoids that race.
- Tasks: at most 48 sequential direct `/bin/sleep 15` attempts (no recursive process tree) must produce EAGAIN,
  increase this scope's `pids.events:max`, and remain at/below 32 tasks. IPC health survives; explicitly killing
  and reaping the children returns usage to baseline and a new `/bin/true` exits successfully in the same runtime.
- Safety/cleanup: 15-second host stop watchdog, 20-second fixture lifetime, 60-second test deadlines, `finally`
  stop, and the existing suite-wide tracked-handle cleanup. Scope emptiness plus absence of runner pids, units and
  socket directories is checked before starting the real synthetic runtime on the same workspace again. Memory
  recovery also completes `connect` and `ask`. The documented command adds an outer 180-second timeout.
- Red/green: memory and task assertions each failed against a non-pressure fixture, then passed with the bounded
  workload. Initial local worktree dependency symlinking caused bind permission failures; replaced with an
  untracked local dependency copy (no host permissions changed). No dependency or submodule pin changed.
- Verified with Node 26.12.1: full gated engine suite **238/238**, 0 failed/cancelled/skipped; standalone driver
  suite **21/21**; both pressure tests **2/2 in each of three consecutive repeat runs**; ungated standalone suite
  **4/4** with the host suite explicitly skipped. `npm run check`, `npm run build`, and `npm run check:engine-pin`
  passed; `npm test` **118/118**, database tests **29/29**. Existing server checker still reports 17 upstream
  engine diagnostics delegated to Desktop CI; Vite retains its large-chunk warning. No browser/UI code changed,
  so Playwright was not rerun for this test-only increment.
- Final independent live leak inventory: **0** step-runner pids, **0** `step-rt-*` units, **0** scope cgroups,
  **0** `/mnt/step-work/step-driver-test-*` folders (therefore no test socket directories left).
- Still blocked for production: workspace disk/inode quota acceptance, restart reconciliation of orphan scopes,
  socket group/ACL provisioning, production integration and real-provider/secret acceptance. No disk/inode
  exhaustion or host setup was attempted. Production Gateway remains fail-closed.

## #57 · step-runner driver review fixes (hostile early peers, stop errors, unknown scope state)

- Correction: the random socket folder name was described as secret. It is not: it appears in the command lines of
  `systemd-run`/`sudo`/`bwrap`, readable by every local user (`/proc/<pid>/cmdline`, no `hidepid`), and the root and
  folder are 0711 with the socket 0666, so any local user can connect. Path visibility remains. Making the socket root
  0700 plus a group or ACL for step-runner needs a host change (no `setfacl` installed; the service account is not in
  group `step-runner`) and is pending.
- Before, the driver accepted only the first connection, so any local process (uid 1000, or uid 995 outside a
  sandbox) that connected first aborted the start (`PEER_REJECTED`/`NONCE_MISMATCH`). Now the listener stays open
  until the start timeout. Every connection is checked as hostile: SO_PEERCRED must be uid step-runner before any
  byte is read (`pauseOnConnect`), then the first frame (max 4 KiB until trusted) must be `ready` with the launch
  nonce. A refused peer is destroyed without a reply and the driver keeps waiting. Bounds: at most 8 connections
  pending a check (more are dropped unread) and 32 refusals per launch, after which the start fails closed with
  `TOO_MANY_REJECTED_PEERS`. The first valid peer is accepted, the listener closes and the other pending
  connections are dropped. A start that fails after refusals reports the last refusal as `cause` (e.g.
  `NONCE_MISMATCH`, `FRAME_TOO_LARGE`). Remaining exposure until the host change: a local user can still abort one
  start by flooding (bounded cost), and an out-of-sandbox uid-995 process (only the service account can create one,
  through its sudo rule) could hold the 8 pending slots.
- Stop errors: a failing `cgroup.kill` write (anything but ENOENT) is `WorkspaceError('RUNTIME_STOP_FAILED')` with a
  `cause`, never a raw error, from `stop()` and forced `stopWithAdmission`; any teardown error is mapped the same way.
  `tmpfsBytes` is validated at construction (`INVALID_STEP_RUNNER_OPTIONS`).
- Unknown state: a non-zero `systemctl show` is unknown and retried until the deadline, never "gone"; if it stays
  unknown, stop fails (`RUNTIME_STOP_FAILED`) and a start becomes `RuntimeStartCleanupError`. After the processes are
  proven gone, `systemctl stop`/`reset-failed` run and the result is judged by asking systemd afterwards (both commands
  fail harmlessly when systemd already collected the empty scope); the outcome is on `handle.scope.unitCleanup`
  (`'done'`/`'failed'`, with `unitCleanupFailures`). `'failed'` never means the runtime may run; a later `stop()`
  retries only the unit removal. A crash whose emptiness proof fails keeps the handle and does not fire `onExit`;
  a later `stop()` retries kill and proof.
- Fault injection for tests only: optional second argument `stepRunnerDriver(options, hooks)` replaces `systemctl`,
  the `cgroup.kill` write and the `cgroup.events` read; it is not part of the options.
- New tests (test-first; all 7 were red on 145c36e): `tmpfsBytes` options; host: a uid-1000 process and two
  out-of-sandbox uid-995 processes (one wrong nonce, one silent) connect before the runtime is even spawned, receive
  0 bytes and are closed, and the genuine start succeeds; 40 uid-1000 connections → `TOO_MANY_REJECTED_PEERS`;
  `cgroup.kill` EACCES → `RUNTIME_STOP_FAILED` then a retry stops it; failing `show` → `RuntimeStartCleanupError`
  then `handle.stop()` cleans up; failing `stop`/`reset-failed`/`show` → `unitCleanup: 'failed'` with the runtime
  proven stopped, then `'done'` on retry; crash with a failing proof → no `onExit`, then `stop()` succeeds. The old
  "uid-1000 peer → PEER_REJECTED" test is replaced by the hostile-peer test.
- Results (Node 26.12.1, this host): `npm run check` ok; `npm test` 118/118; `npm run test:db` 29/29;
  `npm run test:engine` 221/221 (host suite skipped explicitly); `STEP_STEP_RUNNER_TESTS=1 npm run test:engine`
  236/236; step-runner suite alone 19/19 in five consecutive runs; afterwards `pgrep -u step-runner` empty, no
  `step-rt-*` unit, no test folder.

## #57 · step-runner driver: runtime as uid `step-runner`, own scope, socket channel, cgroup.kill stop

- New `server/src/workspace/step-runner-driver.ts` (`stepRunnerDriver`), not wired into the Gateway entry, which
  stays fail-closed. Each start: random never-reused unit `step-rt-<128-bit>.scope` via
  `systemd-run --user --scope -p MemoryMax -p MemorySwapMax=0 -p TasksMax -p CPUQuota`, then
  `sudo -n -u step-runner /usr/bin/bwrap --clearenv --setenv …` with the same mounts as isolated `processDriver`
  plus `--cap-drop ALL`. Synthetic provider only (`STEP_SYNTHETIC_PROVIDER=1` is forced). `appRoot` and `nodePath`
  are explicit options; nothing is derived from the gateway's own location.
- Channel: a fresh random socket directory (0711) per launch under a socket root checked before spawn (ours, no
  group/other read/write), bound read-only into that one sandbox at `/run/step-runtime`. The folder name is **not**
  secret (see the review fixes above: it is in `/proc/<pid>/cmdline`). Exactly one valid peer is accepted, then the
  listener closes (Node unlinks the path). Node has no SO_PEERCRED
  API, so a one-line `python3 -I -S` helper reads it from the accepted socket handed over as stdin; uid must equal
  step-runner. The runtime must echo a 256-bit launch nonce in its first frame (`ready`), compared with
  `timingSafeEqual`. The nonce goes over **stdin** (sudo-rs passes the pipe through, no pty), not argv/env, which
  other local users can read via `/proc/<pid>/cmdline` and the unit description. Newline-delimited JSON frames with
  a max size (default 8 MiB, `server/src/workspace/frames.ts`); oversize/invalid frames end the runtime.
  `runtime-main.ts` speaks this transport when `STEP_RUNTIME_SOCKET` is set and keeps fork IPC otherwise.
- Stop: graceful request = end the socket; after the grace period, `cgroup.kill` on the scope; resolved only after
  proof (`populated 0` or the kernel removed this never-reused cgroup), then `systemctl --user stop` and
  `reset-failed`. Exit of the systemd-run/sudo process is never taken as proof. No proof within the bound →
  `RUNTIME_STOP_FAILED` (stop) / `RuntimeStartCleanupError` (start), and `onExit` is not fired. Crash/channel loss
  fails calls in flight with `RUNTIME_EXITED`, then the same kill-and-prove runs before `onExit`.
- Tests (`server/test/step-runner-driver.test.ts`): 4 always-run unit tests (frames, option validation, launch argv,
  unsafe socket root) and 10 host tests gated by `STEP_STEP_RUNNER_TESTS=1` (explicit skip otherwise): runs as
  uid 995 and answers `health`/`connect`/`ask`; limits in the scope (`memory.max`, `memory.swap.max`, `pids.max`,
  `cpu.max`); a second sandbox cannot see the first one's workspace, socket folder, socket root or `/home`, cannot
  connect to its socket, and neither running sandbox's mountinfo names the other; uid-1000 peer → `PEER_REJECTED`;
  wrong nonce → `NONCE_MISMATCH`; oversized frame → `FRAME_TOO_LARGE`; a TERM-ignoring detached `setsid` descendant
  of a runtime that ignores shutdown is killed by `cgroup.kill` with emptiness proven (and uid 1000 gets `EPERM`
  signalling it); SIGSTOP+SIGKILL of the runtime → in-flight call `RUNTIME_EXITED`, scope emptied; skipped,
  denied, and after-spawn-revoked start admission leave no process/unit/socket; denied stop keeps it healthy.
  Every host test asserts afterwards: no new `pgrep -u step-runner` pid, no `step-rt-*` unit, empty socket root.
- Host tests copy `node_modules`, `harness`, `server/src`, both `package.json` and the Node binary into
  `mktemp -d /mnt/step-work/step-driver-test-XXXX` (step-runner cannot read `/home/itsara`); the synthetic
  workspace folder is 0777 **for the disposable test only**. Production needs a root-run setup step: root-owned
  world-readable app + Node (e.g. `/opt/step`), and workspace folders owned by a shared group of the service
  account and step-runner instead of 0777. Runtime files are owned by uid 995, so the test removes them through a
  step-runner bwrap before deleting its folder.
- Results (Node 26.12.1, this host): `npm run check` ok; `npm test` 118/118; `npm run test:db` 29/29;
  `npm run test:engine` 221/221 (host suite skipped explicitly); `STEP_STEP_RUNNER_TESTS=1 npm run test:engine`
  231/231; step-runner suite alone 14/14 in three consecutive runs; afterwards no step-runner process, unit or test
  folder remained.
- Not done / gaps: not wired into Gateway or RuntimeManager config; real providers and secrets untested by design;
  workspace disk quota (XFS project quota helper), memory/pids exhaustion behaviour and recovery of scopes left by
  a crashed gateway (startup sweep of `step-rt-*`) are open; peer-credential check depends on `/usr/bin/python3`;
  all sandboxes share uid 995, so separation between workspaces rests on bwrap mount/PID/IPC/network namespaces.

## #57 · opt-in bounded private tmpfs (integration port)

- Port เฉพาะ `tmpfsBytes` validation, Bubblewrap `--size … --tmpfs /tmp`, opt-in
  capability drop และ targeted tests จาก followup ที่อ่านอย่างเดียว คง lifecycle,
  start/stop admission, stop timeout และ confirmed cleanup ของ integration เดิม
  ไม่เปิดจาก environment หรือ production Gateway และไม่ใช่ Workspace disk quota
- Red-green: validation/arguments ล้มเหลวก่อนแก้และผ่านหลังแก้; targeted tmpfs ผ่าน 3/4
  อีก 1 isolation test ล้มเหลวเพราะ sandbox ไม่อนุญาต user namespace ไม่ skip หรือถือว่าผ่าน
  ผล ENOSPC จริง/ลบแล้วเขียนใหม่บน host นอก sandbox เป็นผลที่ผู้ใช้รายงาน ไม่ใช่ผลรันซ้ำที่นี่
  และไม่ได้พิสูจน์ Workspace quota หรือ production isolation
- Nearby startup timeout/cleanup/stop admission ผ่าน 19 tests; `npm run check` ผ่าน frontend
  tsc แต่ server checker ติด spawnSync EPERM (Node 22.22.1; repo ต้องการ >=24)
  ไม่รันซ้ำหรือ bypass combined prettier+check ที่เคยถูก lifecycle scan guard ปฏิเสธ
  ไม่รับรอง readiness; full required checks และ real-account/deployment acceptance ยังไม่ครบ
  ไม่มี production, secrets, GitHub, การเขียน worktree อื่น, commit หรือ push

## #58 · Gateway invitation management (partial)

- Admin invitation expiry review: เพิ่ม synchronous credential validity check ภายใน transaction
  `BEGIN IMMEDIATE` ของ `InvitationStore.change` หลังได้ writer lock ก่อนตรวจ admin/live invitation
  และ mutation; body/base-file reads รอให้จบนอก transaction ไม่ซ้อน dispatch transaction และไม่ถือ lock
  ข้าม await คง deny/allow และ authorization เดิม ตรวจ expiry จาก signed claims ด้วย floor seconds
  และ inclusive skew 60 วินาที การเปลี่ยน operator-file ยังไม่ atomic: ใช้ snapshot ที่อ่านก่อน lock
  การแก้ไฟล์ภายนอก SQLite อาจเกิดหลังอ่าน snapshot; ต้องใช้ cooperating writers กับ SQLite เดียวกัน
- Red-first regression ใช้ synthetic RS256 token และ controlled clock: ก่อนแก้ 4 expired cases คืน 401
  แต่เปลี่ยน invitation แล้ว หลังแก้ 8 cases ผ่าน ทั้ง grant/revoke, body/base read และ skew boundary
  เพิ่ม writer-lock/committed actor revocation/authorization/rollback-release checks รวม targeted auth
  14 tests ผ่าน Node 24.22.2; direct database isolation 29 ผ่าน และ build ผ่าน ไม่มี server type diagnostic
  (มี 17 diagnostics เดิมใน pinned Harness) Required npm check/engine-pin ติด subprocess EPERM;
  npm unit/db/engine ติด tsx IPC EPERM; direct combined unit/engine abort ใน Node callback assertion
  formatting ผ่าน; workspace-runtime isolation ล้มเหลว 4 tests จาก sandbox namespace ไม่ถือว่าผ่าน
  Playwright cloud-workspace เริ่ม configured web server ไม่สำเร็จ ยังไม่ประกาศพร้อมใช้งาน
  เก็บ uncommitted work เดิมทั้งหมด ไม่มี production, secrets, GitHub, worktree อื่น, commit หรือ push

- Startup error review: คง admission error object เดิมหลังยืนยัน cleanup สำเร็จ ทั้ง spawn และ connect;
  token หมดอายุ/ถูกถอนสิทธิ์คืน UNAUTHENTICATED และ HTTP 401 แทน RUNTIME_START_FAILED
  process-driver คืน cause เดิมหลังยืนยัน child exit ส่วน cleanup ที่ยังไม่ยืนยันยังใช้ error แบบ sanitized
  และ diagnostic RUNTIME_START_CLEANUP_FAILED พร้อมเก็บ handle/capacity ตามเดิม ไม่เปิดสิทธิ์หรือ retry connect
- Deterministic regressions ล้มเหลวก่อนแก้และผ่านหลังแก้: real SQLite deferred COMMIT ยืนยัน object เดิม
  ผ่าน direct driver, manager → process-driver และ connect/shared waiter พร้อม rollback/confirmed exit;
  ระหว่างรอ cleanup ยังปฏิเสธ runtime ใหม่ด้วย capacity และเมื่อ cleanup ล้มเหลวยังไม่เปิด capacity
  expiry มี/ไม่มี invitation store คืน 401 และ revocation ไม่ส่ง credential, authorized waiter ยังตรวจสิทธิ์ตนเอง
- Node 24.22.2: targeted startup/cleanup/stop/publication ผ่าน 46 tests, auth/dispatch ที่เกี่ยวข้องผ่าน 16,
  direct database isolation ผ่าน 29; build และ repository formatting ผ่าน Direct server types มีเพียง
  17 diagnostics เดิมใน pinned Harness ไม่มี server diagnostic npm check/engine-pin ติด subprocess EPERM;
  npm unit/db/engine ติด tsx IPC EPERM, direct unit abort ใน Node async callback assertion;
  runtime suite ผ่าน 13 แต่ isolation ล้มเหลว 4 เพราะ Bubblewrap สร้าง namespace ไม่ได้ ไม่ถือว่าผ่าน
  Playwright cloud-workspace เริ่ม configured web server ไม่สำเร็จ ยังไม่รับรองพร้อมใช้งานหรือ deployment
  เก็บงานเดิมทั้งหมด ไม่ใช้ production, real accounts, secrets, GitHub, worktree อื่น, commit หรือ push

- Independent review follow-up: คง runtime error object เดิมเมื่อ completion metadata ล้มเหลวด้วย;
  secondary failure ส่ง diagnostic แบบไม่ใส่ข้อมูล private ส่วน bookkeeping failure หลัง runtime สำเร็จ
  ยังส่ง error ให้ caller ไม่แปลงเป็น success เมื่อ admission COMMIT ล้มเหลวหลัง enqueue จะส่ง error
  ทันที แต่เก็บ busy/active-call จนทุก Promise ที่ส่งแล้ว settle; cancel acknowledgement ติดตามด้วย
  RunService แสดง admission code ระหว่างยัง running และเก็บ session reservation จน settlement
  จึงปฏิเสธ successor ระหว่างงานเดิม และอนุญาต successor หลังจบ โดยไม่ retry งานที่อาจมีผลแล้ว
- Deterministic checks ใช้ real deferred SQLite COMMIT failure: dispatch 11/11 ผ่าน รวม successor
  ผ่าน RunService → manager → runtime และ original runtime vs bookkeeping error; related manager
  31/31 และ database isolation 29/29 ผ่านด้วย Node 24.22.2, build/format ผ่าน direct server types
  มีเฉพาะ pinned-Harness diagnostics เดิม npm check/engine-pin ติด subprocess EPERM; npm unit/db/engine
  ติด tsx IPC EPERM, direct unit abort ใน Node async callback assertion; Playwright เริ่ม web server ไม่สำเร็จ
  workspace-runtime isolation ยังล้มเหลวจาก Bubblewrap namespace ไม่ถือว่าผ่านหรือพร้อมใช้งาน
- หาก runtime ไม่ settle จะเก็บ reservation ต่อไปโดยไม่รอใน admission-error response; stop/shutdown
  ยังเป็นทาง cleanup ที่มีอยู่ ไม่มี timeout ที่สรุปผิดว่าผลข้างเคียงถูกยกเลิก งานอาจสร้างคำตอบแล้วแม้ admission
  ล้มเหลว ไม่มี automatic replay และไม่อ้างว่า rollback SQLite ย้อนผล IPC ได้ เก็บ uncommitted work เดิม
  ไม่ใช้ production, remote, secrets, worktree อื่น, commit หรือ push

- แก้ unhandled rejection หลัง enqueue `messages`, `newConversation`, `ask` และ `cancel` เมื่อ
  admission COMMIT ล้มเหลว โดยติด handler ภายใน synchronous send ก่อนกลับเข้า fence และคืน Promise
  เดิมเพื่อคง runtime error; ใช้ helper เดียวกับ connect ตรวจ process-driver start/stop แล้วไม่มี Promise
  enqueue ที่ขาด handler แบบเดียวกัน เก็บ tests และ uncommitted work เดิมทั้งหมด
- Regression ใหม่ 8 cases ใช้ SQLite deferred foreign key ให้ COMMIT ล้มเหลวจริงหลัง enqueue แล้วค่อย
  reject runtime หลัง admission คลายออก ยืนยัน error object เดิม, rollback, enqueue ครั้งเดียว, runtime
  ยังทำงานและ busy กลับเป็นศูนย์ รวม runtime rejection เมื่อ COMMIT สำเร็จ ก่อนแก้พบ unhandled rejection
  ครบทั้งสี่ dispatch paths; หลังแก้ผ่านทั้ง 8 cases ด้วย Node 24.22.2 และ targeted เดิมอีก 48 tests ผ่าน
  แบบแยกไฟล์ Cross-process start ติด localhost EPERM; stop reproduction และ combined run abort ภายใน
  Node async callback assertion ไม่ถือว่าผ่าน `npm run check` ติด spawnSync EPERM; direct server types
  มีเพียง 17 diagnostics เดิมใน pinned Harness ไม่มี server diagnostic และ repository formatting ผ่าน
  ยังไม่รับรองพร้อมใช้งาน ไม่ทดสอบ real accounts/deployment และไม่ใช้ production, secrets, GitHub,
  worktree อื่น, commit หรือ push

- แก้ผล independent review ของ shared start: เมื่อ token ผู้เริ่มหมดอายุก่อน enqueue `connect`
  และยืนยันว่า process ถูกเก็บกวาดแล้ว จะคืน reservation ให้ waiter ตรวจสิทธิ์ของตนเองและเริ่มใหม่
  waiter ที่หมดอายุยังถูกปฏิเสธ; cleanup ที่ล้มเหลวยังเก็บ handle, capacity และ diagnostic เดิม
  ไม่ retry อัตโนมัติเมื่อส่ง connect แล้ว หรือเมื่อ connect reject/timeout
- ติด rejection handler ของ connect Promise ภายใน synchronous send ก่อน admission COMMIT กลับมา
  เพื่อไม่ให้ rejection ภายหลังกลายเป็น unhandled เมื่อ COMMIT ล้มเหลว; Promise เดิมยังส่ง connect error
  ตามปกติ deterministic tests ทำให้ทั้งสอง bug ล้มเหลวก่อนแก้ รวม real SQLite deferred foreign-key
  constraint ที่ล้มเหลวตอน COMMIT หลัง enqueue และยืนยัน rollback, cleanup และไม่ retry shared waiter
- ตรวจด้วย Node 24.22.2: targeted auth/start/connect/cleanup/publication/stop ผ่าน 48 tests (รวม regression
  ใหม่ 7 tests), direct database isolation ผ่าน 29 tests, build และ formatting ผ่าน; direct server types
  มีเพียง 17 diagnostics เดิมใน pinned Harness ตาม checker policy ไม่มี server diagnostic
  `npm run check` และ engine-pin ติด subprocess EPERM; npm unit/db/engine ติด tsx IPC EPERM
  direct unit abort ที่ Node async callback assertion; ลอง engine ครบ 23 files แยกกัน ผ่าน 12 files
  ที่เหลือมี subprocess contention failure, localhost EPERM และ Node abort; isolation 4 tests ใน
  workspace-runtime ล้มเหลวเพราะ Bubblewrap สร้าง namespace ไม่ได้ ไม่ข้ามหรือถือว่าผ่าน
  Playwright cloud-workspace เริ่ม configured web server ไม่สำเร็จ จึงยังไม่รับรองพร้อมใช้งาน
  ไม่ได้ทดสอบ real accounts/deployment; เก็บ uncommitted work เดิม ไม่มี GitHub, production, secrets,
  การเขียน worktree อื่น, commit หรือ push

- แก้ช่องว่างส่ง provider credential หลังรอ grant: deterministic regression ยืนยันว่าเดิมส่ง `connect`
  หลังถอน invitation แล้วหนึ่งครั้ง; ขณะนี้ครอบ synchronous `RuntimeHandle.call(connect)` ด้วย admission
  ของผู้เริ่ม runtime และใช้ cleanup เดิมเมื่อถูกปฏิเสธ รวมถึงเก็บ handle/capacity หาก cleanup ยังไม่ยืนยัน
  การรอ grant และ connect response อยู่นอก SQLite transaction; ไม่เปลี่ยนอำนาจ invitation ข้าม process
- Google verifier ส่งเฉพาะ expiry จาก claims ที่ตรวจ signature แล้วให้ synchronous admission ทุกจุดของ
  Gateway ตรวจอีกครั้งภายใน fence (หรือโดยตรงเมื่อไม่มี invitation store) ใช้ `floor(now/1000)` และ
  skew 60 วินาทีตาม verifier เดิม ทดสอบขอบเขตวินาทีและหมดอายุระหว่างรอ grant ทั้งมี/ไม่มี store
  ข้อนี้ปรับข้อจำกัด token expiry ที่บันทึกไว้ก่อนหน้า; ไม่ทำให้ operator-file revocation เป็น atomic
- ตรวจด้วย Node 24.22.2: targeted auth/start/connect/cleanup/publication/stop ผ่าน 41 tests; database
  isolation ผ่าน 29 tests โดยรันตรง; build, frontend types และ formatting ผ่าน ส่วน server types มีเพียง
  17 diagnostics ใน pinned Harness ที่ checker policy เดิมแยกไว้ ไม่มี server diagnostic ใหม่
  `npm run check`, npm unit/database/engine wrappers และ engine-pin ยังติด subprocess/tsx IPC EPERM
  direct unit/engine รวม abort ที่ Node async callback assertion จึงลอง engine ครบทั้ง 22 files แยกกัน:
  11 files ผ่าน; ที่เหลือมี localhost EPERM, subprocess failure, Node abort และ 4 isolation tests ล้มเหลว
  เพราะ Bubblewrap สร้าง namespace ไม่ได้ ไม่ข้ามหรือถือว่า isolation ผ่าน Cloud Playwright เริ่ม web server
  ไม่สำเร็จ จึงยังไม่พร้อมรับรอง ไม่มี production/real-account acceptance และไม่ใช้ secrets, GitHub,
  เขียน worktree อื่น, commit หรือ push; เก็บงานค้างเดิมทั้งหมดไว้

- Start-fence review follow-up: deterministic regressions first reproduced a messages enqueue after revocation
  following the awaited start, and a metadata rename after revocation during asynchronous staging. Messages now
  fences the synchronous RuntimeHandle.call enqueue with each caller's authority; the contract requires synchronous
  enqueue. Metadata stages outside the lock and publishes by synchronous rename inside admission, updating the
  in-memory activity time only on publication. Tests cover both cold and already-running starts, temporary-file
  cleanup, independent caller admission and retaining the admitted runtime. Completion metadata is also fenced;
  a denied refresh is skipped so an already admitted run retains its result/error and is not cancelled by revocation.
- Follow-up verification with Node 24.22.2: 32 targeted start/stop/cleanup/publication tests and 29 direct database
  isolation tests passed, as did build, formatting and frontend types. Direct server types report only the existing
  17 pinned-engine diagnostics excluded by the checker policy. `npm run check` cannot spawn its server checker
  (EPERM); unit/database/engine npm wrappers cannot open tsx IPC, and engine-pin checking hits subprocess EPERM.
  A combined direct runtime/engine test run aborted on Node's async callback assertion; cloud Playwright could
  not start its configured web server. Full checks remain required before readiness. Existing tests and uncommitted
  start-fence work were preserved; no production, real accounts, GitHub operations, other worktrees or commits.
  The same shared-SQLite/cooperating-writer and operator-file/token-expiry limitations below still apply.

- Workspace start now fences the process driver's synchronous fork with invitation revocation, including
  starts reached through conversation creation, message reads and both run paths. Authentication is checked
  again after filesystem reads and shared-start waits; each waiter checks its own authority. A denied leader
  before spawn releases its reservation so an authorized waiter can retry. Unsupported drivers fail closed;
  readiness, provider setup and cleanup run outside the SQLite transaction. A post-spawn admission error
  triggers confirmed cleanup, retaining an unconfirmed handle/capacity through the existing cleanup path.
- Node 24.22.2 verification in this restricted worktree: a scratch baseline regression reproduced a revoked
  HTTP request returning 401 while still spawning; the changed code passes that regression. Socket-free
  start/cleanup regressions 17/17, related stop regressions 8/8 and direct database isolation tests 29/29 passed.
  Direct frontend/server type checks (excluding 17 pinned-engine diagnostics under the existing policy),
  formatting and production build passed. Required npm check/engine/unit/database wrappers and engine-pin
  checking hit sandbox EPERM on subprocess/IPC operations; the original cross-process HTTP regression cannot
  bind localhost. Cloud Playwright could not start its web server. An attempted combined unit run without
  subprocess isolation aborted inside Node's async callback assertion. Full engine, unit, cross-process HTTP,
  engine-pin and browser verification remain required; this change is not declared ready or committed.
- Admission orders cooperating gateways/administrators only when they use the same correctly locking SQLite
  database. Operator-file edits and token expiry cannot be atomic with this fence; admission before revocation
  can finish afterwards and revocation does not terminate an already admitted runtime. Runtime deduplication
  and capacity remain manager-local; no cross-gateway singleton, crash/orphan recovery or real-account,
  sandboxed-process or deployment acceptance is established by these synthetic checks. No production or
  external services were changed.

## #58 · Quota publication deadline (local, ยังไม่ ready)

- รักษา uncommitted changes บน branch เดิม ไม่มี commit/push/GitHub/production/secrets หรือ worktree อื่น
- Node 24.22.2: deterministic clock/wait regression จำลอง process กลับมาหลัง deadline 5 วินาที
  พร้อม policy ที่เพิ่ง publish ครอบคลุมทั้ง witness และ candidate → witness → policy;
  ก่อนแก้ล้มทั้ง 2 ข้อ (ไม่ throw) หลังแก้ผ่าน ตรวจ deadline ก่อนยอมรับ policy
  คง fail closed ไม่ recreate policy และตรวจ inode ว่า policy/witness เดิมยังอยู่ พร้อม retry ใหม่ได้
- Direct provisioning/policy/crash suite ผ่าน 48/48; build และ formatting ผ่าน
  direct server types ยังมี 17 Harness diagnostics เดิม ไม่มี server diagnostic
- เรียก npm check/test/test:db/test:engine และ Playwright identity-trial แล้ว:
  check ติด spawnSync EPERM, test runners ติด tsx IPC EPERM และ Playwright webServer เริ่มไม่ได้
  direct runner ใช้ --test-isolation=none เพื่อหลบ host subprocess restriction ไม่ได้ปิด workspace isolation
  ไม่เรียก check:engine-pin เพราะติดต่อ GitHub ตามข้อห้ามผู้ใช้ ไม่มี real-account/deployment acceptance

## #58 · Empty-root candidate interleaving (local, ยังไม่ ready)

- รักษา uncommitted changes บน branch เดิม ไม่มี commit/push/GitHub/production/secrets หรือ worktree อื่น
- Node 24.22.2: deterministic subprocess barrier หยุดผู้ชนะหลังสร้าง `.quota-init-*`
  ก่อน witness; control/output อยู่ข้างนอก data root และทั้งสอง initializer ไม่ใช้ onboarding flag
  ทดสอบกับ snapshot ก่อนแก้แล้วล้ม 2 ข้อด้วย `QUOTA_ONBOARDING_REQUIRED`; หลังแก้ limit ตรงสำเร็จ
  ทั้งคู่ และ limit ต่างปฏิเสธด้วย `QUOTA_POLICY_MISMATCH`
- Root ที่มีเฉพาะ candidate directories รอ publication ไม่เกิน 5 วินาทีรวมช่วง witness → policy
  ตรวจ witness ซ้ำหลัง directory scan เพื่อรองรับ publication/cleanup ระหว่าง scan
  ไม่อ่าน candidate และไม่ใช้ชื่อ directory เป็นอำนาจ: forged/stale directory, file, symlink,
  root ที่มีข้อมูลอื่น และ candidate ที่หายระหว่างรอไม่สร้าง policy; lost policy ยัง fail closed
  README บันทึก timeout/error และ retry หลังผู้ชนะจบไว้แล้ว
- Direct provisioning 38/38, policy 5/5, crash 3/3, database isolation 10/10 และ build ผ่าน
  บน Node 24.22.2; direct server types มีเพียง 17 Harness diagnostics เดิม ไม่มี server diagnostic
- เรียก npm check/test/test:db/test:engine และ Playwright identity-trial แล้ว: spawnSync/tsx IPC
  ถูก EPERM และ Playwright webServer เริ่มไม่ได้; direct cross-process/race/regressions ถูก host abort
  ไม่ถือว่าผ่านหรือข้าม isolation; ไม่รัน check:engine-pin เพราะติดต่อ GitHub ตามข้อห้ามผู้ใช้
  ไม่มี real-account/deployment acceptance และยังไม่พร้อม ready

## #58 · Concurrent provisioning link interleaving (local, ยังไม่ ready)

- รักษา uncommitted changes บน branch เดิม ไม่มี commit/push/GitHub/production/secrets หรือ worktree อื่น
- Node 24.22.2 (default Node 22.22.1 ไม่ถึง requirement): deterministic subprocess barrier
  หยุดผู้ชนะหลัง witness link ก่อน policy link แล้วเริ่ม initializer อีกตัว; red ได้
  `QUOTA_POLICY_REQUIRED` ทั้ง limit ตรงและต่างกัน แม้ผู้ชนะสำเร็จ
- รวม bounded observation wait 5 วินาทีสำหรับทั้ง witness ที่เห็นตอนเข้า init และ EEXIST
  ตรวจ inode witness/paths ซ้ำ ไม่สร้าง policy จาก witness; ordinary startup ยัง fail closed ทันที
  crash/established policy ที่หายยังปฏิเสธหลัง deadline ไม่มีการ repair/reset
  README อธิบาย retry หลังผู้ชนะจบและ recovery เมื่อสูญหาย เพราะแยก slow/crash/deletion ไม่ได้
- แยก stdout จาก warning stderr ใน concurrent provisioning และ crash subprocess tests
- provisioning 31/31, policy 5/5 และ crash 3/3 ผ่าน; build ผ่าน บน Node 24.22.2
  direct quota cross-process/race/regressions ถูก host abort ไม่ถือว่าผ่าน
- เรียก npm check/test/test:db/test:engine และ Playwright identity-trial แล้ว:
  spawnSync/tsx IPC EPERM และ webServer เริ่มไม่ได้; ไม่ skip isolation หรืออ้าง suite เต็มผ่าน
  ไม่รัน check:engine-pin เพราะเรียก GitHub ซึ่งผู้ใช้ห้าม ไม่มี real-account/deployment acceptance

## #58 · Quota onboarding review follow-up (local, ยังไม่ ready)

- รักษางาน uncommitted ทั้งหมดบน branch เดิม ไม่มี commit/push/GitHub/production/secrets หรือ worktree อื่น
- Node 24.22.2 red-first: subprocess exit ทันทีหลัง hard-link witness ของ legacy policy ที่ limit ไม่ตรง
  ทำให้ startup ยอมรับ policy เดิม และ recursive mkdir สร้าง descendant ผ่าน symlink แม้ init ปฏิเสธ
  ทั้งสอง regression ล้มก่อนแก้และผ่านหลังแก้
- Legacy onboarding ตรวจ inode, table, row และ limit ภายใต้ SQLite write lock ก่อน publish witness
  ด้วย hard link แบบไม่ทับของเดิม ไม่มี provisional witness และไม่ลบ witness ที่ reader อาจเห็นแล้ว
  crash ก่อน link ยังไม่ให้อำนาจ; crash หลัง link ใช้ได้เฉพาะ policy ที่ผ่าน validation
  ไม่พึ่ง rename หรือสมมติว่าไม่มี initializer พร้อมกัน
- ตรวจ ancestor ที่มีอยู่ก่อนเขียน แล้วสร้าง directory ทีละระดับและตรวจซ้ำ ปฏิเสธ symlink โดยไม่สร้าง descendant
  ยังไม่ fence hostile filesystem swaps ระหว่าง syscall หรือรับประกัน power-loss durability
- Provisioning 29/29 ผ่าน รวม subprocess crash, reader ก่อน publication และ initializer พร้อมกัน
  ของ root ใหม่/legacy ทั้ง limit ตรงและต่างกัน; build ผ่าน บน Node 24.22.2
- npm check ติด spawnSync EPERM; npm test/test:db/test:engine ติด tsx IPC EPERM;
  direct server types มีเฉพาะ 17 Harness diagnostics เดิม ไม่มี server diagnostic
  Playwright identity-trial เริ่ม webServer ไม่ได้; ไม่เรียก check:engine-pin เพราะติดต่อ GitHub
  ขัดขอบเขตผู้ใช้ ไม่มี real-account/deployment acceptance และยังไม่พร้อม ready
- Direct database 29/29 ผ่าน; unit ที่ไม่ใช้ HTTP ผ่าน 111 ข้อ ส่วน gateway-host abort
  เรียก engine ทุกไฟล์โดยตรงแล้ว: HTTP/child process บางไฟล์ abort หรือ listen EPERM;
  isolation ยังล้ม 4 ข้อจาก host loopback/namespace ไม่ได้ skip/ปิด isolation
  shutdown-cleanup ล้ม 1 ครั้งด้วย RUNTIME_MANAGER_SHUTTING_DOWN และ rerun ผ่าน 5/5 จึงบันทึกเป็น intermittent

## #58 · Security follow-up: quota provisioning (local, ยังไม่ ready)

- เก็บงาน uncommitted เดิมไว้บน branch เดิม ไม่มี commit/push/GitHub/production/secrets หรือ worktree อื่น
- Node 24.22.2 red-first: regression ใหม่ล้ม 3 ข้อก่อนแก้ ได้แก่ init limit 1 → ลบ DB → init limit 9,
  symlink policy ไปอีก root และ populated root ที่ไม่มีการยืนยัน onboarding
- เพิ่ม `.workspace-quota-established` เป็น hard-link witness ก่อน publish policy: init และ ordinary startup
  ปฏิเสธ policy ที่หาย รวม retry หลัง process ล้มระหว่าง witness กับ policy ไม่ใช้ witness ซ่อม DB อัตโนมัติ
  populated/legacy root ต้องยืนยัน exact absolute root ผ่าน `--onboard-existing-root <absolute-root>`
  และไม่สามารถ override witness เดิมได้; restore/destructive recovery เป็น operator workflow แยกใน README
- ทุก policy boundary ตรวจ ancestor directory, policy, witness และ SQLite sidecars ปฏิเสธ symlink/unsafe types
  ถือ O_NOFOLLOW descriptor และตรวจ inode ก่อน/หลัง SQLite open รวมก่อน publish; deterministic path-swap test ผ่าน
  ไม่รับประกันป้องกัน privileged filesystem attacker, path race ทุก syscall หรือ power-loss durability
- Crash-after-rename test provision ครั้งเดียวก่อน child เริ่ม แล้ว ordinary restart โดยไม่ provision
  ยืนยัน Workspace เดิมยังนับ quota และ DB ที่ถูกลบทำให้ restart ล้ม; crash ระหว่าง initial transaction
  ตรวจ ordinary startup ล้มโดยไม่เรียก provisioning เพื่อกลบ policy ที่หาย
- ตรวจโดยตรง: provisioning 24/24, crash 3/3, quota policy 5/5; unit ที่ไม่ใช้ HTTP 113/113,
  database 29/29, build และ formatting ผ่าน; server types มีเฉพาะ 17 Harness diagnostics เดิม ไม่มี server diagnostic
- เรียก npm check/test/test:db/test:engine แล้ว: host ปฏิเสธ spawnSync/tsx IPC ด้วย EPERM
  direct engine ทุกไฟล์ถูกรัน: บาง HTTP/child-process abort หรือ listen EPERM; isolation ยังล้ม 4 ข้อจาก
  Bubblewrap namespace ใช้ไม่ได้ ไม่ skip/ปิด isolation; Playwright identity-trial เริ่ม webServer ไม่ได้
  ไม่รัน check:engine-pin เพราะ wrapper เรียก GitHub ls-remote ซึ่งผู้ใช้ห้าม งานยังไม่พร้อม ready
  ต้องยืนยัน suite เต็มบน host ที่รองรับ ไม่มี real-account/deployment acceptance

## #58 · นโยบาย quota ร่วมของ Workspace (รอตรวจทาน)

- Follow-up ของผล parent (122 tests, 9 failures): บน Node 24.22.2 ทำซ้ำได้ว่า fixture
  `withGateway` และ restart test ยังไม่ได้ provision policy ก่อนสร้าง RuntimeManager
  แก้ fixture ให้ provision ตาม quota ของแต่ละ test; restart provision ครั้งเดียวก่อน startup แรก
  และ cleanup รองรับ startup ที่ล้มโดยไม่กลบ error เดิม ไม่เปลี่ยน production fail-closed policy
- ตรวจ follow-up: policy/provisioning 12/12, unit ที่ไม่ใช้ HTTP 113/113, database 29/29,
  build และ formatting ผ่าน; frontend types ผ่าน, server ไม่มี diagnostic นอก Harness (17 ข้อเดิม)
  targeted HTTP หลังแก้ abort ใน Node callback scope; loopback probe ยืนยัน `listen EPERM`
  รัน engine ทั้ง 23 ไฟล์แยกกันแล้ว แต่ HTTP/child-process บางไฟล์ abort หรือถูก host ขัดขวาง
  isolation ยังล้ม 4 ข้อจาก loopback/namespace ที่ใช้ไม่ได้ ไม่ปิดหรือข้าม isolation tests
  npm check ถูก spawnSync EPERM; npm test/test:db/test:engine ถูก tsx IPC EPERM;
  Playwright cloud เริ่ม webServer ไม่ได้ ยังต้องยืนยัน gateway suite บน host ที่รองรับ
  ไม่รัน engine-pin wrapper เพราะเรียก GitHub (`ls-remote`) ซึ่งอยู่นอกขอบเขตที่ผู้ใช้อนุญาต
- แยก operator provisioning (`npm run workspace:quota:init -- <data-root> <limit>`) จาก startup
  ของ Gateway/RuntimeManager; startup และ publication เปิด SQLite ด้วย `mode=rw` ที่ไม่สร้างไฟล์
  การลบ policy ที่ใช้งานแล้วจึงไม่ทำให้เริ่มใหม่ด้วย limit เดิมหรือต่างกันได้ และ manager เดิมก็ publish ไม่ได้
  policy เสีย/ไม่มี row ไม่ถูกซ่อมอัตโนมัติ คำสั่ง provisioning ไม่ทับ policy เดิมและตรวจ limit ที่ผู้ชนะกำหนดไว้
- Provisioning ใช้ private candidate ที่ commit/close ก่อน hard link แบบไม่ทับไฟล์ เพื่อรองรับผู้ดูแลเริ่มพร้อมกัน
  limit เดียวกันสำเร็จทั้งคู่; limit ต่างกันยอมรับเพียง policy เดียว อีกคำสั่งปฏิเสธ
  invitation/owner fences เดิมยังอยู่ ไม่มี SQLite lock ข้าม await; fixture สังเคราะห์ provision อย่างชัดเจน
  ดู workflow สำหรับ root ใหม่, migration ครั้งแรก, backup/recovery และการหยุด writer ใน `server/README.md`
- Red-first บน Node 24.22.2 พบ startup สร้าง policy เองและไฟล์ที่ถูกลบยอมรับ limit ใหม่ก่อนแก้
  หลังแก้ focused policy tests 12/12 ผ่าน รวม manager ที่มี Workspace แล้ว, corruption, missing row,
  explicit init, mismatch และ barrier ระหว่าง OS processes ก่อน publish; CLI init/repeat/mismatch ตรวจแล้ว
- Node 24.22.2: build ผ่าน; direct unit 113 ผ่าน (ไฟล์ gateway-host ถูก host ขัดขวาง), direct database 29/29 ผ่าน
  direct frontend types ผ่าน และ server types ไม่มี diagnostic ของ server (มี 17 diagnostic ของ Harness
  ที่ wrapper เดิมเว้นให้ Desktop CI); formatting ผ่าน การรัน npm check/test/test:db/test:engine ตามปกติ
  ถูก `EPERM` ของ spawnSync/tsx IPC ขัดขวาง; direct HTTP tests พบ loopback listen `EPERM` และบาง process
  abort ใน Node callback scope ไม่ถือว่าผ่าน Engine isolation tests ล้ม 4 ข้อเพราะ Bubblewrap เปิด namespace ไม่ได้
  ไม่ข้าม/ปิด isolation tests; Playwright cloud เริ่ม webServer ไม่สำเร็จใน host นี้
  engine-pin wrapper ถูก spawnSync `EPERM` ขัดขวาง ไม่ตรวจ remote GitHub ตามขอบเขตงานนี้
- ยังไม่พร้อมเรียกว่า ready: ต้องรัน suite เต็มและ isolation/Playwright อีกครั้งบน host ที่รองรับ
  ไม่มีการใช้บัญชีจริง, production acceptance, secrets, GitHub, push, deploy หรือ commit ในงานนี้
  การซ่อม policy ต้องหยุด writer และกู้ backup ที่ตรวจสอบแล้ว ไม่ใส่ init ใน restart loop
  operator file replacement ระหว่าง writer เปิด SQLite และ power-loss durability ของ filesystem ไม่ได้ถูก fence

## #58 · Gateway invitation management (partial)

- Workspace creation now checks the verified Google ID token's expiration synchronously inside the SQLite
  invitation fence immediately before publication. The signed-token HTTP regression first reproduced a 401
  with a published workspace, then verified denial and staging cleanup. This matches the existing verifier's
  inclusive 60-second clock skew, not strict JWT expiry; time can advance between the check and rename.
  Custom authenticators lack this synchronous expiry guarantee. Google token verification is local signature
  and claim verification, not an external token-revocation check. Operator-file changes are not fenced.
  Node 26.12.1: unit 117, database 29, engine 98, check, build and engine-pin passed; Playwright 86 passed,
  two mobile cloud cases skipped. Real accounts and deployment were not tested.

- Workspace creation prepares a private, non-listable staging directory and publishes it with a synchronous
  rename inside the invitation SQLite fence. A synthetic HTTP regression reproduced a revoked request creating
  a workspace before this change; tests also cover denial after preparation, cleanup, concurrent creations and
  uncertain errors after publication. A creation published before revocation remains valid even if its response
  fails. A crash can leave an invisible staging directory; no crash recovery has been added. This ordering
  requires cooperating gateways sharing the same correctly locking SQLite database, and does not fence external
  operator-file edits. The pre-existing workspace quota check is not atomic across concurrent creates.
  Node 26.12.1: engine 96, unit 117, database 29, check, build and engine-pin passed; cloud Playwright desktop
  2 passed and mobile 2 skipped. No real accounts or deployment were tested.

- A runtime whose startup and cleanup both fail remains failed and reserves capacity until exit or a successful
  stop/shutdown retry; owner diagnostics distinguish the cleanup failure without exposing provider errors. Synthetic
  driver tests cover concurrent shutdown and retry; manager crashes and orphan cleanup across restarts remain open.
  Node 26.12.1: engine 82, unit 117, database 29, check, build and engine-pin passed; Playwright 86 passed,
  two skipped using scratch copies of missing Chromium libraries. No real accounts or deployment were tested.

- Workspace stop now reauthenticates after pending starts and fences the process driver's synchronous
  disconnect/signal with invitation revocation; the SQLite transaction ends before waiting for process exit.
  Unsupported drivers fail closed for gateway stops; trusted idle/shutdown cleanup remains available. Concurrent
  requests check authority separately. If a stop may have signalled before failing, its handle remains reserved
  in failed state until exit or a successful cleanup retry; starts cannot reuse or replace it in the meantime. Ordering depends on all
  administrators and gateways using the same correctly locking SQLite store. A stop admitted before revocation
  may complete afterwards; operator-file changes cannot be made atomic with this SQLite fence.
- Local Node 26 checks: engine 74/74, unit 117/117, database 29/29, build, check and engine-pin passed;
  Playwright 86 passed and 2 mobile cloud cases were skipped. Chromium required local scratch copies of missing
  system libraries. Real accounts and production deployment were not tested.

- Added admin-only list, invite and revoke HTTP operations backed by durable SQLite denials under the
  operator invite file allowlist. Domain validation, fixed operator-managed admin roles and owner-only Workspaces
  prevent privilege escalation; revocation denies subsequent authentication. See `server/README.md`
  for override precedence, failure behavior and operational constraints.
- Synthetic HTTP and signed-token tests cover ordinary-user denial, domain/role validation, private
  Workspace isolation, revocation of file-based invitations, reinvitation and reopening the store.
- Still open: admin UI, email delivery, expiry, target-identifying audit, cancellation of existing runs
  on revocation, real Google accounts, gateway process restart, and production acceptance.
- Run cancellation now uses the same invitation SQLite fence at synchronous runtime IPC enqueue. A synthetic
  HTTP test first reproduced cancellation after another process committed revocation, then passed with the fence.
  A cancel enqueued before revocation may still take effect afterwards; revocation does not cancel running work.
  This ordering requires cooperating processes sharing the same correctly locking invitation database.
  Node 26.12.1 checks: engine 65/65, unit 117/117, database 29/29, check, build and engine-pin passed.
  Cloud Playwright: two desktop tests could not launch without `libatk-1.0.so.0`; two mobile tests skipped.
  Node reported a `module.register()` deprecation; the build reported a large-chunk warning.
- Direct and implicit run-preparation conversation creation now use the invitation SQLite fence at the
  synchronous runtime IPC enqueue. Two synthetic HTTP tests first reproduced a conversation created after
  revocation during runtime startup, then passed with the fence. This ordering requires all gateway and admin
  processes to share the same correctly locking database. An enqueue before revocation can still create a
  conversation afterwards; runtime startup and workspace start remain unfenced (create and stop are fenced as described above).
  Local checks: engine 64/64, unit 117/117, database 29/29, check, build and engine-pin passed using
  Node 22.22.1 (below the project's >=24 requirement; SQLite emitted experimental warnings). Cloud Playwright
  desktop could not launch without `libatk-1.0.so.0`; both mobile cases were skipped by the suite.
- The operator file is authoritative even for previously managed grants; private SSE events and ordinary
  responses reauthenticate before delivery. Idle streams are not proactively closed, and in-flight
  side effects are not cancelled; authorization and writes cannot be atomic with external file edits.
  HTTP handlers can mutate state before their final authentication check, including when an administrator
  revokes during an awaited operation. Run preparation rechecks before subscription and conversation creation,
  but revocation may still commit after a check and before other asynchronous side effects. Full prevention needs
  a revocation-coordinated side-effect boundary for every mutation; synchronous delivery/ask fencing alone
  does not provide that guarantee. Already-started operations and file-based changes remain separate risks.
  Playwright cloud checks could not launch Chromium: host lacks `libatk-1.0.so.0`.

## #57 · ตรวจขอบเขต process เพิ่มเติม (ยังไม่เสร็จ)

### การสำรวจ systemd scope เพิ่มเติม (ยังไม่ได้เชื่อมกับ Workspace)

- บนเครื่องพัฒนา `systemd-run --user --scope -p CPUQuota=50% -p MemoryMax=128M` แสดง
  `cpu.max=50000 100000` และ `memory.max=134217728` จากภายใน scope; ค่านี้ไม่ยืนยัน host เป้าหมาย
- ทดลอง `fork` ผ่าน systemd-run → Bubblewrap → Node ด้วย IPC fd เดิม: Node ส่งข้อความกลับได้;
  เมื่อ kill process ที่ fork หลัง ready ไม่พบ process Node ของ probe อีกหลัง 700 ms การทดลองนี้ไม่ครอบคลุม
  failure ระหว่างเริ่ม, ลูกหลานทุกแบบ, หรือการเก็บกวาด scope หลัง manager ล้ม
- ตัวขัดขวางการเชื่อมจริง: `runtimeEnv` จงใจไม่ส่ง `XDG_RUNTIME_DIR` หรือ `DBUS_SESSION_BUS_ADDRESS`;
  เมื่อใช้ environment แบบจำกัดนี้ systemd-run ล้มเหลว `Failed to connect to user scope bus` ก่อนเริ่ม Node
  การเพิ่มสองตัวแปรอย่างเดียวไม่พิสูจน์ความปลอดภัย: ต้องจัดการการเข้าถึง bus เฉพาะ launcher ไม่เปิดให้
  sandbox ควบคุม scope, ตรวจค่าที่บังคับใช้ก่อนให้ runtime ทำงาน, และพิสูจน์ cleanup เมื่อเริ่มไม่สำเร็จ
  รวมถึง OOM/restart ผ่าน `processDriver.start` จริง ยังไม่ได้พิสูจน์เงื่อนไขเหล่านี้จึงไม่ได้เพิ่ม enforcement
- IPC probe ใช้ Bubblewrap mount ทั้ง `/` แบบ read-only เพื่อสำรวจเท่านั้น ไม่ใช่ sandbox ของ Workspace
  และไม่ใช่หลักฐานการแยกไฟล์หรือ network ของ host เป้าหมาย

- ทดสอบ runtime จริง: เมื่อ mount ของ Bubblewrap ไม่มีอยู่ การเริ่มล้มเหลวและไม่มี runtime ทำงาน;
  เมื่อแก้ mount แล้วเริ่ม sandbox เดิมได้อีกครั้ง เป็นการตรวจ isolation ไม่ใช่ quota
- เครื่องพัฒนารัน transient user systemd scope โดยไม่ใช้สิทธิ์ root ได้: `CPUQuota=20%` ได้
  `cpu.max=20000 100000` และ CPU throttled 22 ครั้งในงานประมาณ 2 วินาที; `MemoryMax=64M`,
  `MemorySwapMax=0` ทำให้งานจัดสรร 128 MiB ถูกฆ่า (`oom_kill=1`, exit 137) แต่ scope ถูกยุติด้วย
  จึงยังไม่ได้พิสูจน์การกู้คืน runtime หลัง OOM ทั้งนี้ยังไม่ได้เชื่อม scope กับ Workspace
- Disk บนเครื่องพัฒนาเป็น ext4 โดย mount options ไม่แสดง project quota; ยังไม่ได้ตรวจ quota ของ
  host เป้าหมาย ไม่ควรใช้การนับขนาด directory แทนการบังคับ quota เพราะมี race และ hard link/open file
- ยังต้องออกแบบการเริ่ม process ภายใต้ cgroup ก่อนรันโค้ดที่ไม่น่าเชื่อถือ, ตรวจ limit ทุกตัวแบบ fail-closed,
  จัดการ process ลูกและ cleanup หลัง crash, บังคับ disk quota รวมทุกข้อมูลที่เขียนได้ และทดสอบปฏิเสธ/กู้คืน
  ด้วย backend จริงบน host เป้าหมาย; fake พิสูจน์เพียง control flow ไม่พิสูจน์ kernel enforcement
- เพิ่ม test สังเคราะห์ว่า sandbox มองไม่เห็นและส่งสัญญาณไปยัง process บน host ไม่ได้;
  เป็นการตรวจบนเครื่องพัฒนา ไม่ใช่การรับรอง host องค์กร
- ยังไม่มี CPU, RAM หรือ disk quota ต่อ Workspace และยังไม่ได้ทดสอบการปฏิเสธ/กู้คืนเมื่อเกิน quota;
  cgroup root ไม่เปิดให้ user เขียน แต่ user systemd transient scope ใช้ได้บนเครื่องนี้; ยังไม่ได้ตรวจ
  host องค์กร ห้ามใช้ผลนี้รับรอง production

## Cloud quota persistence (#58, partial)

- Gateway daily run admissions now use a local SQLite counter, atomically reserved and retained across
  gateway restarts. Reservations happen before runtime setup; failed preparation attempts to return the slot.
  If release fails, the original preparation error is preserved and a metadata-only `quota.release` failure
  audit is attempted; the durable counter remains authoritative, so an uncommitted release can consume a slot
  through the UTC day. Audit writes are best-effort, not guaranteed alerts. A crash during preparation can also
  consume a slot. Accepted runs count even if they fail; counters use UTC days.
- Synthetic gated preparation tests cover revocation during subscription and conversation creation: a
  conversation already being created can still be created, but later admission/dispatch is blocked when the
  next check observes revocation. UTC-boundary cleanup and cross-process release are also tested; these do not
  eliminate the check-to-side-effect races documented above. Release failures are injected before and after
  a real SQLite update; this does not reproduce every SQLite I/O or locking failure.
- Local verification: gateway/quota tests 29/29, engine tests 62/62, unit tests 117/117, database tests
  29/29, type/format check, build and engine-pin check passed. Cloud Playwright desktop tests could not launch
  because `libatk-1.0.so.0` is missing; the two mobile cases were skipped by the suite.
- Synthetic tests exercise concurrent HTTP admission across a gateway object restart and independent OS
  processes contending for the same counter. This is not yet the per-user monthly AI quota: administrator-
  configurable limits, usage reporting, invitation UI, process-level gateway restart and production
  acceptance remain outstanding. Existing invite-file revocation and owner-only Workspace access remain in place.
- The active-run quota is not coordinated across gateway processes. Together with the invitation and
  revocation limitations above and missing per-Workspace CPU, memory and disk enforcement, this remains
  an incomplete non-production draft; the durable daily counter does not close these gaps.

## 2026-10-29 · ทดลอง runtime หลายผู้ใช้ (#48)

- Gateway ตรวจและหยุด runtime ที่ว่างอัตโนมัติ และ resume จาก SQLite เดิมเมื่อมีคำขอใหม่; กันการหยุด
  ระหว่างคำขอและรอ process เก่าหยุดก่อนเริ่มใหม่ แก้ metadata ชนกันเมื่อมีการอัปเดตพร้อมกัน
- ทดสอบ browser สองบัญชีพร้อมกัน, process/SQLite แยก, สิทธิ์ไฟล์ใหม่, idle/resume และ process ล้ม
- Gateway ใช้ Bubblewrap แยก mount, user, PID, IPC และ network namespace; ทดสอบว่าอ่านไฟล์ข้าม
  workspace ผ่าน path และ symlink ไม่ได้ และต่อ host loopback ไม่ได้ หาก sandbox เปิดไม่ได้จะปฏิเสธคำขอ
- ยังไม่ได้ทดสอบบน host องค์กรหรือบัญชี Google จริง และยังไม่มี cgroup quota หรือ disk encryption;
  ใช้ข้อมูลสังเคราะห์เท่านั้น ดูข้อจำกัดใน `server/README.md`

## 2026-10-29 · เปลี่ยนบัญชี Google จากหน้าไม่ได้รับเชิญ

- ปุ่มเปลี่ยนบัญชีเคยออกจากระบบแล้วกลับหน้า login โดยไม่เปิดตัวเลือกบัญชี และ Google อาจเลือกบัญชีเดิมอัตโนมัติ
- ปุ่มล้าง session เดิมแล้วเริ่ม Google login ใหม่พร้อม `prompt=select_account`; login ปกติก็ขอให้เลือกบัญชี
  และแสดงสถานะระหว่างเปลี่ยนบัญชี หาก login ล้มเหลวกลับหน้า login พร้อมข้อความข้อผิดพลาด
- ทดสอบด้วย Auth จำลอง: บัญชีไม่ได้รับเชิญเปลี่ยนเป็นบัญชีที่ได้รับเชิญ, ยกเลิกการเลือกบัญชี,
  PKCE, การออกจากระบบข้ามแท็บ และขอบเขตข้อมูลส่วนตัว ยังไม่ได้ตรวจ Google หรือ deploy ด้วยบัญชีจริง

## 2026-10-28 · ทดลองยืนยันตัวตน gateway (#47)

- เพิ่ม gateway ทดลองแยกที่ตรวจ Google ID token, hosted domain และคำเชิญที่ยังใช้งานได้;
  แยก workspace ตาม Google subject และตรวจคำเชิญซ้ำก่อนเริ่มงานและก่อนส่งผลลัพธ์
- ทดสอบสองบัญชีสังเคราะห์, ผู้ไม่มีสิทธิ์, การอ้าง session ข้ามบัญชี และถอนสิทธิ์ระหว่างงาน
- provider เป็นตัวจำลองและ gateway เปิดเฉพาะ loopback; ยังไม่ทดสอบ Google บัญชีจริงหรือ deploy
  และยังไม่เหมาะให้พนักงานใช้ ดูวิธีตั้งค่าและข้อจำกัดใน `server/README.md`

## 2026-10-28 · ทดลองหน้าเว็บผ่าน gateway ไป Desktop engine (#46)

- เพิ่มหน้าเว็บสำหรับเจ้าของผ่าน loopback gateway, token ชั่วคราว และ Workspace runtime ของ Desktop;
  provider เป็นตัวจำลองในเครื่องเท่านั้น ไม่ส่งข้อมูลไป provider จริง แยกจาก Supabase pilot
- ตรวจเส้นทาง browser → gateway → engine → provider จำลอง และการปฏิเสธคำขอที่ไม่มีสิทธิ์
  ด้วย Playwright ทั้ง desktop และ mobile ดูวิธี SSH forwarding และข้อจำกัดใน `server/README.md`
- ยังไม่ได้ deploy หรือทดลองบน homelab จริง; ไม่ใช่ระบบ login หรือ process isolation สำหรับพนักงาน

## 2026-10-28 · Cloud Workspace ระยะ 3b: หน้าจอเดิมของ Webapp ทำงานผ่าน Gateway

- ใช้หน้าจอเดิมทั้งหมด เพิ่ม `Host` แบบที่สาม (`web/src/gateway.ts`) ที่ส่งคำสั่งเดิมของหน้าจอไป Gateway เลือกโหมดตอน build ด้วย
  `VITE_GATEWAY_URL` + `VITE_GOOGLE_CLIENT_ID` ถ้าไม่ตั้ง แอปเป็นโหมด Supabase เหมือนเดิม
- โหมดนี้ login ด้วยปุ่ม Google Identity Services (ID token อยู่ใน `sessionStorage` ของแท็บ) แสดงเฉพาะแชต ค้นงานเก่า และคู่มือ
  ซ่อนความจำ เอกสาร ใบเสร็จ Skill แบบฟอร์ม สื่อ การตั้งค่า และปุ่มแชร์/เลือกเอกสาร/ความจำ/ใช้เป็นร่าง ที่ Gateway ยังไม่มี
- Server: runtime เขียนดัชนีบทสนทนาในโฟลเดอร์ Workspace ของตัวเอง Manager อ่านดัชนีนี้เมื่อ runtime หยุดอยู่ การเปิดหน้าเว็บจึงไม่ปลุก
  runtime ทุกตัว และเพิ่ม `POST …/conversations` สร้างบทสนทนาเปล่า
- Bug ที่เจอและแก้ (มี test ที่ล้มเมื่อเอาการแก้ออก):
  - `workspace.json` เขียนผ่านไฟล์ `.tmp` ชื่อเดียว คำขอที่ทับกันใน Workspace เดียว (งานจบระหว่างแชตอ่านข้อความ) ทำให้ `rename` ล้มด้วย
    `ENOENT` ตอนนี้แต่ละครั้งใช้ไฟล์ชั่วคราวของตัวเอง
  - หน้าเว็บโหมด Cloud Workspace แสดงหน้า login ชั่วครู่ก่อนอ่าน credential จึงโหลด script ของ Google แม้แท็บ login อยู่แล้ว
  - ปุ่มหยุดงานกดไม่ได้ เพราะงานจาก Gateway ไม่มี `actor_id` ของผู้ใช้ (หน้าแชตให้เฉพาะเจ้าของงานกดหยุด) Playwright จับได้
- Validation (cloud container, Node 22.22.0, ข้อมูลสังเคราะห์, ไม่เรียก AI หรือ Google จริง): `check`, `check:engine-pin`, `npm test` (รวม
  `gateway-host` 4 ข้อ), `test:db`, `test:engine`, `build` และ Playwright ทั้งชุด ผ่าน ยกเว้น test ดาวน์โหลด Word 2 ข้อ (desktop/mobile) ที่ล้ม
  แบบเดียวกันบน main ที่ไม่ได้แก้ใน container นี้ (Chromium ตั้งชื่อไฟล์ `download`) ใหม่: `cloud-workspace.spec.ts` 2 ข้อ ส่งคำถามจากหน้าแรก
  ดูคำตอบ stream, reload กลางทาง, เปิดงานเดิมแล้วได้คำตอบที่จบ, กดหยุดงานถัดไประหว่าง stream แล้วไม่มีคำตอบตามมา และไม่มีคำขอออกนอกเครื่อง
- ยังไม่ทำ: ลองกับบัญชี Google จริงและ Gateway บน homelab, CSP ของ nginx สำหรับโหมดนี้, ร่างเอกสาร/ความจำ/ไฟล์ใน Cloud Workspace (ระยะ 4) ไม่มี deploy migration หรือ secret ใหม่

## 2026-10-28 · Cloud Workspace ระยะ 3a: Gateway, งานที่รันต่อหลังปิด Browser, event stream และยกเลิกงาน

- เพิ่ม `server/src/gateway/` เป็นทางเข้าเดียวของ Browser สู่ Workspace (ADR 0001 §3): login ด้วย Google ID token
  (โดเมนองค์กร + ไฟล์รายชื่อคนที่ได้รับเชิญที่อ่านใหม่ทุกคำขอ), HTTP API ของ Workspace/บทสนทนา/งาน, SSE ต่อ Workspace
  ที่ต่อกลับด้วย `Last-Event-ID` แล้วได้เฉพาะส่วนที่พลาด, ยกเลิกงาน, quota ต่อผู้ใช้, audit log แบบไม่มีเนื้อหา และ
  `/api/admin/health` ที่มีแต่ตัวเลข รายละเอียดใน `server/README.md`
- runtime ส่ง event ระหว่างตอบ (`delta`/`discard`/`activity`) ให้ Manager และเพิ่มคำสั่ง `newConversation`, `cancel`, `messages`
  ใน contract โดยไม่แก้ engine
- เจอระหว่างทำและแก้แล้ว: cancel ที่กดทันทีหลังเริ่มงานแซงคำขอ ask ใน IPC ได้ แล้วงานรันจนจบ ตอนนี้ cancel รอให้ ask ถูกส่งก่อน
  และ `GET …/runs` ของ Workspace คนอื่นตอบ 200 รายการว่างแทน 404 ทั้งสองข้อมี test และลองเอาการแก้ออกแล้ว test ล้ม
- เกณฑ์ผ่านของระยะ 3 ทดสอบกับของจริงทั้งเส้น (Gateway HTTP + runtime process + engine ของ Desktop + AI endpoint สังเคราะห์บน
  loopback): ปิดการเชื่อมต่อระหว่าง AI ยังคิด งานทำต่อจนจบ ต่อกลับแล้วได้คำตอบที่ stream มาระหว่างนั้นพร้อมผลและเอกสารอ้างอิง
  และยกเลิกงานถัดไปในบทสนทนาเดียวกันได้ ไม่มีการเรียก AI จริงหรือบัญชีจริง
- Test ใหม่ 11 ข้อ: Gateway 7 (สิทธิ์และ origin, ปิด Browser/กลับมา, ยกเลิก, แยกผู้ใช้, quota, admin/audit, ตรวจ input),
  Google ID token 3, end-to-end 1
- ยังไม่ทำ: หน้าเว็บ (3b), ช่องอนุมัติ (มาพร้อมเครื่องมือเขียนภายนอกในระยะ 4), เก็บสถานะงานข้าม restart ของ Gateway, ทดสอบกับบัญชี
  Google จริง และ container driver ไม่มี deploy migration หรือ secret ใหม่

## 2026-10-28 · Rollout #42 (และหน้าเว็บของ #34/#35)

- Webapp #42 merge เป็น `45ad12e` หลัง Verify PWA ผ่านครบ (รวม engine isolation บน Linux)
- Supabase: ก่อน deploy ดาวน์โหลด `worker` v27 มาเทียบ พบว่า `_shared/worker.ts` และ `worker/index.ts` ตรงกับ `3c6b358`
  (main ก่อน #42) เจ้าของโครงการรัน deploy `worker` จาก main `45ad12e` ด้วย CLI 2.122.0,
  `--no-verify-jwt --use-api --import-map` ได้ v28 ACTIVE และสองไฟล์นั้นตรงกับ `45ad12e`
  (CLI ปฏิเสธการแตกไฟล์นอก `supabase/functions` จึงเทียบไฟล์ใน `packages/` ไม่ได้)
  `api` ยัง v24 เพราะไฟล์ของ api ไม่เปลี่ยนตั้งแต่ `4844e2a` และใช้เพียง `literalSearch` จากโค้ดกลาง
  `google-callback` ยัง v14 ไม่มี migration/secret
- Homelab: หน้าเว็บเดิมรัน image `pr32-e5a816c` (hash ของ `Chat.tsx`, `App.tsx`, `package.json` ตรงกับ `e5a816c`)
  การแก้หน้าเว็บของ #34/#35 จึงขึ้นพร้อมรอบนี้ tag image เดิมเป็น `step-ai-webapp:pilot-pre42-e5a816c`
  เก็บ source เดิมไว้ที่ `~/STeP-AI-Webapp.prev-pre42-e5a816c` แล้ว build จาก `git archive` ของ `45ad12e`
  โดยคง `.local/homelab.env` container `step-ai-pilot-web-1` healthy และ `/healthz` ตอบ ok
- Smoke: `verify-homelab.mjs` ผ่าน HTTPS origin เดิมใน tailnet (shell, OAuth callback, PWA cache, CSP, missing asset)
  bundle ที่ให้บริการมี organization reference ของ #34 และตัวแยกคำถามของ #42
- ย้อนกลับ: tag `pilot-pre42-e5a816c` กลับเป็น `pilot` แล้ว `compose up -d --no-build --wait` และ deploy `worker`
  จาก `3c6b358`
- ยังไม่ทำ: ทดสอบด้วยบัญชีจริงหลัง rollout (ร่าง TOR แล้วถามต่อ, คำถามที่เคยถูกหยุด เช่น "ขั้นตอนลงนามสัญญาจ้าง
  มีอะไรบ้าง", ไฟล์ Word ที่มีชื่อและที่อยู่ของอุทยานฯ) และการเพิ่มตัวเลือก "แก้เอกสารนี้ / แชต" แบบ Desktop

## 2026-10-28 · แชตไม่หยุดด้วย authority preflight และข้อความถัดไปไม่ติดโหมดร่าง

- ผู้ใช้ทดสอบ TOR จ้างจัดสัมมนา (ข้อมูลสังเคราะห์) แล้วได้ข้อความ "งานนี้ต้องให้ผู้มีอำนาจของ STeP ตรวจ..." แทนร่าง
  และคำถามถัดไปใน task เดียวกัน (ตรวจใบเสร็จ, วันลาสะสม) ยังขึ้นป้าย "ร่างเอกสารอยู่ในแผงผลงาน" พร้อมแหล่งอ้างอิงของ TOR
- สาเหตุ 1: worker ตรวจ authority preflight กับคำขอที่ host สร้างจากฟอร์มทั้งก้อน ช่อง "60 วันนับจากลงนามสัญญา"
  ชน trigger `ลงนามสัญญา` ของ `official-signing` (ทำซ้ำได้กับข้อความจริง) Desktop ปิด `checks.authority` เป็นค่าเริ่มต้น
- แชตทั่วไปก็ชนแบบเดียวกัน: ทดสอบข้อความพนักงานสังเคราะห์ 23 ข้อกับ `authority.yaml` ของ pack คำขอให้ลงมือจริง 6/6
  ถูกหยุด แต่คำถามข้อมูล 10/17 ถูกหยุดผิด เช่น "ขั้นตอนลงนามสัญญาจ้างมีอะไรบ้าง", "ใครมีอำนาจอนุมัติงบประมาณเกิน
  500,000 บาท", "ออกเลขหนังสือภายนอกต้องทำที่ระบบไหน" เพราะ trigger จับคำ ไม่แยกคำถามจากคำสั่ง
- แก้ 1 (เจ้าของโครงการตัดสิน 2026-10-28): เลิกหยุดแชตด้วย preflight ทั้งหมด เหมือนค่าเริ่มต้นของ Desktop เหตุผล:
  STeP ลงนามและอนุมัติบนเอกสาร physical อยู่แล้ว และแชตเว็บไม่มีเครื่องมืออนุมัติ ลงนาม ออกเลข หรือส่งออกภายนอก
  (ตรวจแล้ว: Google ใช้ POST เฉพาะขอ OAuth token) `SYSTEM_RULES` ยังห้ามอนุมัติแทนผู้มีอำนาจ และ Skill/drafting
  contract ยังคงขอบเขต Human Authority ยังต้องนำเข้า `__authority`/`__organization` เหมือนเดิม การยินยอมก่อนส่ง AI
  และก่อนอ่าน Google ไม่เปลี่ยน ถ้าภายหลังเพิ่มเครื่องมือเขียนภายนอก ต้องมี approval ของตัวเองก่อนใช้
- สาเหตุ 2: หน้าแชตส่ง `documentTool` ของ task ไปกับทุกข้อความ ทุกคำถามจึงเป็นงานร่าง TOR โหลดแม่แบบ/คู่มือ TOR
  และไม่เข้าการเลือกเอกสารด้วย AI ของ #39 (ซึ่งทำเฉพาะเมื่อไม่มีเครื่องมือร่าง) คำถามวันลาจึงตอบว่าไม่พบข้อมูล
- แก้ 2: `turnDocumentTool` ทำตาม draft mode ของ Desktop หลังมีคำตอบแรกแล้ว คำถามเกี่ยวกับร่าง (`isDocumentQuestion`
  จาก upstream ไม่แก้) หรือข้อความที่ขึ้นต้นด้วย `/` ส่งเป็นแชตปกติ ข้อความอื่นยังเป็นการแก้ร่าง คำขอแรกจากฟอร์มร่างเสมอ
- สำเนียงภาษาเหนือในคำตอบมาจากสไตล์การพูดในโปรไฟล์ผู้ใช้ ทำงานเหมือน Desktop ไม่ใช่ข้อผิดพลาด
- ต้อง deploy `worker` และ rebuild หน้าเว็บ ไม่มี migration หรือ secret ใหม่ ยังต้องทดสอบซ้ำกับบัญชีจริงหลัง deploy

## 2026-10-27 · ระยะ 2: engine ตอบด้วย provider จริงครั้งแรก (local LLM)

- รัน `npm run engine:ask` กับ Ollama 0.40.11 บนเครื่องของเจ้าของโครงการ (RTX 4070 SUPER 12 GB, Node 25.2.1)
  ผ่าน endpoint ที่เข้ากับ OpenAI ได้ (`http://127.0.0.1:11434/v1`) รุ่น `gemma4:12b` (Q4_K_M)
  ไม่ต้องใช้คีย์ ข้อมูลไม่ออกนอก tailnet
  และใช้เฉพาะเอกสารสาธารณะใน submodule `harness/` (`desktop-v0.6.20`) ไม่มีข้อมูลพนักงาน
- ครั้งแรกล้มด้วย `PROVIDER_STREAM_INCOMPLETE`: Ollama เปิดรุ่นนี้ที่ context 4,096 token แต่ prompt ของ engine
  พร้อมเอกสารยาวกว่า จึงไม่ได้ `content` กลับมา แก้ฝั่ง Ollama โดยสร้างรุ่น `gemma4:12b-32k`
  (`PARAMETER num_ctx 32768` เท่าเพดานบริบทที่ engine ออกแบบไว้) ไม่แก้โค้ด engine หรือ server
- ผล 3 ข้อ (engine เลือกเอกสาร, AI ตอบ, ตรวจกับต้นฉบับด้วยมือ):
  - "ติดต่อฝ่ายบุคคลช่องทางไหน" (24 วินาที รวมโหลดรุ่น): ได้ `hr-service-channels` ตอบตรงตาราง 5 จาก 6 แถว ไม่มีข้อมูลแต่งเพิ่ม
  - "เบิกค่าน้ำมันรถส่วนตัวย้อนหลังได้กี่เดือน" (8 วินาที): ได้ประกาศสวัสดิการ 2569 ข้อ 3.13 ตอบ "ไม่เกิน 3 เดือน" ถูก
  - "ร้านกาแฟแถวออฟฟิศร้านไหนอร่อย" (10 วินาที): engine ไม่ส่งเอกสาร AI ตอบว่าไม่มีข้อมูล แต่แนะนำ "ฝ่ายอาคาร
    (Facilities)" ซึ่งไม่มีในเอกสาร
- รันซ้ำบน homelab (Ubuntu x86_64, Node 22.23.3 ต่ำกว่า `>=24` ที่ `package.json` ระบุ npm เตือนแต่ทำงานได้):
  homelab ไม่มี GPU จึงให้ engine บน homelab เรียก Ollama บนเครื่องที่มี GPU ผ่าน SSH reverse tunnel
  (`127.0.0.1:11435` บน homelab) ที่เปิดเฉพาะระหว่างคำสั่ง ไม่เปิด Ollama ออกเครือข่าย ติดตั้งแยกที่
  `~/step-ai-engine-trial` (source จาก `git archive` ของ `6234113` + `harness` `90ee71c` บันทึกใน `SOURCE.txt`)
  ไม่แตะ `~/STeP-AI-Webapp` และ container ของหน้าเว็บ
  - `test:engine` บน homelab ผ่าน 3/3 รวมข้อแยก SQLite รายคน (โฟลเดอร์ผู้ใช้จริงเป็น `drwx------`)
  - คำถามชุดเดิม: ฝ่ายบุคคลตอบครบ 7/7 แถวตรงต้นฉบับ (24 วินาที), ค่าน้ำมัน "ไม่เกิน 3 เดือน" อ้างข้อ 3.13.3 (7 วินาที),
    ร้านกาแฟไม่มีเอกสาร AI ถามกลับเรื่องที่ตั้งและเสนอช่วยหาร้าน ซึ่ง engine ทำไม่ได้เพราะไม่มีค้นเว็บ (4 วินาที)
- เพิ่ม `npm run engine:bench`: คำถามพนักงาน 61 ข้อผ่าน engine ทั้งเส้นกับ provider จริง ใช้โฟลเดอร์ผู้ใช้ใหม่ทุกรอบ
  ตรวจอัตโนมัติว่าส่งเอกสารถูก ได้คำตอบ และอ้างเอกสารที่ควรอ้าง พร้อมเวลาและ token รายงานเต็มเก็บใน `.data/bench/`
  ชุดคำถามไม่มีคำตอบอ้างอิง ความถูกต้องของเนื้อหาจึงยังต้องให้คนอ่าน
- ผลรอบแรกของระยะ 2′ บน RTX 4070 SUPER กับ `gemma4:12b-32k`:
  - ส่งเอกสารถูก 60/61 ได้คำตอบ 56/61 อ้างเอกสารที่ควรอ้าง 55/56 ของข้อที่ตอบ (คิดใหม่หลังให้นับ id ใน backtick
    ด้วย เพราะ 3 ข้อแรกที่ไม่ผ่านอ้าง id จริงแต่ไม่ได้ใส่วงเล็บเหลี่ยม)
  - ไม่ได้คำตอบ 5 ข้อเป็นคำถามที่ engine ส่งไปค้นเว็บ (ราคาทอง ค่าเงิน วันหยุดราชการ บิทคอยน์ อากาศ) ได้
    `PROVIDER_CAPABILITY_UNSUPPORTED` ตั้งแต่ก่อนถึงโมเดล เพราะ endpoint แบบ compatible ค้นเว็บไม่ได้ ข้อวันหยุดราชการ
    จึงตรวจการส่งเอกสารไม่ได้ (เป็นข้อเดียวที่ส่งเอกสารไม่ผ่าน)
  - เวลาต่อข้อ p50 12.6 วินาที p95 39.8 วินาที ข้อความแรก p50 7.5 วินาที (รวมช่วงที่รุ่นคิดก่อนตอบ) output 54,620 token
    เฉลี่ยรวมทั้งงาน 61 token/วินาที ข้อที่ช้าที่สุดคือทะเบียนเอกสาร ISO และรหัสโครงการ (31–43 วินาที)
  - สุ่มตรวจกับต้นฉบับ: วันลาพักผ่อน 10 วัน สะสม 20 วัน, เบอร์ 0 5394 8678 และรหัสฟอร์ม FM-CC ตรง
    "ระเบียบการเงินฉบับไหนใช้ก่อน" ไม่แต่งชื่อระเบียบและมีคำเตือนตรวจฉบับจริงตามเอกสาร แต่ไม่ได้เรียงลำดับชั้น
    4 ระดับที่เอกสารให้ไว้ ข้อทั่วไป (ร้านกาแฟในเชียงใหม่) ตอบจากความรู้ของรุ่นโดยไม่มีแหล่ง ผลบอลตอบว่าไม่มีข้อมูลสด
- ข้อสรุป: engine ของ Desktop ทำงานครบเส้นกับ provider จริงแบบ headless ได้ทั้งบน Windows และ homelab
  ระยะ 2′ ยังต้องรันชุดเดียวกันกับ provider แบบ API (OpenRouter/Gemini/Claude ซึ่งต้องให้เจ้าของโครงการตั้งคีย์เอง)
  และอาจลองรุ่น local อื่นก่อนทำข้อเสนอ hardware A/B
- ไม่มี deploy หรือ secret

## 2026-10-27 · ทดลองค้นและอ่านเว็บสาธารณะจาก engine CLI

- เพิ่ม tool host แบบจำกัดใน `server/src/public-web.ts` เชื่อม ToolLoop ของ Harness สำหรับ `engine:ask` และ
  `engine:bench` เฉพาะเมื่อผู้รันเลือก `--public-web` รายคำสั่ง ปกติยังปิด; Cloud Workspace ยังไม่เปิด tool host
  เพราะยังไม่มี gateway/consent สำหรับการส่งคำถามและผลเว็บออกนอกเครื่อง
- เครื่องมือมีเฉพาะ `web_search` และ `web_fetch`: ส่งเฉพาะคำถามปัจจุบันที่ตรงข้อความผู้ใช้ไป Bing, อ่านเฉพาะ
  URL จากผลค้นในรอบเดียวกัน และปฏิเสธเครื่องมืออื่น; จำกัด 2 ครั้งค้น/5 ครั้งอ่าน ใช้ public URL, DNS และ
  redirect checks ของ Desktop พร้อม privacy scan ก่อนส่ง query, URL, ผลค้น และเนื้อหาหน้าเว็บ
- Benchmark รับ `--question` เพื่อเลือกคำถามและบันทึกจำนวนค้น/อ่านสำเร็จ, error code, URL จากผลค้น และการอ้าง URL
  แยกจากคะแนนเอกสาร ตัวนับไม่ยืนยันคุณภาพของแหล่งข้อมูลหรือความถูกต้องของคำตอบ; ต้องให้คนตรวจ
- ตรวจด้วย provider, ผลค้นและเว็บสังเคราะห์ ไม่เรียก AI จริง: ค้นแล้วอ่านผ่าน engine ทั้งเส้น, ปฏิเสธปลายทาง
  และเครื่องมือที่ไม่อนุญาต, ต้องเลือกเปิดทั้ง policy และ consent, ปฏิเสธข้อมูลอ่อนไหวก่อนบันทึก/ส่งให้ provider
- Validation บน Linux: `check`, `check:engine-pin`, `test:engine` 18/18, unit 110/110, database 29/29,
  `build` และ Playwright Chromium desktop/mobile 76/76 ผ่าน
- ข้อจำกัด: สภาพแวดล้อมพัฒนานี้ไม่มี Ollama ที่พอร์ต 11434/11435 และ DNS สำหรับค้น Bing ใช้ไม่ได้
  จึงยังไม่ได้ทดสอบ `gemma4:12b-32k` หรือเว็บจริง และยังไม่ได้ rerun benchmark 61 ข้อบน homelab;
  ไม่มีการ deploy การเปิดค้นเว็บส่งคำถามไป Bing และส่งผลเว็บไป AI endpoint ตามที่ผู้รันเลือก

## 2026-10-27 · Webapp เลือกเอกสารองค์กรและ Skill ด้วย AI เมื่อการค้นคำไม่เจอ (แบบเดียวกับ Desktop)

- ปัญหา: "ปีหน้าลางานได้กี่วัน" Desktop ตอบได้ แต่ Webapp ตอบว่ายังไม่พบข้อมูล การค้นคำ (`OrganizationKnowledge.search`)
  ของทั้งสองตัวไม่เจอเอกสารเหมือนกัน และตัวเลือก Skill แบบคำค้นก็ไม่เลือก `hr-policy-lookup` แต่ Desktop มี tool loop
  ที่ให้ AI เห็นทะเบียนเอกสารและเปิดหัวข้อเองได้ Webapp ตอบรอบเดียว AI จึงไม่เคยเห็นเอกสาร
- แก้ใน worker (bug fix ภายใต้ feature freeze): ถ้าไม่ได้เลือก Skill หรือเครื่องมือร่างเอง และการค้นคำไม่เจอเอกสารหรือ Skill
  จะถาม AI หนึ่งครั้งให้เลือกจากทะเบียนเอกสาร (ชื่อ สาระ และหัวข้อ) และรายการ Skill ไม่เกิน 2 เอกสาร 3 หัวข้อ และ 1 Skill
  โดยใช้บทสนทนาก่อนหน้า 4 ข้อความเพื่อตีความคำถามต่อเนื่อง แล้วอ่านเฉพาะหัวข้อที่เลือก (รวมหัวข้อย่อย) ไม่เกิน 10,000 ตัวอักษร
  รหัสที่ไม่อยู่ในทะเบียนถูกทิ้ง คำตอบที่อ่านไม่ได้ถือว่าไม่ได้เลือก ส่วน ACCESS_DENIED/RUN_INTERRUPTED ยังหยุดงานเหมือนเดิม
- โค้ดอยู่ใน `packages/harness-core/src/reference-selection.ts` ทะเบียนเอกสารใช้ `OrganizationKnowledge.registry()` เดิมของ Desktop
- ค่าใช้จ่าย: งานที่เข้าเงื่อนไขมีการเรียก AI เพิ่ม 1 ครั้ง ทะเบียนจาก pack ปัจจุบัน (38 เอกสาร, 43 Skill) ประมาณ 24,000 ตัวอักษร
  นับรวมใน input/output token ของงาน และยังอยู่ในวงเงินที่จองไว้ต่องาน (64,000 input token)
- Test: worker 6 test ใหม่ (เลือกหัวข้อและ Skill, คำถามต่อเนื่อง, AI เลือกไม่ได้แล้วตอบแบบผู้ช่วยทั่วไป, ถูกถอนสิทธิ์ระหว่างเลือก)
  และ unit test ของการเลือกหัวข้อ/การอ่านคำตอบ ไม่เรียก AI จริง ยังไม่ได้วัดความแม่นยำการเลือกด้วยโมเดลจริง
- ซ้อนบน PR #38 ต้อง deploy `worker` จึงจะมีผล ไม่มี migration หรือ secret ใหม่ งาน Cloud Workspace (server/) ยังปิด tool loop อยู่

## 2026-10-26 · คำขอที่มีคำว่า STeP แต่ไม่มีเอกสาร ได้คำตอบแบบผู้ช่วยทั่วไปแทนการปฏิเสธ

- ปัญหา: คำขอเชิงสร้างสรรค์ เช่น "คิด Big idea สำหรับงาน STeP Innovation Day…" ได้ข้อความ "ยังไม่พบเอกสารองค์กรที่ยืนยันเรื่องนี้ครับ…"
  ทันที เพราะ worker ถือว่าทุกคำขอที่มีคำว่า STeP เป็นคำถามองค์กร และปฏิเสธเมื่อค้นเอกสารไม่เจอ แม้ระบบจะจับคู่ Skill ได้เอง
  (Skill ที่ auto-match ไม่ทำให้ข้ามกฎ มีแต่ Skill ที่ผู้ใช้เลือกเอง) และแม้ผู้ใช้จะแนบเอกสารมาแล้ว
- แก้ (bug fix ภายใต้ feature freeze): worker ไม่ตอบข้อความปฏิเสธสำเร็จรูปอีก แต่ส่งงานให้ AI พร้อม Skill ที่ auto-match ความจำ
  และบทสนทนา ถ้าไม่มีเอกสารองค์กร เอกสารแนบ ข้อมูลปฏิทิน เครื่องมือร่างเอกสาร หรือ Skill ที่เลือกเอง จะเพิ่มกฎ
  `NO_ORGANIZATION_SOURCE_RULE` ใน system prompt: ช่วยเต็มที่แบบผู้ช่วยทั่วไป บอกหนึ่งประโยคว่าไม่ได้อ้างอิงเอกสาร STeP
  ห้ามแต่งนโยบาย ขั้นตอน ระเบียบ ตัวเลข หรือบุคลากรของ STeP และถ้าเป็นคำถามข้อเท็จจริงขององค์กรให้บอกว่ายังไม่พบเอกสารยืนยัน
- การตรวจสิทธิ์ผู้มีอำนาจ (authority preflight) ยังทำงานก่อนเหมือนเดิม คำถามที่ต้องให้ผู้มีอำนาจตัดสินยังได้ข้อความเดิม
- ต้อง deploy `worker` จึงจะมีผลบน homelab ยังไม่ได้ deploy ไม่มี migration

## 2026-10-26 · Cloud Workspace ระยะ 2: engine ของ Desktop รันใน runtime ของแต่ละ Workspace

- `runtime-main.ts` เปิด engine headless (`server/src/engine.ts`) บน `<ws>/workspace.sqlite` ของ Workspace นั้น และตอบ Manager
  ผ่าน IPC แบบ request/reply (`connect`, `ask`, `conversations`, `health`) ส่งออกเฉพาะ error code ไม่ส่งข้อความที่อาจมีเนื้อหาผู้ใช้
- `RuntimeManager` เพิ่ม `ask`/`conversations` (resume Workspace ที่หยุดให้เอง), `grant()` ที่ออก endpoint/token ทุกครั้งที่ start
  และไม่หยุด runtime ที่มีงานค้างแม้เกินเวลา idle (ปิด Browser แล้วงานยังทำต่อ)
- test ใหม่ 4 ตัว ใช้ endpoint สังเคราะห์บน loopback (ไม่เรียก AI จริง): คำถามพนักงานผ่าน process จริง 60/60 ข้อที่ไม่ต้องค้นเว็บ,
  stop แล้ว resume บทสนทนาเดิมต่อได้และ token ไม่อยู่ใน SQLite, ใช้ session ของอีกคนไม่ได้, งานค้างไม่ถูกหยุดเป็น idle
- ช่องว่าง: คำถาม "วันหยุดราชการปีนี้" ต้องใช้ web search ของ provider ซึ่ง endpoint แบบ compatible ไม่มี และ AI skill selection
  ยังปิดเพราะผูกกับ tool loop (ดู server/README.md) ยังไม่มี Gateway/HTTP/event stream (ระยะ 3), ไม่มี deploy หรือ secret ใหม่

## 2026-10-26 · Cloud Workspace ระยะ 1: Workspace contract และ Runtime Manager

- เพิ่ม `server/src/workspace/`: contract ของ Workspace (id, เจ้าของ, สถานะ runtime, error code), โฟลเดอร์ตาม ADR 0001 §2
  (`users/<user>/workspaces/<ws>/{workspace.json,files,snapshots}` สิทธิ์ 0700) และ `RuntimeManager` ที่สั่ง
  create/list/get/start/stop/resume/health/touch ได้เฉพาะเจ้าของ Workspace; id ของคนอื่นตอบเหมือนไม่มีอยู่ (`WORKSPACE_NOT_FOUND`)
- Runtime ผ่าน `RuntimeDriver` contract: ตอนนี้มี process driver (หนึ่ง Workspace = หนึ่ง Node process, cwd อยู่ใน `files/`,
  environment มีแค่ 5 ค่า ไม่สืบทอด key ของ provider/Supabase) ส่วน Docker/Podman/systemd sandbox ยังรอตัดสินตาม ADR
- มี admission control (`maxRunning`), หยุด runtime ที่ idle (`sweepIdle`), runtime ล้มแล้วสถานะเป็น `failed` และ start ใหม่ได้
- `npm run test:engine` เพิ่ม 6 test: ผู้ใช้สองคนแยกกันและเรียก Workspace ของอีกคนไม่ได้, id ที่พยายามออกนอก data root ถูกปฏิเสธ,
  process แยกและไม่รับ secret, stop/resume แล้วไฟล์อยู่ครบ, crash แล้วกู้ได้, capacity และ idle
- ข้อจำกัด: process driver ไม่ใช่ security boundary ระดับ host (ไม่มี namespace/cgroup/network policy); runtime ยังไม่เปิด engine
  (ระยะ 2) และยังไม่มี Gateway/login/HTTP (ระยะ 3) ไม่มีการ deploy, migration หรือ secret ใหม่

## 2026-10-26 · ปรับ ADR 0001 เป็น STeP Cloud Workspace

- เปลี่ยนปลายทางจากการคิดเป็น engine เดียวต่อผู้ใช้ ไปเป็น Cloud Workspace แบบ Codex/Claude Cloud:
  Web เป็น client/gateway, Linux Server ใช้ทรัพยากรร่วมกัน และแต่ละ Workspace มี Runtime, filesystem,
  SQLite และสิทธิ์แยกกัน ผู้ใช้หนึ่งคนสร้างได้หลาย Workspace และกลับมา Resume หลังปิด Browser ได้
- ระบุขอบเขตว่าเป็น headless cloud workbench ไม่ใช่ Windows/Linux VDI: รุ่นแรกไม่ส่งภาพ Desktop และไม่เปิด
  Host filesystem, privileged Docker, raw VNC/CDP หรือสิทธิ์ข้าม Workspace
- เพิ่ม Runtime Manager, queue/quota, persistent volume, backup, event stream, approval, audit metadata,
  Local LLM router และลำดับพัฒนา ตั้งแต่ headless isolation จนถึง optional Browser/MCP runner
- งานนี้แก้เอกสาร ADR/progress เท่านั้น ยังไม่มีการเปลี่ยน runtime, migration, deployment หรือ secret

## 2026-10-26 · Web App ปรับการส่งออก TOR และเอกสารราชการให้ตรงกับ Desktop

- แก้ browser DOCX/PDF exporter ให้ชื่อเรื่องอยู่กึ่งกลาง แต่บล็อกหน่วยงาน/ข้อมูลต้นเรื่องและเนื้อหา TOR ชิดซ้ายอย่างชัดเจน
  ตารางข้อความกำหนดชิดซ้ายและตัวเลขชิดขวาเหมือนกันทั้ง Word และหน้า PDF
- เพิ่ม `th-TH` ทั้ง language และ East Asian line-breaking metadata ใน DOCX เพื่อให้ Word ตัดบรรทัดภาษาไทยถูกต้องขึ้น
  โดยยังคงใส่ zero-width break เฉพาะสำเนาส่งออก ไม่แก้ร่างต้นฉบับ
- เพิ่ม source-backed organization reference สำหรับการร่าง: ใช้ชื่อเต็ม
  `อุทยานวิทยาศาสตร์และเทคโนโลยี มหาวิทยาลัยเชียงใหม่` และที่อยู่ของอุทยานเมื่อเอกสารมีช่องหน่วยงานที่รับผิดชอบ/ผู้ส่ง
  พร้อมคงหน่วยงานอื่นที่ผู้ใช้ระบุและแจ้งความขัดแย้ง ไม่เติมช่องหน่วยงานขึ้นมาเอง
- Validation: `check`, `build`, unit/API/PWA 91/91, PostgreSQL 29/29, engine 3/3 และ engine pin `desktop-v0.6.20`
  ผ่าน; targeted document tests 25/25 ผ่าน
- หลัง merge main รันซ้ำบน Windows: check, build, unit/API/PWA 96/96, PostgreSQL 29/29, engine pin และ
  Playwright desktop/mobile 76/76 ผ่าน; engine isolation ล้มเฉพาะ POSIX mode 0700 ที่ Windows ไม่รองรับ
  (ข้อจำกัดเดิม) และผ่าน 3/3 ใน Linux CI ของ PR
- ต้อง rebuild/deploy frontend และ deploy `worker` (และ `api`) ด้วย เพราะ `document-contract.ts` และ
  `documentRequest` ที่เพิ่ม organization reference อยู่ในเส้นทางร่างของ worker ไม่มี migration
- Merge main หลัง #32/#33 เข้ามาแล้ว (คู่มือ TOR content-by-type และ saraban guide) ขัดแย้งเฉพาะ progress นี้

## 2026-10-25 · Rollout คู่มือ TOR/หนังสือราชการและปิด PR ที่ค้าง

- Harness #235 merge เป็น `2874bf1` หลัง CI ผ่านทุกระบบ (รวม Windows และ macOS Electron)
  และ Webapp #32 merge เป็น `4844e2a` หลัง Verify PWA ผ่านครบ รวม engine isolation บน Linux 3/3,
  unit/API/PWA 94/94, PostgreSQL 29/29, engine pin, reference, check, build และ Playwright 76/76
  ทดสอบหน้าเครื่องมือเอกสารซ้ำหลังจัดลำดับไฟล์รอบสุดท้ายบน Windows ผ่าน 18/18
- Deploy `api` v24 และ `worker` v25 จาก main `4844e2a` ด้วย CLI 2.122.0, `--no-verify-jwt --use-api`
  และ shared import map ทั้งสอง ACTIVE เทียบ source ที่ deploy กับ main แล้วตรงทุกไฟล์ runtime
  (API 25 ไฟล์, worker 26 ไฟล์; ยกเว้น type-only `contracts.ts`) callback ยัง v14 ไม่มี migration/secret เปลี่ยน
- นำเข้า Harness pack `2874bf1` ให้ STeP แบบ atomic: 108 sources / 48 Skills ตรวจ body/instructions
  และ source version ทุกรายการกับ pack แล้วตรงกัน ก่อนนำเข้ามีสำรองข้อมูลเดิมจริง 106 sources / 48 Skills
  ไว้เฉพาะ `.exports/production-before.json` ที่ Git ignore คีย์ operator อยู่เฉพาะใน process และล้างหลังใช้
- หน้าเว็บ build บน homelab จาก tree ของ `e5a816c` (ตรงกับ PR #32 ที่ merge แล้ว) และสลับ container ใหม่
  `step-ai-pilot-web-1` healthy โดยคง `.local/homelab.env` และ origin HTTPS ของ tailnet เดิม
  image เก่าเก็บเป็น `step-ai-webapp:pilot-pre32-1a857b7` และ source เดิมอยู่ที่
  `~/STeP-AI-Webapp.prev-pre32-1a857b7` ไม่ลบของเดิม
- Smoke หลัง rollout: hosting/CSP/PWA/cache/callback/missing assets ผ่าน, API origin ที่อนุญาตได้ 401
  เมื่อไม่มี identity, origin อื่นได้ 403 และ worker ไม่มี dispatch secret ได้ 403
  Chromium ผ่าน HTTPS จริงทั้ง desktop/mobile: anonymous protected route ไป login, แบบฟอร์มเตรียมร่างส่วนตัว,
  Word มีฟอนต์ฝังครบสี่ไฟล์และตราครุฑ 1.5 ซม., consent ก่อนส่ง AI, ไม่มี page error และไม่มี external request
  ใช้เฉพาะข้อมูลสังเคราะห์ใน demo ไม่เรียก Google/Gemini จริง
- ย้อนกลับ: tag image ข้างต้นกลับเป็น `pilot` แล้ว compose up แบบ `--no-build --wait`, deploy API/worker
  จาก `1a857b7` และ import private backup ด้วย operator หากต้องย้อน pack ไม่มี schema เปลี่ยน
- ข้อจำกัดที่ยังอยู่: ยังไม่ได้ทำ real-account acceptance หลัง rollout, ตรวจคุณภาพร่างด้วย Gemini หรือไฟล์ใน Word จริง
  `docs/thai-data-formatting.md` ยังไม่ถูก export และ TOR ยาวอาจข้ามแหล่งอ้างอิงทั่วไปโดยแจ้งในผลตรวจ
  การเปิดให้พนักงาน pilot ยังต้องทำตามเงื่อนไขใน ADR 0001

## 2026-10-25 · เชื่อมคู่มือ TOR และหนังสือราชการจาก Harness ที่ merge แล้ว

- Harness #233/#234 รวมแล้ว และ #235 merge เป็น `2874bf1` หลัง CI ทุกระบบผ่าน ไม่มี PR เปิดค้างในทั้งสอง repo
  ก่อนเปิด PR ของชุดแก้นี้ ไม่แก้ checkout Desktop และไม่เลื่อน engine pin จาก `desktop-v0.6.20`
- แก้งานค้างที่อ้าง `WORKING_FILE_CHARS` โดยยังไม่ประกาศค่า (ทำให้ document tests ล้ม 6 ข้อ) และให้เส้นทาง
  Skill กับเครื่องมือร่างอ่านไฟล์ประกอบได้ถึง 16,000 ตัวอักษร ส่วนแชตทั่วไปยัง 6,000 ไฟล์ที่ยาวกว่ายังแจ้งว่าบางส่วน
- เพิ่มเฉพาะ path ของ `tor-content-by-type.md` ให้ TOR และ `saraban-writing-guide.md` ให้บันทึก/หนังสือ
  ตาม upstream พร้อม provenance ไม่มีเนื้อหาคู่มือหรือเอกสารองค์กรเข้า Git คู่มือ TOR ได้ลำดับก่อนแหล่งอ้างอิงทั่วไป
  ภายในงบบริบทเดิม ไฟล์ที่ไม่พอยังต้องแจ้งใน `document_review` เพดานจริง 32,000 token ยังตรวจด้วย `countTokens`
- ตรวจ pack ใหม่แบบ private: 108 sources / 48 Skills ที่ `2874bf1`, retrieval 61/61 และ buyer identity 3/3
  ผ่าน worker จริงด้วย provider จำลองพบว่าคู่มือใหม่ของ TOR/บันทึก/หนังสือเข้าครบและครั้งเดียว TOR คอมพิวเตอร์ AI
  ยังข้าม `tor-drafting-guide.md` และ `procurement-source-map.md` เมื่อบริบทเต็ม ส่วนบันทึก/หนังสือไม่ข้าม
- แก้ `check-server-types.mjs` ให้เรียก compiler ด้วย Node โดยตรงแทน `npx` ที่ spawn ไม่ได้บน Windows
  และรายงานข้อผิดพลาดการเริ่ม process แทนการล้มตอนอ่าน stdout
- Validation: check, build, unit/API/PWA 94/94, PostgreSQL 29/29 และ Playwright desktop/mobile 76/76
  ใช้ข้อมูลสังเคราะห์ ไม่เรียก AI/Google จริง engine pin ผ่าน แต่ engine isolation test บน Windows ยังล้มที่
  POSIX directory mode (Windows ไม่รองรับ 0700 แบบ Linux) จึงต้องผ่าน Linux CI ก่อน merge ห้ามข้าม isolation test
- ยังต้อง rollout: deploy API/worker, rebuild หน้าเว็บ homelab และ import pack ใหม่ ก่อนหน้านี้ตรวจ source ของ
  worker v24 แล้วตรง main `1a857b7` ทุกไฟล์ที่ใช้งาน (ยกเว้น type-only contracts) มี pack เดิมสำหรับย้อนกลับ
  `docs/thai-data-formatting.md` ยังไม่ถูก export และยังต้องทดสอบคุณภาพร่างกับบัญชีจริงหลัง deploy

## 2026-10-25 · หน่วยงานเจ้าของเรื่องเริ่มเป็นองค์กรของผู้ใช้

- เจ้าของโครงการรายงาน: หน่วยงานรับผิดชอบเป็น STeP อยู่แล้ว ไม่ควรถูกปล่อยเป็น `[รอยืนยัน: หน่วยงานเจ้าของเรื่อง]`
- Desktop เองให้พิมพ์ช่องนี้เอง (agent ของ Desktop เห็นชื่อหน่วยงานจากตัวอย่าง) เว็บจึงเติมช่อง "หน่วยงานเจ้าของเรื่อง"
  / "ส่วนราชการ" / "หน่วยงาน / ที่อยู่ผู้ส่ง" ด้วยชื่อองค์กรของผู้ใช้ (`tenants.name` ตอนนี้คือ "STeP") ตั้งแต่เปิดแบบฟอร์ม
  ผู้ใช้เห็นและแก้หรือเติมชื่อฝ่ายได้ มีข้อความกำกับว่าเป็นค่าเริ่มต้นจากองค์กร
- ชื่อองค์กรอย่างเดียวไม่ทำให้ปุ่มเตรียมร่างกดได้ ต้องกรอกเรื่องของงานอย่างน้อยหนึ่งช่องเหมือนเดิม
- Validation (Node 25.2.1, demo สังเคราะห์): TypeScript, build, unit/API/PWA 89/89, PostgreSQL 29/29,
  Playwright 76/76 (ใหม่: ช่องหน่วยงานเริ่มเป็นองค์กร แก้ได้ และค่าที่แก้ไปถึงข้อความที่ส่งให้ AI)
- ต้อง rebuild หน้าเว็บ homelab เท่านั้น ไม่มี API, worker หรือ migration ยังไม่ได้ทำ

## 2026-10-25 · ร่าง TOR อ่านตัวอย่างที่ตรงงานทั้งไฟล์

- อาการ: ร่าง TOR สำเร็จแล้ว (worker v23 แยกร่างกับผลตรวจ ไม่ถูกตัด) แต่โครง ขนาด ย่อหน้า รายละเอียด และชื่อหน่วยงาน
  ไม่เหมือนตัวอย่างของ Harness metadata ของ run แสดงว่าตัวอย่าง `tor-goods-ai-computer-master-example.md` ไม่ได้ถูกโหลด
- สาเหตุ:
  - Skill มีตัวอย่างนี้เป็นไฟล์ตัวชี้ 438 ตัวอักษร การจัดอันดับนับคำที่ตรงในไฟล์ จึงได้คะแนนต่ำกว่าคู่มือยาว ๆ เสมอ
  - ถ้าได้ ก็ถูกตัดที่ 6,000 จาก 14,811 ตัวอักษร
  - engine ของ Desktop เปิดไฟล์ที่ Skill อ้างถึงทั้งไฟล์เองได้ แต่เว็บต้องเลือกไฟล์ให้ล่วงหน้าในรอบเดียว
  - ตัวส่งออกเป็นตัวเดียวกับ Desktop บทบาทของบรรทัด (บล็อกหัวเรื่องกึ่งกลาง, หัวข้อ, ย่อหน้า) จึงขึ้นกับว่าร่างวางโครงตามตัวอย่างหรือไม่
- แก้:
  - ไฟล์ตัวชี้ถูกจัดอันดับด้วยเนื้อหาของไฟล์ปลายทาง
  - งานร่างเอกสารอ่านตัวอย่างที่เลือกได้ถึง 16,000 ตัวอักษร (แชตทั่วไปยังตัดที่ 6,000)
  - งบประมาณของงานร่างเป็น 48,000 token ประมาณ (ราว 27,000 token จริงตามสัดส่วนที่วัดจาก run จริง 2 ครั้ง)
    เพดานจริง 32,000 ยังตรวจด้วย `countTokens` ก่อนทุกครั้ง
- Validation (Node 25.2.1, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 89/89 (ใหม่: คำขอ TOR
  คอมพิวเตอร์ AI ได้ตัวอย่างเต็มไฟล์ครั้งเดียว ซึ่งล้มกับโค้ดเดิม, นอกงานร่างยังตัดที่ 6,000), PostgreSQL 29/29
  ไม่ได้รัน Playwright เพราะไม่เปลี่ยน UI
- ยังไม่ได้ทำ: แม่แบบ DOCX ของหน่วยงาน (`document-template.ts` ของ Desktop) ซึ่ง Desktop ใช้รักษารูปแบบของหน่วยงานทั้งฉบับ
- ต้อง deploy `worker` (และ `api`) ยังไม่ได้ทำ

## 2026-10-25 · เก็บเหตุผลที่ Gemini ปฏิเสธ เพื่อแยก overload กับคำขอใหญ่

- อาการบน pilot หลัง #28: ร่าง TOR ล้มด้วย `AI_BUSY` 2 ครั้งติดกัน (worker v22) โดยผ่านด่านบริบทและ countTokens แล้ว
  แต่ generate ได้ 503 ทั้งสองครั้ง ครั้งหนึ่งใช้ 64 วินาทีก่อนล้ม ส่วนแชตสั้นช่วงเดียวกันผ่านปกติ จึงน่าจะล้มเฉพาะคำขอใหญ่
  ที่ใช้เวลานาน แต่ log เก็บแค่รหัส 503 จึงยืนยันไม่ได้
- ตอนนี้ log ของ Gemini เก็บ step, HTTP status, `status` และ `message` จาก error body ของ Google (ตัดที่ 200 ตัวอักษร
  และแทนสิ่งที่หน้าตาเหมือน key ด้วย `[key]`), เวลาที่ใช้ต่อครั้ง และว่าเป็นครั้งที่ลองซ้ำหรือไม่ ครั้งแรกที่ได้ 503 ก็ถูกบันทึก
  ไม่มี prompt คำตอบ หรือ key
- Validation (Node 25.2.1, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 87/87, PostgreSQL 29/29 ไม่ได้รัน
  Playwright เพราะไม่เปลี่ยน UI
- ต้อง deploy `worker` (และ `api`) ยังไม่ได้ทำ

## 2026-10-25 · ร่าง TOR ล้มด้วย CONTEXT_LIMIT หลัง rollout #26

- อาการบน pilot: ร่าง TOR ได้ "แหล่งข้อมูลบังคับใหญ่เกินบริบทที่รองรับ" ระบบไม่ส่งงานให้ AI
- สาเหตุ (วัดจากขนาดไฟล์ใน production ไม่ได้เปิดเนื้อหา): #26 ใส่ Skill หลัก, Skill ร่วม
  `thai-official-documents` (11,141 ตัวอักษร), แม่แบบ และเอกสารอ้างอิงทั้งหมด รวมได้ราว 37,000 token ประมาณ
  เกินเพดาน 27,000 ของ worker และมีไฟล์ซ้ำ 4 ไฟล์ที่ทั้ง Skill หลักและเครื่องมือโหลด (แม่แบบ ๑๖ หัวข้อ, คู่มือร่าง,
  แผนที่แหล่งจัดซื้อ, task-adaptations)
- ตัวประมาณนับอักษรไทย 1.1 ตัวต่อ token ซึ่งสูงกว่าที่ Gemini นับจริงราว 2 เท่า (run จริง: ประมาณ ~15,000
  นับจริง 8,211)
- แก้:
  - ไม่โหลดไฟล์ที่ Skill หลักโหลดแล้วซ้ำ
  - งานร่างเอกสารใช้เพดานประมาณ 40,000 (แชตทั่วไปยัง 27,000) เพดานจริง 32,000 token ยังตรวจด้วย `countTokens`
    ก่อนทุกครั้ง 40,000 จะเกินเพดานจริงก็ต่อเมื่อเอกสารนับจริงเกิน 0.8 token ต่อ token ประมาณ
  - Skill ร่วมและแม่แบบเป็นของบังคับ เอกสารอ้างอิงเติมตามลำดับจนเต็มงบ โดยกันที่ไว้ 3,000 สำหรับคำตอบจาก
    เอกสารองค์กร ความจำ ประวัติ และร่างปัจจุบัน (ตอนแก้ร่าง) ไฟล์ที่ไม่พอจะถูกระบุว่า "ข้ามเพราะบริบทเต็ม"
    ให้บันทึกใน `document_review` ไม่หยุดทั้งงาน
- TOR ขนาดเท่า production (ข้อความสังเคราะห์) ตอนนี้ได้ไฟล์ครบทุกไฟล์ ไฟล์ละครั้ง ใช้ราว 31,000 token ประมาณ
- Validation (Node 25.2.1, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 87/87 (ใหม่:
  TOR ขนาดจริงผ่าน worker, งบไม่พอยังคงแม่แบบและระบุไฟล์ที่ข้าม, ไม่โหลดซ้ำ), PostgreSQL 29/29,
  Playwright 74/74
- Rollout: merge #28 (`5cb5970`) หลัง CI ผ่าน แล้ว deploy จาก main ด้วย `--no-verify-jwt --use-api --import-map`
  `worker` เป็น v22 (bundle ใหม่) `api` เป็น v21 (bundle hash เท่า v20 เพราะโค้ด api ไม่เปลี่ยน) ไม่มี migration
  หน้าเว็บ homelab ไม่ต้อง rebuild ตรวจเฉพาะรายการฟังก์ชัน/เวอร์ชัน/สถานะ ยังไม่ได้ลองร่างจริงด้วย Gemini
- ย้อนกลับ: deploy `worker` จาก `b1fe31a` (กลับไปเป็นอาการ CONTEXT_LIMIT) หรือจาก `203cff8` (ก่อน #26)

## 2026-10-25 · Rollout ของ #26 และ #16 (คุณภาพร่าง ตราครุฑ การจัดหน้า)

- Merge #26 (`40231f7`) แล้ว #16 (`b1fe31a`) หลัง CI ผ่าน ทั้งสองเป็นข้อยกเว้นของ feature freeze ใน ADR 0001
  ข้อ 11 ที่เจ้าของโครงการอนุมัติ #16 ถูก rebase ซ้อนบน #26 เพื่อให้ diff มีเฉพาะส่วนการจัดหน้า/ส่งออก
- Supabase (ผู้ดูแลสั่งผ่าน CLI จาก main `b1fe31a` ด้วย `--no-verify-jwt --use-api --import-map`):
  `worker` เป็น v21 และ `api` เป็น v20 ACTIVE `google-callback` ยัง v14 ไม่มี migration ตรวจเฉพาะรายการ
  ฟังก์ชัน/เวอร์ชัน/สถานะ ไม่ได้เทียบ source ที่ deploy และไม่ได้เรียก API จริง
- Homelab: ก่อนแทนที่ ตรวจว่าโค้ดที่รันอยู่ตรงกับ `b9d5f6b` (เทียบ hash ของ `Chat.tsx`, `App.tsx`,
  `package.json` หลังตัด CR) แล้ว tag image เดิมเป็น `step-ai-webapp:pilot-b9d5f6b` เก็บแหล่งเดิมไว้ที่
  `~/STeP-AI-Webapp.prev-b9d5f6b` แล้ว build จาก `git archive` ของ `b1fe31a` โดยคง `.local/homelab.env`
  container `step-ai-pilot-web-1` healthy
- Smoke ผ่าน HTTPS บน tailnet origin เดิม: shell 200, `/healthz` 200, asset ที่ไม่มี 404, CSP คงอยู่,
  ไฟล์ฟอนต์ TH Sarabun ให้บริการจากเว็บเอง และ `manifest.json` ของฟอนต์ตรงกับ hash ที่ตรึงไว้ (`8bafe458…`)
- ย้อนกลับ: แท็ก image `pilot-b9d5f6b` กลับเป็น `pilot` แล้ว `compose up -d --wait` และ deploy `api`/`worker`
  จาก commit `203cff8` (v19/v20 ก่อนหน้าเทียบเท่ากับโค้ดของ `e381eb8`/`203cff8`)
- ยังไม่ทำ: ทดสอบร่างจริงด้วยบัญชีจริงและ Gemini (TOR และบันทึกข้อความ) real-account acceptance และ
  การแก้ `docs/thai-data-formatting.md` ที่ยังไม่ได้นำเข้า (ร่างจะแจ้งเป็นช่องว่าง)

## 2026-10-25 · Garuda, page layout and Desktop's Word/PDF export

- The draft pane now exports with Desktop's exporter instead of the web's simple Markdown-to-Word:
  layout roles for every document tool (title, front matter, sender, date, ที่/วันที่ on one line,
  signature block, first-line indents), the สารบรรณ A4 page (top 2.5, bottom 2, left 3, right 2 cm),
  Thai page numbers, header/footer text, a table of contents, Thai word breaks, and tables sized for
  Thai headers and right-aligned figures.
- ตราครุฑ as Desktop places it: 1.5 cm beside "บันทึกข้อความ" on a memo, 3 cm centred on an external
  letter, first page only; none on TOR, proposals and minutes; "ไม่ใส่ตราครุฑ" for other agency forms.
  The image is Desktop's pinned 800 × 800 PNG with its provenance notice; it carries no authority to
  issue letters, and the pane says the layout must be checked against the agency's form.
- Fonts: TH Sarabun New (memo) or TH SarabunPSK (other official drafts), selectable. The pinned font
  files are served by the site and embedded in the Word file, so it opens the same on computers without
  them. The export result states the font, Garuda height and whether embedding succeeded.
- PDF goes through the browser's print dialog using Desktop's A4 page HTML with the same fonts. A
  "หน้ากระดาษ" view shows that page beside the editor before exporting. Markdown export replaces .txt.
- The export code (including the Garuda) loads only when a draft pane opens; startup JavaScript is
  unchanged (about 740 kB before and after, split differently). Small IBM Plex font subsets are no longer
  inlined as `data:` URIs, which the production CSP (`font-src 'self'`) had been blocking.
- Stacked on the drafting-quality change (#26). Validation under Node 25.2.1: TypeScript, build, 84
  unit/API/PWA tests (new: Garuda bytes, memo, letter and no-Garuda layouts, margins, fonts, PDF page
  escaping), 29 PostgreSQL tests and 74 desktop/mobile Playwright tests (Word with embedded fonts and the
  Garuda header, page preview, PDF print, axe on the pane in both themes). A one-off run of a production build with the homelab nginx
  headers showed the preview, fonts, print and Word export work with no CSP violation.
- Not carried over yet: agency DOCX templates (Desktop's `document-template.ts`), Excel/PowerPoint
  export, images in drafts, and saving export settings with the task. Requires only a homelab frontend
  rebuild; no API, worker or migration change.

## 2026-10-25 · Document drafts follow the Skill, template and drafting contract

- Observed after #25 fixed the canned reply: a TOR run with Skill `tor-government-writing` reached the model
  but the draft was below standard. Run metadata only (no message text) showed it received just the Skill's
  own three support files. The Skill's template is a 349-character pointer to the central 16-section
  template (5,523 characters, present in production) that was never followed; the supporting Skill
  `thai-official-documents` (layout and drafting checks) and the 14.8k-character TOR master example it
  points to were not loaded; the answer used 4,092 of 4,096 output tokens, so it was probably cut short;
  and the answer was not split into draft and review.
- A run now records its document tool (`input.documentTool`, validated against Desktop's five tools).
  The worker loads Desktop's `<document_tool_contract>` (copied verbatim) between organization rules
  and personal preferences, the supporting Skill `thai-official-documents`, the tool's working template
  and drafting references by imported path, and follows short pointer files one hop to the central
  copy. Files the Harness pack lacks are named as gaps the review must record, never filled from
  general knowledge. A revision sends the current draft as untrusted content.
- Document runs may answer with up to 8,192 tokens, only as far as the existing reservation covers:
  the reservation assumes 64k input tokens while context stays capped at 32k. No budget rule changed.
- The answer uses Desktop's `<document_draft>`/`<document_review>` envelope: the draft opens in the
  ผลงาน pane, and the conversation shows only the review and what still needs confirmation. The
  document tool page shows which Skills and template it uses.
- Validation under Node 25.2.1: TypeScript, build, 48 unit/API/PWA tests (new: context assembly,
  pointer files, contract order, output cost bound, and a mocked worker run proving a TOR reaches the
  model with its contract), 29 PostgreSQL tests and 38 desktop/mobile Playwright tests (new: draft goes
  to the pane, review stays in the chat). No live AI call was made.
- Known gap in the imported Harness pack: `docs/thai-data-formatting.md` (date guide) is not imported, so
  drafts list it as missing. Every other template and reference the five tools name is in production.
- Scope: drafting quality only. Garuda, page layout and Word/PDF export stay in #16, held under the
  ADR 0001 feature freeze.
- Requires redeploying the worker and the API and rebuilding the homelab frontend (the web sends the
  document tool). No migration. Not yet done.

## 2026-10-25 · แบบฟอร์มร่างเอกสารได้ข้อความ "ไม่พบเอกสาร" แทนร่าง

- ทำซ้ำได้บน main ด้วย worker จริงและข้อมูลสังเคราะห์: ข้อความจากแบบฟอร์ม TOR (ทั้ง 2 แบบ), บันทึกข้อความ และข้อเสนอโครงการ
  มีคำอย่าง "งบประมาณ" หรือ "พัสดุ" ซึ่งตรงกับเงื่อนไขคำถามเกี่ยวกับ STeP เมื่อค้นเอกสารองค์กรไม่เจอ worker จึงตอบ
  "ยังไม่พบเอกสารองค์กรที่ยืนยันเรื่องนี้ครับ…" ทันที ไม่ส่งงานให้ AI เลย หนังสือภายนอกกับรายงานการประชุมไม่โดน
- แก้: ถ้างานมี Skill ที่เลือกและลงทะเบียนในองค์กรจริง (ทุกแบบฟอร์มส่ง Skill ของตัวเองมา) ถือเป็นการร่างตาม Skill
  ไม่ใช่คำถามที่ต้องตอบจากเอกสาร ส่วนชื่อ Skill ที่ไม่มีในองค์กรไม่ทำให้ข้ามกฎนี้ คำถามเรื่อง STeP ที่ไม่มีเอกสาร
  และไม่มี Skill ยังได้ข้อความเดิม เงื่อนไขเดียวกับส่วนที่ 1 ของ #16 แต่ไม่รวมตราครุฑ การจัดหน้า และ document contract
  ซึ่งเป็น feature (feature freeze ตาม ADR 0001)
- Validation (cloud container, Node 22.22.0, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): test ใหม่ 8 ข้อใน `worker-revocation.test.ts`
  ไม่มีการแก้ 4 ข้อล้ม มีการแก้ผ่านทั้งหมด; `npm run check`, `npm test`, `npm run test:db`, `npm run build`
- ต้อง deploy `worker` (และ `api` ถ้าต้องการให้ตรงกัน) จึงจะมีผลบน homelab ยังไม่ได้ deploy

## 2026-10-25 · รวมบันทึกจาก PR ที่ค้าง

- นำบันทึก rollout จาก #9 (#7/#8, 2026-10-23), #13 (#12, 2026-10-24) และ #15 (Gemini free tier, 2026-10-24)
  มาใส่ตามลำดับวันที่ เนื้อหาเดิมไม่แก้ PR เหล่านั้น conflict กับ main เพราะเพิ่มบันทึกไว้บนสุดของไฟล์เดียวกัน
- แก้คู่มือ deploy ตาม #9: คำสั่ง deploy ต้องมี `--use-api --import-map supabase/functions/deno.json`
  และชื่อ secret ของ Picker คือ `GOOGLE_PROJECT_NUMBER` ตามที่ `supabase/functions/_shared/api.ts` อ่านจริง
  (คู่มือเดิมเขียน `GOOGLE_PICKER_APP_ID`) ถ้าเคยตั้ง secret ด้วยชื่อเดิม ต้องตั้ง `GOOGLE_PROJECT_NUMBER` เพิ่ม
- ย้ายกติกา "ยืนยันการเขียนข้อมูลภายนอกเป็นรายครั้ง" จาก #19 มาเป็น [ADR 0002](adr/0002-confirm-each-external-write.md)
  ส่วนแผน web-only parity ใน #19 ถูกแทนด้วย ADR 0001 แล้ว
- เปลี่ยนเฉพาะเอกสาร ไม่มี deploy หรือ secret

## 2026-10-25 · Protected routes reconciled with the Desktop-parity shell and draft protection

- Merged main `7aaa7d6` (through #23) into the protected-route branch. The shell keeps its lazy-loaded
  tool pages; its `replaceState` page state is replaced by `web/src/routes.ts`, so pages follow
  browser history and anonymous visitors go to `/login?next=…`.
- Main's unsaved-draft protection is kept: an account change clears drafts and the discard prompt
  inside the verified-identity handler, and sign-out still asks before discarding a draft, then
  clears the return path and opens `/login`.
- The Auth browser tests use the new shell: the Skill page opens from the sidebar's เครื่องมือ
  navigation, sign-out runs from เมนู STeP, and "no private view" checks look for that navigation in
  the DOM. The old เมนูหลัก label no longer exists, so those checks would otherwise pass vacuously; the
  sign-in test first asserts the navigation is present.
- Validation (cloud container, Node 22.22.0): TypeScript/Prettier, 65 unit/API/PWA tests, 29 PostgreSQL
  tests, 3 engine tests, production build and 70 of 72 desktop/mobile Chromium checks, including all
  16 Auth checks and the draft regression suites. The two Word download checks fail the same way on
  unchanged main in this container (Chromium 141 names the file `download`); GitHub CI remains
  authoritative.
- The Supabase system is under feature freeze (ADR 0001); this is pilot sign-in hardening, for the owner
  to accept or close. Left: human review, then rebuilding the homelab frontend after merge and
  repeating real-account sign-in, reload and sign-out there.

## 2026-10-25 · ระยะ 2: engine ของ Desktop รันแบบ headless

- เพิ่ม submodule `harness/` ที่ `desktop-v0.6.20` (`90ee71c`) และ `server/` ที่สร้าง `WorkService` ของ Desktop
  โดยไม่มี Electron ไม่ได้ copy หรือแก้โค้ด engine เลย ผู้ใช้แต่ละคนมี SQLite ของตัวเองในโฟลเดอร์ 0700
- เกณฑ์ผ่านของ spike: คำถามพนักงานชุดเดิม **61/61** ผ่าน engine ทั้งเส้น (router → ความรู้องค์กร → prompt)
  โดยเอกสารอันดับแรกที่จะส่งให้ AI ตรงกับคำตอบที่คาดไว้ ส่วนข้อที่ไม่ควรมีเอกสารก็ไม่มี ใช้ adapter สังเคราะห์
  ไม่เรียก AI จริง ทดสอบแล้วว่าตัวตรวจจับความผิดพลาดได้จริง (ตัวตรวจที่ผิดได้ 11/61)
- server profile: เปิด privacy check ส่วน authority check ใช้ค่าเดียวกับ Desktop (ปิด) ถ้าเปิด authority
  คำถาม "เอกสาร WI ฉบับไหนถูกยกเลิกแล้ว" จะติด `AUTHORITY_REVIEW_REQUIRED` ต้องตัดสินว่าจะเปิดหรือไม่ก่อนระยะ 3
- `@github/copilot-sdk` ถูกแทนด้วย module ที่ไม่ยอมเริ่มทำงาน (Copilot ปิดบน server) dependencies เพิ่มแค่
  `mdast-util-from-markdown` 2.0.2 และ `@xmldom/xmldom` 0.8.15 เวอร์ชันเดียวกับ Desktop
- `npm run engine:ask` ให้เจ้าของโครงการลองบน homelab กับ endpoint ที่เข้ากับ OpenAI ได้ ทดสอบกับ endpoint ปลอม
  ในเครื่องแล้วว่าใช้ `CompatibleAdapter` ของ Desktop ได้ทั้งเส้น ยังไม่ได้ลองกับ provider จริง
- CI: checkout submodule, `check:engine-pin` (ต้องเป็น tag `desktop-v*`), `test:engine` และ type check ของ `server/`
  (diagnostics ในไฟล์ engine ปล่อยให้ CI ของ Desktop ที่มี dependencies ครบเป็นคนตรวจ)
- Validation (cloud container, Node 22.22.0): `npm run check`, `npm test` 62/62, `npm run test:db` 29/29, `npm run build`,
  `npm run test:engine` 3/3, `check:engine-pin` ผ่าน และลองให้ pin ผิดแล้วตรวจจับได้ Playwright ไม่ได้รัน (ไม่มี UI เปลี่ยน)
- ยังไม่ทำ: gateway, process แยกต่อผู้ใช้, tool host ของ server, router proxy, ลองกับ provider จริงบน homelab

## 2026-10-25 · ทิศทางใหม่: engine ของ Desktop บน server องค์กร

- บันทึกการตัดสินใจใน [ADR 0001](adr/0001-server-engine-direction.md): เว็บเป็นตัวกลาง งานจริงรันบน engine ของ Desktop
  (git submodule ของ Harness ที่ release tag) บน hardware ที่องค์กรจะซื้อ 1 ผู้ใช้ = 1 engine process + SQLite
  มี gateway ทำ login/เพดาน/admin/audit และ router proxy เลือกระหว่าง API กับ local LLM
- ระบบ Supabase ปัจจุบัน **feature freeze**: แก้เฉพาะ bug และสิ่งที่ pilot ต้องใช้
- เจ้าของโครงการรายงานว่าใช้งานจริงด้วยบัญชีจริงได้แล้ว: Google login, เชื่อม Drive/เลือกไฟล์, แชต Gemini กับเอกสาร STeP,
  ร่างและ export Word, OCR ใบเสร็จจริง agent ไม่ได้ตรวจซ้ำและไม่ได้เห็นหลักฐาน (log/ภาพหน้าจอ) ด้วยตัวเอง
  ยังไม่ได้ทดสอบ: ถอนสิทธิ์หรือยกเลิกระหว่างงานด้วยบัญชีจริง
- รอเจ้าของโครงการก่อนเปิด pilot 3–5 คน: ทดสอบการถอนสิทธิ์ด้วยบัญชีที่สอง (งานต้องจบด้วย `ACCESS_DENIED`
  และไม่มีคำตอบ), ให้กลุ่มผู้ดูแลองค์กรเป็น Owner ของ Google Cloud project, หนังสืออนุมัติใช้ Gemini free tier
  กับเอกสารที่ไม่ลับ และเชิญผู้ใช้ pilot
- ถัดไป (agent): headless spike ของ engine และ benchmark local LLM คู่ขนาน ตามลำดับงานใน ADR
- เปลี่ยนเฉพาะเอกสาร ไม่มีการเปลี่ยนโค้ด, deploy หรือ secret

## 2026-10-25 · แก้ findings จาก audit runtime

- P1 worker: ก่อนส่งบริบทไป AI ทุกครั้ง (หลังรอ Drive/Storage, หลัง countTokens และระหว่าง backoff 503
  ของ countTokens/generateContent/embedContent) worker ตรวจสิทธิ์และ lease ซ้ำ ถ้า revoke หรือ cancel
  จะไม่ส่งบริบทและไม่ retry; ปิดงานด้วย `answer: null` และโค้ด `ACCESS_DENIED`/`RUN_INTERRUPTED`
- P2 ร่าง: ร่างแยกตามงาน คงอยู่เมื่อเปลี่ยนหน้าโดยไม่ใช้ browser storage, response ที่บันทึกช้าหรืออ่านช้า
  ไม่ย้อนข้อความที่พิมพ์ใหม่, มี dialog เตือนก่อนออกจากระบบและ `beforeunload` เมื่อมีร่างที่ยังไม่บันทึก
- P2 ความจำ: แก้ความจำที่หมดอายุหรือเหลือบางส่วนไม่เปลี่ยนวันหมดอายุเดิม เปลี่ยนอายุได้เมื่อผู้ใช้เลือกเอง
- P2 OCR: polling ใบเสร็จลองอ่านงานเดิมซ้ำหลัง network/server error โดยไม่เริ่ม OCR ใหม่ และหยุดเมื่อถูกปฏิเสธสิทธิ์
- Validation (Windows, ข้อมูลสังเคราะห์, ไม่มีการเรียก AI/Google จริง): `tsc --noEmit` ผ่าน, build ผ่าน,
  unit/API/PWA 62/62 (ใหม่ 17 รวม worker-revocation), PostgreSQL/PGlite 29/29, Playwright desktop/mobile 56/56
  `prettier --check` ยังรายงาน 57 ไฟล์จาก CRLF ใน checkout นี้ (ไฟล์ที่ไม่ได้แตะก็ติด) ไม่ใช่ปัญหาเนื้อหา
- Deploy 2026-10-25: operator deploy `api` และ `worker` จาก main `e381eb8` ด้วย
  `supabase functions deploy … --no-verify-jwt --use-api --import-map supabase/functions/deno.json`
  ตอนนี้ทั้งสองเป็น v19 ACTIVE (`verify_jwt=false` ตามเดิม) `google-callback` ยัง v14 เพราะไม่ได้แก้
  ครั้งแรกที่ไม่ใส่ `--import-map` bundle ล้มเหลวที่ `zod` และไม่มีการเปลี่ยนเวอร์ชัน
  v19 รวม Gemini busy retry/`AI_BUSY` จากรอบก่อนด้วย ตรวจเฉพาะรายการฟังก์ชัน/เวอร์ชัน/สถานะ
  ไม่ได้เทียบ source ที่ deploy และไม่ได้เรียก API จริง
- ยังไม่ทำ: real-account acceptance (Google, Gemini, การ revoke ระหว่างงานจริง) และเทียบ source ที่ deploy

## 2026-10-24 · Audit เทียบ Desktop 0.6.20

- ตรวจ Webapp `a5a99d2` เทียบ Desktop `90ee71c` (main/tag `desktop-v0.6.20` ที่ตรวจจาก GitHub)
  หน้าตา โปรไฟล์ แบบฟอร์ม Skill และการเตรียม Prompt ใกล้เคียง แต่ editor/Office/history,
  tool loop, personal Skills, learning และ recurring schedules ยังไม่เทียบเท่า
  ดู [รายงาน audit](desktop-parity-audit-2026-10-24.md) สำหรับหลักฐานและข้อจำกัด
- ทำซ้ำได้ด้วยข้อมูลสังเคราะห์: P1 worker ส่งบริบทหลัง revoke/cancel ระหว่างรอ Drive;
  P2 ร่างหายเมื่อเปลี่ยนหน้า, response บันทึกช้าดึงกลับงานเก่า, แก้ความจำหมดอายุเป็นไม่หมดอายุ
  และ OCR เลิก polling หลัง network error ครั้งเดียว รายงานนี้ยังไม่ได้แก้ runtime findings เหล่านี้
- แก้ข้อความ reference ที่ยังบอกว่าไม่มี TTL UI/โปรไฟล์ และค่า sandbox output limit เป็น 2048
  ไม่เปลี่ยนพฤติกรรมแอปหรือ checkout Desktop
- ตรวจ hosted แบบอ่านอย่างเดียว: migration ครบ 13 รุ่นรวม member_profiles; API/worker ACTIVE v18
  และ callback v14; deployed source โปรไฟล์ตรงกับ checkout แต่ Gemini busy retry/AI_BUSY ยังไม่ deployed
  ไม่อ่านข้อมูลพนักงาน/เอกสาร/grants ไม่ deploy และไม่เรียก AI/Google จริง
- Validation: build ผ่าน, unit/API/PWA 45/45, PostgreSQL/PGlite 29/29 และ Chromium desktop/mobile
  36/36 ผ่าน TypeScript ผ่าน แต่ `npm run check` ติด CRLF และ ignored local settings;
  reference check ติด CRLF เช่นกัน ตรวจ Git-blob SHA-256 แล้วตรงกับ inventory ครบ 91/91
  ตรวจ `npm run check` และ reference แบบไม่ระบุ source ใน clean LF worktree แล้วผ่าน
  ผลเหล่านี้ไม่ยืนยัน real-account/deployment acceptance หรือการแก้ findings

## 2026-10-24 · Gemini busy responses

- Observed on the hosted pilot: two chat runs (13:46 and 13:56 UTC) failed with `AI_SERVICE_ERROR` within
  four seconds, with no document attached; the same short request succeeded a minute later. The worker
  did not record Google's status, so the cause could not be confirmed; a temporary overload (503) of the
  free-tier model fits the pattern.
- Gemini failures now log only the step and HTTP status (never prompt, answer or key). 503 UNAVAILABLE,
  which Google returns when it did not process the request, is retried once after 1.5 s; other failures
  are not retried. 5xx responses that remain are reported as `AI_BUSY` (บริการ AI ไม่ว่างชั่วคราว,
  send again later) instead of the admin-facing service error; countTokens 401/403 now report
  `AI_NOT_CONFIGURED` like generation does.
- A failed run still keeps its reservation in the monthly budget, as before (7 cents at 75/375).
- Validation under Node 25.2.1: TypeScript, build, 45 unit/API/PWA tests (new: retry, busy, logging and
  status mapping), 29 PostgreSQL tests and 36 Playwright tests. Requires redeploying the worker (and the
  API for the shared code); not yet done.

## 2026-10-24 · Gemini free-tier trial enabled

- Merged #14 and deployed API/worker from main `b9d5f6b` (CLI 2.122.0, `--use-api`, shared import map,
  `verify_jwt` false); rebuilt the homelab frontend from the same commit. Rollback image:
  `step-ai-webapp:pilot-408604d`.
- The operator created a Google AI Studio key in a project without billing and set `GEMINI_API_KEY` from
  their own terminal; the key never passed through the agent session. Server settings now select
  `AI_PROVIDER=gemini`, `GEMINI_TIER=free` and `GEMINI_MODEL=gemini-3.6-flash` (a stable model the
  pricing page lists as free of charge). Values were checked by their SHA-256 digests only.
- Settings were switched only after the disclosure build was live, so every consent screen names the
  free AI Studio tier and says Google may use what is sent; use synthetic or non-confidential material.
- Smoke: API 401 for the homelab origin, 403 for a foreign origin, worker 403 without its secret; hosting
  smoke passed and the served bundle contains the free-tier notice.
- Not yet accepted: the tenant budget/rates (set by the owner in Settings), a real chat answer, receipt
  OCR and document indexing. Embedding free-tier availability for `gemini-embedding-2` is unconfirmed.

## 2026-10-24 · Production rollout of #12 (profile, assistant and answer style)

- Merged #12 after CI passed. Before changing anything, hosted migrations matched the 12 in the repo and
  the deployed API source matched main file-for-file (only the type-only `contracts.ts` differs).
- Applied `20261023120000_member_profiles` through the Supabase connector because the CLI had no
  database password in this session; the history row was then renamed from the connector's timestamp
  to `20261023120000` so `supabase migration list` matches the repo. Verified on the hosted database:
  RLS on with read/insert/update policies, no `anon` grants, authenticated updates limited to the
  data columns (not `tenant_id`/`user_id`), memory kinds include `project`, 0 profile rows. The
  security advisor raised nothing for the new table.
- Deployed API and worker version 14 from main `408604d` with Supabase CLI 2.122.0 (`--use-api`,
  shared import map, `verify_jwt` false). google-callback was unchanged and not redeployed. Smoke: API
  401 for the homelab origin, 403 for a foreign origin, worker 403 without its secret.
- Rebuilt the homelab frontend from the same commit; it is healthy and hosting smoke passed over HTTPS.
  The previous image is tagged `step-ai-webapp:pilot-a78b769` for rollback. The synthetic demo saves a
  profile and shows it in the sidebar on the live origin.
- Not yet accepted: saving a profile with a real Google account and a real AI answer using the chosen
  style.

## 2026-10-24 · Profile, assistant, answer style and memory types from Desktop

- Settings opens on โปรไฟล์และผู้ช่วย, as Desktop's ทั่วไป: the 56 Desktop avatar drawings (53 offered),
  the name to be called, main team, assistant name, chat language, the four personality presets,
  คมคาย (Witty) and ชวนคิด (Ob-Oon), and the ภาษาเหนือ language style, with Desktop's prepared
  examples (no AI call). The sidebar shows the avatar, name and "ผู้ช่วย … · ทีม …"; the greeting,
  starters and answer labels use the chosen name, team and assistant.
- Preferences are stored per employee and tenant in `member_profiles` (migration
  `20261023120000`). RLS lets only the employee read or change their own row; tenant admins cannot,
  ownership columns are not updatable, and values are bounded in SQL and the API. Names and the custom
  tone pass the same credential checks as messages.
- The worker appends the run owner's preferences after `SYSTEM_RULES`, opening with a line that ranks
  them below organization rules, sources, authority, approvals and privacy. Speaking-style text is
  Desktop's verbatim. The consent preview lists "ชื่อเรียก ทีม และสไตล์การตอบที่คุณตั้งไว้" when a
  profile exists; nothing else about the employee is added to the request.
- Memories gain Desktop's types (adds บริบทโครงการ), a lifetime in days, their origin (พิมพ์เอง/จากแชต)
  and Desktop's guidance. The consent preview now leaves out expired memories, matching the worker.
- Validation under Node 25.2.1: TypeScript, build, 41 unit/API/PWA tests, 29 PostgreSQL tests (new
  owner-only profile and memory-type checks) and 36 desktop/mobile Playwright tests passed; axe is clean
  on 40 page/theme/viewport combinations. No live AI or Google call was made.
- Requires before it works on the homelab: applying the migration to the hosted project and redeploying
  the API and worker (the frontend alone shows Settings but cannot save). Not yet done.
- Not carried over: Desktop's installed output styles, importance, AI-proposed memories, the lessons box,
  English UI and voice.

## 2026-10-23 · Homelab rollout of #10 (Desktop-parity interface)

- Merged #10 after CI passed. The second CI run followed a fix for a theme-switch contrast flicker
  (button backgrounds no longer animate between themes); CI's first run had caught it at 3.67:1.
- The homelab frontend was rebuilt from main `a78b769` (source copied with `git archive`) and is
  healthy behind Tailscale Serve at the same tailnet origin. The previous image is tagged
  `step-ai-webapp:pilot-8cd4a23` for rollback; earlier source trees were kept, not deleted.
- Hosting smoke passed over HTTPS (static shell, OAuth callback, PWA cache headers, CSP, missing
  assets). The served bundle contains the new interface, and the synthetic demo renders without page
  errors. No Supabase function, migration or secret changed; the contract edit is type-only.
- Not yet accepted: the new interface with a real Google account, Gemini, receipt OCR and the
  OpenRouter sandbox after this rollout.

## 2026-10-23 · Desktop-parity interface and audit fixes

- The web shell now follows Desktop 0.6.20 (`90ee71c`) DESIGN.md: Desktop's theme tokens verbatim,
  a 40px title bar (STeP menu with theme, sidebar toggle, workspace switcher, command bar), a 246px
  sidebar (symbol and MAKE INNOVATION SIMPLE, เริ่มงานใหม่, search, งานทั้งหมด/มีผลงาน, tasks grouped
  by date, folding เครื่องมือ, การตั้งค่า, profile), a folded icon rail, page headers and a status bar.
- Chat matches Desktop: greeting and two-line promise with illustration, team starters that fill the
  composer, and a composer on the home screen. Sending there creates a private task and opens the
  existing consent preview; no AI call happens before consent. Workspace-shared tasks still start from
  เริ่มงานใหม่. The draft opens as a right-hand ผลงาน pane with save and Word/text export.
- Receipt review uses Desktop's layout (original on the left, review sections on the right) and keeps
  the ทดลอง status. Pages lose their eyebrow labels; the command palette also searches tasks.
- Desktop's hand-drawn illustrations are reused in empty and waiting states, cropped to WebP with the
  source and licence note in `web/src/assets/illustrations/README.md`. Sidebar rail icons use Desktop's
  lucide-animated set (MIT, `motion` 14.1.0) plus brain, folder-open and history from upstream; every
  other icon plays Desktop's short hover/focus movement. Both stop under reduced motion.
- Audit fixes: dark-mode contrast for selected tasks, avatars, success/found/missing states, notices and
  the sign-in screen (lowest measured 5.6:1); `aria-current` on navigation and tab semantics on filters;
  44px touch targets on coarse pointers; a 12px floor for Thai text; an in-app update dialog instead of
  `window.confirm`; a keyboard-reachable receipt preview; tool pages load on first open (main bundle
  188 → 147 KB gzip).
- Validation under Node 25.2.1: TypeScript, build, 38 unit/API/PWA and 27 PostgreSQL tests, and 32
  desktop/mobile Playwright tests passed, including a new dark-theme state check. axe (WCAG 2.2 AA and
  best practice) is clean on 40 page/theme/viewport combinations. `prettier --check` reports only CRLF
  line endings in this Windows checkout; content formatting passes with `--end-of-line auto`.
- An independent design review against the Desktop screenshots ran two rounds; its fixes (draft-pane
  sources, Desktop's grey disabled send, drawer scroll, touch hints, menu and Skill copy) are applied.
  `web/PRODUCT.md` and `web/DESIGN.md` record the product and the inherited Desktop design.
- Not done here: no deployment, no real-account check. Desktop-only surfaces (tabs for เว็บ/งานเบื้องหลัง,
  model picker, งานตั้งเวลา, avatar pictures) are not imitated because the web has no such capability.

## 2026-10-23 · Function and homelab rollout of #7/#8

- Merged #7 and #8. API and worker were deployed from main `8cd4a23` with Supabase
  CLI 2.122.0 (`--use-api`, shared import map); both are ACTIVE with `verify_jwt`
  false. Deployed source matches main file-for-file except the type-only
  `contracts.ts`. google-callback was unchanged and not redeployed.
- The first CLI attempt without `--import-map` failed server-side bundling on `zod`
  and changed nothing; the deployment guide now passes the import map.
- The deployment guide named the Picker project-number secret `GOOGLE_PICKER_APP_ID`, but the API
  reads `GOOGLE_PROJECT_NUMBER`; the guide now uses the code's name. If the secret was set under the
  old name, the operator must add it as `GOOGLE_PROJECT_NUMBER` before Picker can work.
- Runtime smoke: API 401 for the homelab origin, 403 for a foreign origin, worker 403
  without its secret; function logs show clean boots.
- The homelab frontend was rebuilt from the same commit and is healthy; hosting smoke
  passed and the served bundle contains `AI_EMPTY_REPLY`. The previous image is kept as
  `step-ai-webapp:pilot-5f7d059` for rollback.
- Not yet accepted: a successful OpenRouter sandbox/chat reply after this deployment,
  Workspace connection, Gemini, worker dispatch through Vault and member denial.

## 2026-10-23 · Homelab origin, first owner and OpenRouter empty replies

- The frontend from main `5f7d059` runs on the homelab (Ubuntu 24.04) as a healthy,
  loopback-only container. Tailscale Serve publishes it inside the tailnet at
  `https://homelab.tail17add1.ts.net:8443`; hosting smoke passed over that origin.
  No public ingress or Funnel was created. Docker requires sudo on that host.
- Auth Site URL/redirect, Google login, disabled email/anonymous sign-in and the
  `APP_ORIGIN` secret were configured by the operator. The API returned 401 for the
  homelab origin and 403 `ORIGIN_DENIED` for a foreign origin. The first verified
  Google sign-in claimed the reserved owner membership; Auth holds only that account.
- Workspace OAuth, Picker and credential-encryption secrets were set by the operator;
  Workspace connection, Gemini, worker dispatch and a member denial test are not yet
  accepted. AI budget remains zero.
- The administrator OpenRouter sandbox reached the provider. One attempt received an
  upstream 429; another spent its 512-token output budget on reasoning and returned no
  text (522 tokens, $0 in OpenRouter Activity), surfacing as `OPENROUTER_RESPONSE_INVALID`.
  The sandbox now requests low, unreturned reasoning with 2048 output tokens, and both
  the sandbox and worker report empty text as `AI_EMPTY_REPLY`. The worker keeps
  `require_parameters` and does not send reasoning options, so non-reasoning pinned
  upstreams remain eligible. Requires API/worker redeployment.
- Validation: TypeScript, formatting, build, 38 unit/API/PWA and 27 PostgreSQL tests
  passed with synthetic provider responses under Node 25.2.1. No live AI call was made
  by tests; Playwright was not rerun because only an error catalogue entry changed.

## 2026-10-23 · Expanded Harness pack import

- Hosted migrations match all 12 local versions. API/worker version 5 are ACTIVE and
  their deployed source matches main after PR #6 (only the type-only `contracts.ts`
  is stripped by bundling); google-callback version 4 is unchanged since that rollout.
- Exported the reviewed baseline from a clean clone at
  `90ee71ca667c63284afe4996eddc7e8095b9a059`: 106 sources / 48 Skills. The upstream
  verifier passed original retrieval 61/61 and buyer identity 3/3. The operator imported
  it into the STeP tenant; hosted SQL confirmed 106 sources and 48 Skills at that version.
  The pack stayed in ignored `.exports/`; no source bodies entered Git.
- The import secret check rejected the pack because `sk` without a separator matched
  `skill-authoring-standard`. Key prefixes now require `sk-`/`sk_`, `ghp_` or
  `github_pat_`, matching the exporter. Synthetic tests keep real key shapes rejected.
  The deployed API/worker still use the earlier pattern for memory/prompt checks and
  need redeployment after merge.
- Export now normalizes Windows path separators, so `.exports/` output works there.
- Validation: TypeScript, formatting (line endings normalized for a CRLF checkout),
  production build, 38 unit/API/PWA and 27 PostgreSQL (PGlite) tests passed under
  Node 25.2.1, outside the declared engine range. Playwright was not run; no UI changed.
  No live AI, Google call, homelab installation or function deployment was performed.

## 2026-10-23 · Protected routes reconciled with Desktop workflows

- Merged the Desktop workflow pages into the protected-route branch. `web/src/routes.ts` is the
  single page list; `/document-tools`, `/media`, `/history` and `/help` now reload, follow browser
  history, redirect anonymous visitors to login and survive the Google sign-in return allowlist.
- Validation: TypeScript/Prettier, 41 unit/API/PWA tests, 27 PostgreSQL (PGlite) tests, production
  build and 44 of 46 desktop/mobile Chromium checks passed, including all 16 Auth checks covering
  the ten page URLs. The two Word download checks also fail on unchanged `main` in the cloud
  container (Chromium 141 reports the file name as `download`); GitHub CI remains authoritative.
- Hosted Auth settings, Google OAuth credentials and real-account acceptance remain pending, as below.

## 2026-10-23 · Desktop workflows and complete product reference

- Audited Desktop 0.6.20 at `90ee71ca667c63284afe4996eddc7e8095b9a059`.
  Added a searchable Thai reference covering 32 feature groups and all 91 top-level
  renderer modules, with pinned source links and a SHA-256 inventory. Statuses
  distinguish web support, partial support and capabilities still requiring Desktop.
- Added the original five document profiles/variants, team starters, internal-media
  Prompt compiler, Thai dates and Word presentation presets. Forms prepare private
  drafts/conversations and still require the existing per-request AI consent.
  Media preparation is local; no image-generation API or external publication is added.
- Added Skill search/team filters/details, source gaps and command search, title/body/draft
  history search under user RLS, theme selection before first paint, original symbol
  artwork, CI colours and a collapsible desktop rail. Word supports Markdown headings,
  bullets/tables, three A4 presets and page numbers; native rich editing/font embedding
  and institutional-template acceptance remain separate.
- Extended private Harness export with 66 non-executable Skill-local references,
  templates and examples: 106 sources / 48 Skills in the reviewed baseline pack.
  Paths/symlinks, restricted registry entries, size and credential checks remain enforced.
  Worker retrieval and the upstream verifier exclude working references from organization
  knowledge. Mandatory sources remain complete or stop on context limits; missing
  originals remain explicit gaps. No source bodies or staff records enter public Git.
- Validation: type/format and production build passed; 38 synthetic unit/API/PWA,
  27 PostgreSQL (PGlite) and 30 desktop/mobile browser tests passed. Browser checks
  include Word XML/layout, local media preparation, consent, history, Skill details,
  responsive layout and WCAG A/AA in both themes. Original private retrieval 61/61
  and buyer identity 3/3 passed; all 91 upstream module hashes were verified.
- The production Docker image built with TLS verification and the environment proxy/CA.
  Its dedicated local container is healthy, non-root (`101:101`) and read-only;
  static hosting/CSP/PWA/OAuth callback smoke passed. GitHub Actions run 39875584009
  passed on the reviewed implementation head. These are local/CI checks, not homelab
  or live provider acceptance.
- A later CI accessibility check caught an intermediate theme frame with yellow
  text over a transitioning light background. Button ink/background now switch
  together; only the border transition remains. Immediate theme checks are retained
  without sleeps, disabled contrast rules or automatic test retries.
- Main's existing homelab/backend changes (#4/#5) are integrated. Matching API/worker
  deployment and operator import of the expanded private pack are still required for
  the new routes/context. The hosted project remains on the previously recorded
  function/pack versions; no live inference, Google write, paid usage, source import
  or real homelab installation was performed for this change.
- The complete capability reference records remaining work: personal Skill approval,
  recurring user schedules, Tasks/Gmail writes, learning/maintenance, rich/native Office,
  browser/Vault/MCP/process tools, voice and image generation. No placeholder action
  claims these have been ported. See [Desktop details](desktop-reference.md).

## 2026-10-22 · Homelab pilot preparation

- Added a reproducible multi-stage Docker build and Compose service for the static
  frontend, with pinned Node/nginx image digests. Only a hosted Supabase URL and
  modern publishable key are accepted as browser configuration. Operator files,
  source credentials and local environment files are excluded from the build context.
- Runtime is a non-root nginx process on a read-only filesystem, with a loopback-only
  host port, bounded resources, PWA cache headers, security headers, SPA/OAuth callback
  routing and a health check. Supabase remains the backend; no database is self-hosted.
- Added Thai setup/rollback instructions for Tailscale Serve over a dedicated HTTPS
  port, plus a hosting smoke checker. The current pilot uses Tailscale; no Cloudflare
  DNS, Tunnel, Access policies or public ingress were created.
- Validation: type/format checks, 24 unit/API/PWA tests, 21 PostgreSQL tests, the
  production build and 16 desktop/mobile browser checks passed. The Docker image
  built and ran healthy; hosting checks verified callback fallback, cache/CSP headers
  and missing-asset handling. Its runtime contains no server credentials or build CA.
- The target homelab is not installed yet: this execution environment has
  `vpn_configured: false` and no TCP grants. SSH installation and testing from an
  actual tailnet device require that network connection first. No live AI was called.
- After combining the frontend consent update from PR #5, the production Docker
  image was rebuilt and ran healthy. Hosting smoke plus four desktop/mobile admin
  trial/accessibility checks passed. The download bundle contains the combined
  source and public Supabase configuration; the real homelab is still not installed.
- Supabase backend reconciliation is tracked in PR #5. The sandbox/shared-quota
  migrations are installed and API/worker/callback are now version 4. SQL verified
  service-only configuration/reservation RPCs, sandbox RLS, zero paid budget and
  disabled worker trial. Merge that frontend consent update before installing this
  checkout; the prepared bundle combines both PRs. The actual HTTPS origin,
  replacement trial credentials and live Google/AI acceptance are still pending.

## 2026-10-22 · Administrator OpenRouter free trial

- Added Settings → เชื่อมต่อ AI → ทดลอง OpenRouter Free for active tenant owners/admins.
  The separate channel accepts only explicitly consented synthetic text, without
  organization documents, memory, chat history or Google Workspace context.
- Server-only credentials and a single configured tenant gate access. Every call
  checks the live catalog for a zero-priced `:free` text model and sets zero price
  ceilings with provider fallbacks disabled. No paid AI budget or purchase is enabled.
- Service-only SQL reservations enforce idempotency and shared limits of 5 attempts
  per minute / 40 per UTC day, including failed attempts. Prompts/replies are temporary
  UI state; only reservation IDs/timestamps are persisted. Provider errors are sanitized.
- Validation: type/format checks and production build passed; 24 synthetic unit/API/PWA
  tests, 21 PostgreSQL isolation/accounting tests and 16 desktop/mobile Playwright tests
  passed, including consent reset, temporary result clearing and accessibility.
- Not activated in production: this environment has no Supabase credentials and its
  outbound policy does not permit OpenRouter. No transcript key was installed or
  committed and no live inference was attempted. Activation requires applying the new
  migration, deploying the API/frontend, setting a replacement `OPENROUTER_API_KEY`
  with `OPENROUTER_TRIAL_TENANT_ID`, then real-account authorization and $0 billing
  acceptance. Existing hosting/Google rollout requirements below remain applicable.

## 2026-10-22 · Supabase Auth and protected routes

- Added a public `/login`, PKCE callback handling, and stable URLs for all six workspace screens.
  Anonymous deep links preserve an allowlisted destination through Google sign-in; reload and
  browser back/forward follow the URL. The synthetic preview remains a separate Host.
- Auth.getUser validates restored and refreshed identities before loading workspace data.
  Account changes and sign-out clear private state; API 401 returns to login. Existing Google
  identity, invitation, tenant, resource and Storage authorization remain enforced server-side.
- A single-use callback exchange is shared across React StrictMode initialization effects.
  Failed/missing callback codes produce sanitized login errors without exposing provider details.
- Added configured-Auth browser checks with synthetic responses alongside the existing preview
  checks, plus unit coverage for redirect allowlists, token verification and callback replay.
- Local verification against main including OpenRouter: TypeScript/Prettier, 27 unit/API/PWA tests,
  21 PostgreSQL isolation tests, production build, and all 32 Chromium desktop/mobile checks passed.
  Chromium was installed
  after an initial missing-browser failure. No real Google identity was used in these checks.
- Read-only query of the existing hosted project confirmed all 16 public tables have RLS enabled.
  No hosted Auth settings, database schema, staff records or production deployment changed.
- Google OAuth credentials, a real Pages origin and real-account acceptance remain required.
  The Supabase connector has no Auth configuration update tool; the browser Dashboard requires
  sign-in. Follow [auth-setup.md](auth-setup.md) to complete the controlled setup in the Dashboard.

## 2026-10-22 · Supabase backend reconciliation

- Recovered the existing provider/Vault migrations and version-3 function behavior
  into source while retaining the administrator-only, temporary Settings sandbox.
  Worker chat remains a separate opt-in channel; paid budgets are unchanged.
- Added shared account admission for both OpenRouter paths: 40 attempts/day UTC
  and 15/minute, including failed/cancelled/purged jobs. The sandbox also retains
  its 5/minute tenant limit. Admission locks precede tenant locks for free jobs.
- Added the sandbox tenant restriction to the service-only Vault allowlist.
  Environment values take precedence; configuration failures return a sanitized 503.
  Browser confirmations bind provider/model/upstream consent, and the API/worker
  reject stale consent before sending context. Text-only mode disables OCR/indexing.
- Validation: type/format and production build passed; 31 unit/API/PWA, 26 real
  PostgreSQL (PGlite) and 16 desktop/mobile browser/accessibility checks passed.
  Vault tests use synthetic rows; multi-connection contention, actual OAuth and
  provider billing still require live acceptance. No live AI was called.
- The combined PR #4/#5 frontend built and ran as a healthy non-root, read-only
  Docker container. Hosting smoke and four desktop/mobile sandbox/accessibility
  checks passed against that production image. The operator bundle was refreshed
  with matching frontend source and public configuration only.
- Applied the sandbox and shared-quota migrations in the hosted project as
  `20261022164853` and `20261022164909`; local filenames match all 12 remote versions.
  The earlier sandbox migration had not been deployed and was renamed to its
  assigned version without rewriting remote history. API/worker/callback version 4
  are ACTIVE, with the sandbox route and provider consent verified in deployed source.
- Hosted SQL confirmed the service-only RPC ACLs, sandbox RLS, shared quota/Vault
  allowlist definitions, no public table without RLS, zero paid budget and disabled
  worker trial. Security advisors show only the documented 12 intentional RPC WARNs
  and four policy-free private-table INFOs. No server key was printed or installed.
- Direct HTTP smoke could not reach the hosted function URLs with the available
  network tools; deployment/source checks do not establish runtime or login acceptance.
  Homelab SSH, the real HTTPS origin, replacement trial credentials and real-account
  trial acceptance remain pending. The sandbox tenant restriction is unset in Vault.

## 2026-10-22 · Centralized PWA implementation

- Source baseline: STeP-AI-Harness `90ee71ca667c63284afe4996eddc7e8095b9a059`, Desktop 0.6.20.
- Separate repository: `iisara555/STeP-AI-Webapp`. Original Desktop repository is unchanged.
- Target: invited Google accounts, STeP tenant first, private workspaces with explicit sharing,
  owner-only memory/documents, centrally managed Gemini, Google Workspace and cloud receipt OCR.
- Public code includes no organization documents, employee records or API secrets.

### Implemented

- Invited, verified Google identities; service-only first-owner reservation and tenant bootstrap.
- SQL-enforced tenant/resource/Storage isolation; private workspaces and editor/viewer sharing.
- Personal and shared memory with confirmation, deletion, expiry and context limits.
- Authorized chat, source preview, consent, durable jobs, cancellation, drafts and Word/text export.
- Original Thai knowledge retrieval and authority factory adapted to per-tenant inputs.
- Central server-only Gemini, selected Drive text and read-only Calendar in private conversations.
- Private uploads, Office/PDF text extraction, bounded embedding indexing and explicit OCR.
- Receipt originals plus image derivatives, signature/buyer checks and separate human reviews.
- Installable shell, public-assets-only service-worker cache, mobile layout and accessible controls.
- Budget reservations/idempotency/leases, aggregate usage and deletion-safe accounting.
- Operator export/import/bootstrap tools, CI and a manually configured Pages deployment workflow.

### Verification

- TypeScript, formatting and production build passed; production dependency audit found no vulnerabilities.
- Unit/API/PWA checks: 19/19 passed, using synthetic provider responses and no live model calls.
- Real PostgreSQL (PGlite + pgvector) checks: 18/18 passed. Tests emulate permissive Supabase
  function defaults and synthetic Auth/Storage tables, including cross-tenant/private/admin isolation,
  worker RPC denial, shared-context scope, reservation accounting, cancellation/revocation, draft
  conflicts, owner bootstrap, receipt review and deletion. Full local Supabase stack was unavailable
  because its container registry was blocked; these do not replace real Auth/Storage acceptance.
- Chromium desktop/mobile checks: 14/14 passed, including consent, memory/document flows,
  receipt image preparation and saved edits, Word ZIP/content validation and WCAG A/AA checks.
  Browser tests use the explicitly labeled synthetic preview, not live Google or Gemini.
- Private upstream corpus: original retrieval/abstention 61/61 plus buyer identity 3/3 passed.
  Corpus/source files stayed outside Git; this does not measure generated-answer accuracy.

### Cloud state

- Dedicated Supabase project `zwwchjshmxdzhhotacte`, Singapore, provisioned after a $0/month quote.
  Existing Jorde project and Desktop repository were not changed.
- Eight schema migrations applied; local versions aligned with remote history. Vector, pg_net,
  Vault and cron verified installed; scheduler jobs registered but dispatch remains inert until
  its worker URL/secret are configured in Vault.
- STeP tenant created, requested owner reserved until verified Google login, AI budget zero.
- Baseline pack imported privately: 38 registered documents, two governance registries and 48 Skills.
  Staff titles reuse Desktop labels; developer-only/native-browser Skills are hidden from the web hub.
- API, worker and Google callback functions deployed. Live unauthenticated API smoke returned 401;
  worker returned 503 without configured credentials, before claiming work or calling AI.
- No public data table lacks RLS. Service worker/grant/import/bootstrap RPCs deny anonymous and
  ordinary authenticated execution. The intentional SECURITY DEFINER and private-table advisories
  are documented in operations.md. Permissive hosted function defaults were found and corrected.

### Required before staff rollout

- Create/connect the STeP Cloudflare Pages account/project and obtain its actual default URL.
- Configure Supabase Google login and Workspace web OAuth, real callback origins and Picker.
- Set server Gemini/worker/encryption credentials, Vault dispatch entries and reviewed token rates.
  No Gemini key from the conversation is embedded or enabled by this implementation.
- Verify real Google accounts and selected-file permissions; measure OCR on permitted labeled receipts;
  confirm generated Word files in the organization's editor; complete offsite backup/restore acceptance.
- Automated capacity alarms/database-size admission, binary Drive export and automated Desktop
  personal-history migration remain follow-up work; native execution stays in Desktop.

### Current-run result isolation: authority integration gap

Synthetic snapshot tests cover mapping an early return that leaves a prior review and trace untouched. The real gateway tests cover a grounded answer, an ungrounded follow-up, provider failure, and cancellation after a partial response. They do **not** exercise an early authority denial: the workspace runtime uses `serverPolicy()` with the Desktop default authority checks disabled and offers no supported override. These tests do not establish production authority enforcement; integration coverage requires a separately supported policy path. No authority policy was changed.
