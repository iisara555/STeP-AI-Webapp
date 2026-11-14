# systemd-create stop — incarnation-bound stop of an anchor (NOT installed)

`stop.[ch]` (`libstep-systemd-stop.a`) stops exactly one anchored
`step-lc-<epoch>-<slot>.service` incarnation created by [`create.c`](README.md)
and nothing else. It is a trusted local API for the single lifecycle owner,
not linked into any service. **A successful stop releases nothing**: it only
makes the incarnation inactive/failed, so the existing
[create-reconcile](../launch-composition/CREATE-RECONCILE.md) / observer path
can later prove absence and cleanup and release through the ledger.

## Inputs

- The durable `lc_entry` (STARTING, RUNNING, STOPPING or FENCED; never RESERVED
  or RELEASED) and the identity fields of its complete create journal: bus id,
  manager unique name, InvocationID and create JOB id (the caller takes them
  from `lcr_parse` after `LCR_ANCHORED`). `las_open` renders create.c's exact
  `INTENT v1` / `JOB` / `ANCHOR` lines from these inputs and requires the create
  journal (root-owned 0600, one link) to equal those bytes. No second parser
  exists; unit and cgroup are derived (`<container>.service`,
  `/system.slice/<unit>`), never chosen.
- A **separate, fresh, single-use stop journal** (root-owned 0600, one link,
  empty, `O_RDWR`). The create journal is never written: create-reconcile
  keeps parsing exactly three lines and nothing in its format changes.
- `exclusive()`, which must return exactly 1 at open, at begin entry, after
  the STOP line, before the Stop send, at every poll entry, at readback
  start/end and after the STOPPED line (8 calls on success).

`las_open` takes `flock(LOCK_EX|LOCK_NB)` on both journals' open file
descriptions: an in-flight creator or `lcr` handle on another description of
the create journal, or a second stopper on the stop journal, refuses. As for
`lsc_open`, a refusal after the lock leaves the lock on the caller's
description until the caller closes it, and same-description handles are the
caller's to serialize.

## Stop journal (append-only, one attempt)

```text
STOP v1 <slot> <launch> <unit> <bus id> <manager> <invocation> <create job>
KILL all 9
JOB <job> /org/freedesktop/systemd1/job/<job>
STOPPED <job> <invocation> <inactive|failed>
```

Each line is `write`+`fsync`ed before the next step. `STOP` is durable before
the first mutation, `KILL` before the Stop job is requested. An empty journal
proves nothing was attempted; `STOP` alone means Kill may have been sent;
`STOPPED` means the readback below succeeded. A journal with any byte is never
accepted again; a later attempt needs a new journal (each attempt re-verifies
the incarnation, so a retry cannot hit a replacement). No reconciler for stop
journals exists yet; they are evidence, not authority.

## Chosen semantics (systemd 259, checked read-only on this host)

1. **Address the incarnation, not the name.** All reads and both mutations go
   to `/org/freedesktop/systemd1/unit/<encoded InvocationID>`. systemd resolves
   such a path only while that invocation is the unit's current one
   (`GetUnitByInvocationID` returns exactly this path; an unknown/replaced ID
   fails with `org.freedesktop.systemd1.NoUnitForInvocationID`). `StopUnit` /
   `KillUnit` by name could hit a replacement started between check and call;
   the invocation path cannot.
