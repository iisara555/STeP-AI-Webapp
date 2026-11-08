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
   create.c.
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
5. **Never**: `ResetFailedUnit`/`ResetFailed`, `StopUnit`/`KillUnit` by name,
   job `Cancel`, mode `replace`, retries, or touching the create journal or
   ledger. `las_close` only drops local subscriptions.

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

- **Observer gap found while verifying (blocks release after a real stop):**
  `systemd-observer.c` requires `ControlGroup` equal to the launch-time path
  for an inactive/failed candidate, but systemd 259 reports `ControlGroup=`
  for stopped units. A real stopped anchor would therefore classify as
  INVOCATION → UNKNOWN; absence must instead rest on the pinned original
  cgroup descriptor (`populated 0`, later `st_nlink == 0`). Its cleanup proof
  also needs NoSuchUnit, i.e. a separately reviewed post-absence
  `ResetFailed` step that this module deliberately never performs.
- No reconciler for stop journals (startup after a crash mid-stop) and no
  durable link from ledger slot to stop journal(s).
- Credential transition of the workload into the anchor cgroup, composition
  with the startup owner / service wiring, independent review, artifact pins
  and host acceptance with a real root `Kill`/`Stop` of a hardened anchor.
