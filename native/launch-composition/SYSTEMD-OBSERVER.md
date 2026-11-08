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
   Calls have a two-second per-method timeout; they are synchronous and cannot
   be cancelled by a socket deadline. Hosts whose bus peer is not root are
   conservatively unsupported (UNKNOWN); do not relax this to peer-selected UID.
5. Absence requires the expected boot, manager/bus, InvocationID and ControlGroup,
   inactive/failed unit, no systemd job, and `populated 0` read through the
   original cgroup FD. `cgroup.events` includes descendants. A second exact bus
   snapshot and owner-fence validation close the observation bracket. Unknown,
   replacement, malformed event/ID, job, populated subtree, query error or bare
   missing unit/file cannot release capacity. No `systemctl`, leader-exit, EOF,
   PID or bare ENOENT heuristic exists.
6. Only after absence, a separate cleanup proof requires explicit
   `org.freedesktop.systemd1.NoSuchUnit` from that same manager/bus and
   `fstat(original cgroup FD).st_nlink == 0`. Errors/remaining metadata retain
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
collects or clears InvocationID/ControlGroup before the exact empty-subtree
observation, if the original FD is lost, or if boot/manager/bus changes, recovery
returns UNKNOWN. **A missing unit is not a recovery receipt.** The next owner
integration must retain evidence before GC (or supply a separately reviewed,
durable lifetime/absence receipt). This intentionally narrow adapter cannot
recover never-created reservations from ledger state alone.

## Dependencies and exercised evidence

Discovery found `libsystemd.so.0`, but no `pkg-config` or sd-bus development
headers. The implementation uses only a small declared public stable ABI
(opaque bus/message handles, documented error/id value structs), linked with
`-l:libsystemd.so.0`; no privileged installation, subprocess JSON parsing or
runtime library search in writable locations is used. Consumers must link that
library plus the composition/lifecycle/quota archives and pthread.

`make -C native/launch-composition all test analyze sanitize` passed GCC
`-fanalyzer` and ASan/UBSan for the actual source and fixtures:

- Existing 11 composition scenarios.
- 18 UNKNOWN fixtures: missing lifetime authority/outstanding attach, bus job,
  missing unit, query failure, manager replacement, InvocationID replacement,
  cgroup-path replacement, active unit, populated descendants, duplicate,
  malformed or missing events, bare ENOENT, wrong boot, replacement between
  snapshots, unterminated bus string, writable cgroup and restarted bus ID.
- One real composition/descriptor scenario: exact empty observation, independent
  cleanup failures, held capacity/new-workspace denial, rename/substitute against
  pinned original descriptor, cgroup removal, fence/query retry and release.
- 11 strict sd-bus ABI fixtures, including valid result, transport failure,
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