2. **Verify immediately before acting** (and once earlier, before `STOP`):
   kernel peer uid 0, bus id, `GetNameOwner(org.freedesktop.systemd1)` = the
   journal's manager and its uid 0; then `GetUnitByInvocationID` = the encoded
   path, `Id` = our unit, `InvocationID` = ours, `ControlGroup` = ours,
   `ActiveState=active`, `Job=(0,"/")`. Every blocking call is capped at the
   time left of the 5 s attempt deadline (never above 2 s), as `budget()` in
   create.c. Connection/authentication/Hello readiness is included in that same
   deadline, before GetBusId/owner calls; see [D1 connection deadline](README.md#connection-deadline-d1).
   The real stalled-socket regression uses only a private unprivileged listener,
   never this host's system bus.
3. **`Unit.Kill("all", SIGKILL)`, then `Unit.Stop("fail")`.**
   - `Stop` alone sends SIGTERM (keeper `pause()`s → exits) and waits up to the
     default 90 s `TimeoutStopSec` for a workload that ignores SIGTERM, far past
     the deadline. Worse, a keeper killed by its own SIGTERM is a _clean_
     service exit → `inactive` → with the anchor's `CollectMode=inactive` the
     unit is garbage-collected at once, and NoSuchUnit without a prior absence
     receipt is UNKNOWN forever in create-reconcile.
   - `SIGKILL` to every cgroup process is not a clean exit → `failed
(Result=signal)`, which `CollectMode=inactive` keeps loaded with its
     InvocationID as evidence. `whom=all` (not `all-fail`): a keeper that died
     on its own between check and call is not an error; the readback decides.
   - The following `Stop` gives a job correlated with its exact `JobRemoved`
     (match `sender`+`path`+`interface`+`member`+`arg2=<unit>`, job id from the
     reply, result `done`, no other job for our unit) and completes only when
     the unit has fully reached inactive/failed. On an already failed unit
     systemd finishes the stop job as `done` without resetting its failed state
     (`unit_stop` returns `-EALREADY` → job `done`).
   - Mode `fail`: a conflicting queued job makes systemd refuse
     (`TransactionIsDestructive`) instead of replacing/cancelling it.
   - These job/state transitions are from the systemd sources and have **not**
     been exercised by a real root Kill/Stop on this host; only signatures,
     invocation-path resolution and the readers were checked live.
4. **Readback after `JobRemoved(done)`** through the same invocation path:
   same Id/InvocationID, `ActiveState` `inactive` or `failed`, no job, and
   `ControlGroup` equal to ours **or empty** — systemd clears `ControlGroup`
   once a stopped unit's cgroup is pruned (live: every loaded inactive/failed
   service here reports `ControlGroup=`). Then owner, authority and deadline,
   then `STOPPED`.
5. **Never from a stop handle**: `ResetFailedUnit`/`ResetFailed`, `StopUnit`/`KillUnit` by name,
   job `Cancel`, mode `replace`, retries, or touching the create journal or
   ledger. `las_close` only drops local subscriptions.

## Reset readiness deadline

`las_reset` uses the same absolute five-second attempt budget as `las_begin`:
set the method timeout before `sd_bus_start`, then drive nonblocking readiness
before owner/GetBusId queries. Readiness never refreshes the budget. The real
libsystemd `test-deadline-reset` connects only to a private stalled Unix listener,
requires UNCERTAIN/DEADLINE around five seconds, an empty reset record and no
`ResetFailed` bytes on that socket. Address/peer overrides remain behind the
existing compile-guarded, pin-scanned fixture seams.

## Post-absence reset (separate handle, not installed)

`las_reset_open(config, absent, context, &handle)` uses the same protected
create evidence and authority contract, but `stop_fd` must be a **fresh reset
record**, never a stop journal. `absent(context, &entry)` must return exactly 1
for this entry's observer receipt at open, entry and after durable intent.
Only a trusted caller holding the continuous lifetime fence may provide it.
`las_begin` refuses reset handles; `las_reset` refuses stop handles and consumes
one attempt even on failure. The create journal is unchanged.

`las_reset` checks the root peer, historical bus/manager, exact invocation
path/Id/InvocationID, inactive-or-failed state, ControlGroup ours-or-empty and
no job; writes and fsyncs:

```text
RESET v1 <slot> <launch> <unit> <bus id> <manager> <invocation> <create job>
RESET-DONE <invocation> <inactive|collected>
```

The first line is durable **before** the one typed `Unit.ResetFailed()` call
on the InvocationID path. Authority, receipt, unchanged create evidence, owner
and stopped identity are checked again before the call. There is no reset by
name, global reset or cancellation. Readback requires the invocation to be
explicitly gone (`NoUnitForInvocationID`), or still exact and now inactive,
then rechecks owner/authority/deadline before the durable completion line.
`LAS_RESET`/return 1 is not an absence or cleanup proof and releases nothing.
Any failure is UNCERTAIN, retains capacity and never retries on that handle.
No reset-record replay/recovery implementation is included.

Semantics rechecked read-only against upstream **v259** sources:

