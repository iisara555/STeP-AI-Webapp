# Protected systemd/cgroup observation adapter

`systemd-observer.[ch]` implements the actual read-only Linux/systemd side of
`composition.h`'s two proof callbacks. It builds as
`libstep-systemd-observer.a`; the installed broker/launcher remains untouched.
It is not a create/stop implementation and does not grant itself lifetime
ownership. A trusted startup owner must supply that separate authority.

## Exact supported contract

1. The startup owner supplies one complete durable `lc_entry`, protected expected
   bus ID, manager unique owner, 128-bit nonzero InvocationID, ControlGroup, and
   original cgroup device/inode. These are independent launch-time expectations,
   not observations adopted from a query or fields accepted from a peer.
2. `lso_open` duplicates pinned boot-ID and original cgroup directory descriptors
   CLOEXEC. Production requires root-owned, non-group/other-writable objects and
   a cgroup-v2 superblock. The caller opens them through protected ancestry
   without symlink traversal and retains the protected launch record. No PID is
   accepted. The unit is derived exclusively as `<ledger container>.service`;
   an invalid container binding refuses open. Scope units are not supported.
3. Before any proof, `lifetime_fenced` must positively certify exclusive,
   durable, never-reused ownership of this exact incarnation, complete descendant
   confinement to the retained subtree, permanently disabled starts/restarts/
   attaches by **all** actors, and no outstanding starts/creates/attaches. The
   owner must hold this fence continuously across reconciliation and durable
   release. `NULL`, missing records, lost authority or uncertainty return UNKNOWN.
   A ledger mutex or `Job=0` alone cannot certify these prerequisites.
4. The real backend uses libsystemd sd-bus, a kernel-authenticated root system-bus
   peer, expected root-owned manager connection, and calls directed to its exact
   unique name. It checks bus-instance identity too: a restarted bus can reuse
   unique-name strings. Manager ownership is bracketed around each snapshot.
   The whole snapshot (connect, authentication/Hello, every query and the
   closing owner bracket) is bounded by one absolute 5 s monotonic deadline that
   is never refreshed. `sd_bus_start` only queues authentication, so readiness
   is driven nonblockingly (`sd_bus_is_ready` + at most 32 `sd_bus_process` per
   round + a `ppoll` capped at the deadline) before any method call; otherwise a
   stalled peer blocks in the 90 s auth timeout. Each blocking call then gets
   `min(time left, 2 s)`. Real-libsystemd regression (`test-observer-deadline`,
   a private socket peer in the test process; `$TMPDIR` is required): a peer
   that never answers authentication is refused in about 5.005 s (auth never
   completes, so only elapsed time is asserted); one that never answers Hello
   is refused at the 2 s Hello budget; one that answers Hello but never
   GetNameOwner sees exactly Hello + one GetNameOwner and a refusal at 2 s;
   with the peer-uid seam left at the production 0 the same peer sees only
   Hello (the peer check precedes every method call). The address/peer seam is
   `LSO_TESTING` only. `make pin-check` runs `pin-scan.sh` (distinct refusal
   reasons); `pin-check-negative` (`pin-negative.sh`, fake-tool wrapper) proves
   each scan arm alone, LTO/tool-failure refusals, the exact `#error`, the make
   `LSO_` tripwire and `make pin-check` itself; `pin-check-phony` proves both
   run with same-named files present (wired into `make test`).
   The ABI fixture (`test-systemd-bus`) owns the monotonic clock
   (`clock_gettime` renamed before the include) and asserts every budget and
   readiness sleep against the true time left: jumps inside each call
   (including the last), inside readiness, idle rounds (no busy spin),
   `sd_bus_get_timeout`/`ppoll` faults, EINTR and clock failure at every read.
   `test-reset-composition` links with `--wrap=lso_bus_snapshot` and
   `--wrap=lso_open` to aborting wrappers, so the production observer cannot be
   reached through the stop fixture's fake `sd_bus_new`.
   Hosts whose bus peer is not root are
   conservatively unsupported (UNKNOWN); do not relax this to peer-selected UID.
5. Absence requires the expected boot, manager/bus and InvocationID. ControlGroup
   must equal the launch-time path, or be empty for an inactive/failed unit only;
   a foreign nonempty path remains UNKNOWN. Neither value is absence evidence.
   The proof still requires an
   inactive/failed unit, no systemd job, and `populated 0` read through the
   original cgroup FD. `cgroup.events` includes descendants. A second exact bus
   snapshot and owner-fence validation close the observation bracket. Unknown,
   replacement, malformed event/ID, job, populated subtree, query error or bare
   missing unit/file cannot release capacity. No `systemctl`, leader-exit, EOF,
   PID or bare ENOENT heuristic exists.
6. Only after absence, a separate cleanup proof requires explicit
   `org.freedesktop.systemd1.NoSuchUnit` from that same manager/bus and
   `getdents64(original cgroup FD)` failing with `ENOENT` (a removed directory).
   `st_nlink` is unusable on kernfs: it is synthesized as subdirectories + 2,
   including after removal. A live directory, O_PATH/EBADF, other errors and
   successful reads with stale errno are not removal proof. Errors/remaining metadata retain
   capacity. This certifies unit/cgroup metadata only; an owner with additional
   endpoint/other metadata obligations must compose its own additional proof
   before using `lso_clean` as the full composition cleanup callback. Outcome
   and lifecycle history are deliberately retained, not deleted.

