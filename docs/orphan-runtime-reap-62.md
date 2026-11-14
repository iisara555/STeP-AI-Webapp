# #62 residual — reaping runtimes a crashed manager left behind

**Status:** implemented for the step-runner driver (synthetic-only; the production gateway stays fail-closed).

## Problem

The writer fence (`server/src/workspace/writer-fence.ts`) passes a data root to a successor once its holder
dies. A SIGKILLed manager does not stop its step-runner scopes (`systemd-run --user --scope` → `sudo -n -u
step-runner bwrap …`), so a successor could start the same workspace while the orphan was still writing
`p<ID>/files`.

## Mechanism

- **Launch journal** (`server/src/workspace/launch-journal.ts`): `<dataRoot>/runtime-launches/` (0700, ours,
  created by the first record). One file per launch, named `<kind>~<unit>`. The **name is the identity**, so an entry
  whose body a crash truncated still names its unit. The JSON body (workspace id, sha256 of the launch nonce, pid,
  time) is informational. Any other entry fails closed.
- **Journal before spawn** (`step-runner-driver.ts`): after the socket is set up and **before `admit`**, the driver
  records `{kind: 'step-runner', unit}` and fsyncs both the file and the directory. If the record fails, the start
  returns `RUNTIME_START_FAILED` (cause `LAUNCH_JOURNAL_FAILED`) and admission never runs. The synchronous
  admission/spawn section and pinned-launch semantics are unchanged. The entry is resolved (unlinked, directory
  fsynced) only when the processes are proven gone (`processesGone` in teardown) or nothing was spawned (admission
  denied or skipped, pin failed). If a resolve fails, the entry stays for the next holder.
- **Contract** (`contract.ts`): adds optional `RuntimeDriver.recovery = { kind, journaled(journal) → driver,
reap(unit) }` and `WorkspaceErrorCode 'RUNTIME_RECOVERY_PENDING'` (gateway: 503). The synthetic assembly and
  `nativeQuotaBoundary` wrappers pass `recovery` through. In the native-quota case the journaled driver is wrapped
  again, so pinned launch is still the only way in.
- **Manager** (`manager.ts`): after it acquires the fence, it opens the journal and swaps in
  `driver.recovery.journaled(journal)`. If that fails, the fence is released and the error is rethrown. It starts
  recovery eagerly, and `start()` awaits it before it reads, authorizes or admits anything. Every open entry must be
  reaped by a driver of the same `kind`. While any entry is unproven or unreadable, or no driver can reap its kind,
  every start fails with `RUNTIME_RECOVERY_PENDING` and the next start retries. `shutdown()` waits for a reap that is
  in flight before it releases the fence.
- **Reap** (`stepRunnerDriver().recovery.reap`), with names restricted to `^step-rt-[0-9a-f]{32}\.scope$`:
  1. Launchers: SIGKILL every process of this uid whose argv contains `--unit=<unit>`, repeating until none is left.
     That covers the window before `systemd-run` has created the scope and exec'd sudo. Once none is left, nothing
     can create that scope again, because the previous manager is dead.
  2. Scope: take the cgroup the user manager reports (it must lie under this user's `user@<uid>.service`) **and**
     every directory with that name under that subtree. That second source covers a scope systemd has forgotten.
     Each one is `cgroup.kill`ed until `populated 0` or ENOENT, within `stopTimeoutMs`. If `systemctl show` fails, a
     cgroup refuses to empty, or the path is foreign, the reap is `RUNTIME_STOP_FAILED`, never "gone".
  3. Housekeeping, which is not part of the proof: `systemctl stop`/`reset-failed`, and removal of the socket folder.
     The socket folder now shares the unit's random launch id (`<socketRoot>/<id>`).

## Assumptions and residual limits

- **No reuse of names:** each launch gets 128 random bits, and this driver never starts a recorded name again. An
  unrelated later unit with the same name is assumed negligible; the reap does not check an InvocationID. A
  same-uid hostile process that creates `step-rt-<that id>.scope` on purpose is outside the threat model, as in
  #57.
- **What absence means:** "no launcher and no cgroup of that name" counts as proof only because step-runner owns no
  cgroup it could migrate into, and because `systemd-run --scope` execs the workload only after it is inside the
  scope. Host policy changes that let the runner write cgroups would break this.
- **PID matching:** launchers are matched by argv and killed by PID, not pidfd. A PID reused between the /proc read
  and kill(2) is a theoretical TOCTOU. Only this uid's processes are touched.
- **Process driver:** `processDriver` has no `recovery`. Its children are not journaled, so a crash can still orphan
  them (they usually exit when their channel closes). Runtimes of any driver without `recovery` are not covered.
  Entries left by a recovering driver still block such a successor, so it fails closed.
- **Power loss:** a record is durable before admission. After a reboot the reap simply proves the units absent.
- **Stuck orphan:** an orphan that cannot be proven gone (for example a failing `cgroup.kill`) blocks **every** start
  on that data root, not only its own workspace. That is deliberate: it fails closed, and an operator has to step in.