- [dbus-unit.c](https://github.com/systemd/systemd/blob/v259/src/core/dbus-unit.c):
  `ResetFailed` has no arguments/result; `bus_unit_method_reset_failed` invokes
  `unit_reset_failed` after authorization.
- [dbus-manager.c](https://github.com/systemd/systemd/blob/v259/src/core/dbus-manager.c):
  `method_get_unit_by_invocation_id` explicitly returns an invocation-addressed
  path that stays valid only while the invocation matches.
- [manager.c](https://github.com/systemd/systemd/blob/v259/src/core/manager.c):
  invocation-addressed unit lookup uses `units_by_invocation_id`; an unknown
  ID returns `NoUnitForInvocationID`, without falling back to a unit name.
- [unit.c](https://github.com/systemd/systemd/blob/v259/src/core/unit.c) and
  [service.c](https://github.com/systemd/systemd/blob/v259/src/core/service.c):
  reset clears failure/start-rate-limit state; failed service transitions to
  its dead state. `CollectMode=inactive` permits subsequent GC, not guaranteed
  immediate GC (references/jobs may keep metadata).
- [cgroup.c](https://github.com/systemd/systemd/blob/v259/src/core/cgroup.c):
  `unit_release_cgroup` clears the stored cgroup path; this empty property is
  not evidence of emptiness. The observer still requires original pinned
  `populated 0` and the lifetime-fence bracket before any reset.

The fake-bus reset fixture covers gates at each stage, exact request arguments,
durable intent, single-use/API separation, replacement, malformed/error
replies, state/path/job readback, collection, fsync and deadline faults. The
reconciler's optional callback and this adapter are tested separately; actual
owner linkage and end-to-end stop/observe/reset/cleanup acceptance remain open.

## Pending jobs (drain policy)

A pending job on the unit (any `Job != (0,"/")`) is refused: before `STOP` this
leaves an empty journal (nothing attempted), immediately before Kill it leaves
`STOP` only with Kill never sent, and after the Stop job it is UNCERTAIN.
Safe cancellation of the exact job is **not** implemented: the job's type and
originator cannot be bound to our incarnation atomically with `Job.Cancel`
(the job can start running, be merged or replaced in between, and a queued
restart/start belongs to whoever issued it). Cancelling it could also discard
the evidence the observer needs. The owner retries later with a fresh journal.

## Outcomes

`las_poll` returns 1 (`LAS_STOPPED`, receipt `{job, invocation, state}`), 0
(pending) or -1 (`LAS_UNCERTAIN`). Every UNCERTAIN carries a reason
(`las_reason`): AUTHORITY, CREATE, JOURNAL, BUS, OWNER, QUERY, REPLACED,
STATE, JOB, KILL, STOP, EVENT, DEADLINE, DISPATCH. Any error, timeout,
mismatch, replacement, fsync fault or flood to the deadline is UNCERTAIN and
capacity is untouched. Event-loop callers use `las_fd` / `las_events` /
`las_timeout` exactly like the creator's.

## Verified (unprivileged)

`make -C native/systemd-create clean all test analyze sanitize`:

- `test-stop` (fake bus in test-create.c's style: typed token messages with
  sd-bus cursor rules, a FIFO delivered only by `sd_bus_process`, every request
  argument asserted, exact call trace; the fake aborts on any member other
  than the read-only queries, `Unit.Kill("all",9)` and `Unit.Stop("fail")` on
  the invocation path, and asserts the STOP/KILL lines are durable before the
  respective mutation): success (failed, inactive, cgroup still reported);
  authority sweep over all 8 rechecks and owner sweep (peer, bus id, manager
  name, manager uid, trailing replies) over all 5 owner calls at the exact
  stage; every identity/state/job perturbation (replacement via
  NoUnitForInvocationID, other path, other Id/InvocationID/ControlGroup, empty
  or overlong cgroup, other states, pending job) at each of the three
  verifications with the asserted reason and Kill count; malformed and failed
  Gets; bus/Subscribe/Kill/enqueue faults; fsync faults on all four lines
  (failed STOP fsync leaves the journal unreusable); event correlation (other
  job, id/path disagreement, failed/canceled/timeout, duplicate, foreign unit,
  malformed body); Stop reply error/trailing/bad paths incl. `2^32+9`; 32-per-poll
  flood, endless flood to the deadline, lost reply, lost event, event before
  reply, separate polls, spoofed sender, dispatch error; slow calls and an
  exact-deadline clock at each phase, a clock failure at **every** clock read,
  Stop reply timeout capped at the time left; create journal mismatch for each
  identity field, wrong attributes/lock holders, change between open and begin
  and between STOP and Kill; stop journal attributes, offset, lock, written
  before begin; every validator with a consistently rendered create journal.
- GCC `-fanalyzer`, ASan/UBSan (`test-stop-sanitize`), link of `stop.o` against
  the real `libsystemd.so.0` (`test-link`).
- `make pin-check`: `stop.o` carries no `LSC_TESTING` hook (same fail-closed
  `pin-scan.sh`, anchors `las_open`/`GetUnitByInvocationID` for stop objects);
  `pin-check-negative` (g) proves a bare `-DLSC_TESTING` stop.c stops at its
  `#error`, hooked stop objects (`-g`, `-g0`, each scan arm alone) and
  `make pin-check` with a hooked `stop.o` are refused.
- `make mutation` includes `mutation/stop-mutations.json` (147 deletions or
  weakenings of stop.c's guards, checked by `test-stop`) and four new pin
  mutations (PN18–PN21: stop.o scan in `pin-check`, stop.c marker and
  `#error`, per-object scan anchors). Guards found provably redundant during
  this run were deleted rather than listed: the create journal's type/size/
  access-mode checks (the one-past-maximum `pread` comparison implies them),
  `property_end`'s inner `at_end` (`exit_container` refuses unread values),
  the reply/event handlers' state and duplicate-reply guards (dispatch stops at
  the first terminal state; sd-bus delivers a reply once), job-path length
  checks, `unique_name`'s length floor, the container terminator check
  (implied by equality) and the event's path-validity disjunct (an invalid
  path leaves job 0, which never correlates).
- The stopped-observer/reset increment adds `mutation/reset-mutations.json`
  (29 reset guard/ordering mutations). All specified lists were exercised
  through their harnesses with preserved exit status: 64 create, 21 pin,
  147 stop and 29 reset, all killed. Stop and composition lists used bounded
  batches with distinct scratch parents and verified complete ID sets; failed
  pattern runs were corrected and rerun, not counted as passes.
- `make host-check` also runs `host-probe-stop` (read-only): production
  `owner()`, `by_invocation()` and `verify()` against the real bus on
  `dbus.service` (BEFORE accepted, AFTER refused as STATE, another unit's name
  refused, unknown InvocationID → REPLACED via the real error name) and a
  loaded failed service (AFTER accepted, `ControlGroup` empty); live
  introspection of `Unit.Kill(si)`, `Unit.Stop(s)→o`,
  `Manager.GetUnitByInvocationID(ay)→o`, `JobRemoved(uoss)`, `Subscribe()` and
  the five properties read. No Kill or Stop was sent.

Kept as defense in depth, not mutation-proven: the stop journal's `S_ISREG`
(an unprivileged fixture cannot create the root-owned 0600 character device it
guards against; a FIFO is already refused by `lseek`), sd-bus non-NULL
out-parameter checks, allocation/message-build failures, `write` short/EINTR
handling, `render_create` truncation (unreachable after field validation) and
`SO_PEERCRED` length.

## Not done (production blocked; `install`/`install-check` still refuse)

- Empty stopped ControlGroup and a separately gated post-absence reset now
  exist. Missing pre-pruning populated-0 observation still returns UNKNOWN;
  a removed descriptor is cleanup evidence only, not a new absence proof.
- **D1 addressed for reset:** authentication/Hello readiness now shares the
  original five-second attempt budget, as do create and stop. The private
  real-libsystemd stalled-socket regression requires UNCERTAIN/DEADLINE and no
  ResetFailed wire bytes; it does not establish installed-service acceptance.
- **D2:** daemon-reexec invalidates the historical manager unique-name binding.
  Keep it fail-closed: same boot/bus/invocation and uid 0 do not establish
  lifetime-fence continuity (outstanding jobs are serialized too). Future work
  needs an explicitly authorized A-to-B operation-owner transition shared by
  stop/observer/reconciler, unchanged create journal, proposed STOPv2 A/B.
- No reconciler for stop journals (startup after a crash mid-stop) and no
  durable link from ledger slot to stop journal(s).
- Credential transition of the workload into the anchor cgroup, composition
  with the startup owner / service wiring, independent review, artifact pins
  and host acceptance with a real root `Kill`/`Stop` of a hardened anchor.