Usage under the single startup owner:

```c
/* All inputs are from the protected owner/launch record, not the launch wire. */
struct lso *observer = NULL;
if (lso_open(&trusted_config, &observer) == 0) {
    int rc = lso_reconcile(observer, owner, exact_slot);
    /* rc != 0 retains the reservation; retry, do not repair/relaunch. */
    lso_close(observer);
}
```

Keep one adapter alive across metadata retries: an incarnation-scoped in-memory
absence receipt avoids re-observation after metadata has disappeared. It is
never transferred to another entry. A process crash loses that receipt; this
increment does not persist a new trusted absence record. If systemd garbage
collects, clears InvocationID or removes cgroup.events before the exact empty-subtree
observation, if the original FD is lost, or if boot/manager/bus changes, recovery
returns UNKNOWN. **A missing unit is not a recovery receipt.** The next owner
integration must retain evidence before GC (or supply a separately reviewed,
durable lifetime/absence receipt). This intentionally narrow adapter cannot
recover never-created reservations from ledger state alone.

The production snapshot reader is also exported as `lso_bus_snapshot` (same
code, no new query) so [create-journal reconciliation](CREATE-RECONCILE.md) can
observe a live anchor through the identical seam before feeding a candidate into
`lso_absent`/`lso_reconcile`.

## Dependencies and exercised evidence

Discovery found `libsystemd.so.0`, but no `pkg-config` or sd-bus development
headers. The implementation uses only a small declared public stable ABI
(opaque bus/message handles, documented error/id value structs), linked with
`-l:libsystemd.so.0`; no privileged installation, subprocess JSON parsing or
runtime library search in writable locations is used. Consumers must link that
library plus the composition/lifecycle/quota archives and pthread.

`make -C native/launch-composition all test analyze sanitize` passed GCC
`-fanalyzer` and ASan/UBSan for the actual source and fixtures:

- 13 composition scenarios (including the separate two-case prepare-crash test
  increment: death before outcome establishment and death after establishment
  but before a request).
- 18 UNKNOWN fixtures: missing lifetime authority/outstanding attach, bus job,
  missing unit, query failure, manager replacement, InvocationID replacement,
  cgroup-path replacement, active unit, populated descendants, duplicate,
  malformed or missing events, bare ENOENT, wrong boot, replacement between
  snapshots, unterminated bus string, writable cgroup and restarted bus ID.
- One real composition/descriptor scenario: exact empty observation, independent
  cleanup failures, held capacity/new-workspace denial, rename/substitute against
  pinned original descriptor, cgroup removal, fence/query retry and release.
- 12 strict sd-bus ABI fixtures, including empty ControlGroup, valid result, transport failure,
  NoSuchUnit versus access-denied, manager restart, malformed InvocationID array,
  property error, job, malformed message, nonroot bus and nonroot name owner.

A separate unprivileged read-only probe exercised this exact sd-bus reader
against real `dbus.service`: snapshot succeeded, `ActiveState=active`, `Job=0`,
expected manager and nonempty InvocationID/ControlGroup. It made **no absence
claim** and no mutation. This caught and regression-tested the distinction
between Service.ControlGroup and Unit.ActiveState/InvocationID. Fixtures are
not privileged cgroup/systemd lifecycle acceptance or power-loss evidence.

## Exact remaining integration / owner prerequisites

Still missing, deliberately untouched:

- Empty ControlGroup is now supported, but **missed pre-pruning populated-0
  evidence remains UNKNOWN** even with a retained removed directory. Removal
  proves cleanup only; this increment does not relax the emptiness requirement.
- **D2: manager reexec stays fail-closed.** Historical manager equality is
  unchanged. Same boot/bus/invocation and uid 0 do not prove lifetime-fence
  continuity; systemd serializes outstanding jobs too. A future explicitly
  authorized A-to-B operation-owner transition must be shared by stop,
  observer and reconciler (unchanged create journal; proposed STOPv2 A/B).

- Actual fixed-policy systemd create/start and incarnation-bound stop/kill,
  cancellation/draining of jobs, prevention of external restart/attach, nonreuse
  namespace enforcement, and cgroup confinement/escape prevention. No mutation
  callback is smuggled into this observation library.
- Protected launch-time capture/publication of boot, bus/manager generation,
  InvocationID, cgroup identity and retained descriptor; startup census and
  durable recovery/absence records, including before-create reservations and
  already-collected units. The lifecycle ledger does not currently store all
  these expectations. Do not construct them from peer arguments or trust a
  matching observation as ownership evidence.
- The real single startup owner's `lifetime_fenced` implementation spanning
  every create/start/attach route, and any additional endpoint metadata proof.
  Without it this adapter returns UNKNOWN, even on an empty cgroup.
- Reviewed service-only launcher linkage, preserved workspace/exec-status FDs,
  authenticated runtime-ready acknowledgment, startup policy/ancestry, artifact
  repinning, independent review and separately authorized host acceptance.

No system/root mutation, sudo, package installation, XFS operation, process
killing, real-data migration or push was performed. Installation gates remain.
