# systemd-create — fixed-policy containment anchor (NOT installed, NOT a launcher)

Creates exactly one transient system service per durable `LC_STARTING` lifecycle
entry, through a typed `StartTransientUnit` call on the system bus. The service
runs only `step-container-keeper`, which accepts no arguments and does nothing
but `pause()`: it holds the cgroup open so a later protected step can place the
workload inside it. It never starts a workload, parses commands or reads files.

## Contract

- Unit name is derived from the lifecycle entry (`step-lc-<epoch>-<slot>.service`);
  callers cannot choose a unit, path, PID, command, environment or limit.
- Fixed properties (mode `fail`), every name and D-Bus type checked against the
  systemd 259 introspection on this host (`make host-check`) and its transient
  setters:
  - `Type=exec`, `Restart=no`, `KillMode=control-group`, `OOMPolicy=kill`,
    `Delegate=no`, `MemoryMax=512 MiB`, `MemorySwapMax=0`, `TasksMax=64`,
    `CPUQuotaPerSecUSec=1s`, `User=root`, `Group=root`, null stdio,
    `ExecStart=/usr/libexec/step-container-keeper` (argv = the path only).
  - Sandbox: `NoNewPrivileges`, empty `CapabilityBoundingSet` and
    `AmbientCapabilities`, `PrivateNetwork`, `IPAddressDeny=any` (0.0.0.0/0 and
    ::/0), `RestrictAddressFamilies=none`, `ProtectSystem=strict`,
    `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `PrivateIPC`,
    `ProtectProc=invisible`, `ProcSubset=pid`, `ProtectKernelTunables/Modules/Logs`,
    `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`,
    `RestrictNamespaces=yes` (0), `LockPersonality`, `MemoryDenyWriteExecute`,
    `RestrictSUIDSGID`, `RestrictRealtime`, `SystemCallArchitectures=native`,
    `SystemCallFilter` allow-list (`@default` plus the few file/IO calls the
    dynamically linked keeper needs before `pause()`; a violation kills it),
    `UMask=0077`, `LimitNOFILE=64`.
  - `CollectMode=inactive` (explicit; not `inactive-or-failed`): a _failed_
    anchor stays loaded with its `Result`/`InvocationID` as evidence until
    explicitly reset. A cleanly _inactive_ anchor is garbage-collected, so
    reconciliation must not depend on unit metadata after a clean stop; it
    relies on the pinned cgroup and lifecycle fence instead.
  - None dropped: no requested property was rejected by host introspection.
- Before connecting and again after the durable `INTENT` (both before the send),
  and again at the start and end of readback: expected system-bus id, expected
  manager unique name (strict `:<digits>.<digits>`; it is interpolated into a
  match rule), bus peer credential uid 0 and `GetConnectionUnixUser == 0`.
  Exclusive authority is re-checked at open, begin entry, after `INTENT`, at
  every poll entry, at readback start/end and after `ANCHOR`.
- The keeper path ancestry (`/`, `/usr`, `/usr/libexec`, keeper) must be
  root-owned, not group/other-writable, no symlinks, keeper a regular
  executable with one link; checked at open and again at begin.
- Match rule: `sender`, `path`, `interface`, `member='JobRemoved'` **and
  `arg2='<unit>'`**, so host job traffic is filtered by the bus; the callback
  still ignores other units as defense in depth.
- A durable `INTENT` line is fsynced to the journal **before** the async call;
  then `JOB` on reply and `ANCHOR` only after the exact `JobRemoved(done)` whose
  job id and path equal the reply's, plus readback of the _effective_ values:
  every fixed property above (root drop-ins apply to transient units too),
  `DropInPaths` empty, `Transient=yes`, `ActiveState=active`,
  `SubState=running`, `MainPID>1`, `LimitNOFILESoft`, exact `ExecStart`,
  `IPAddressDeny`, `RestrictAddressFamilies`, an allow-list `SystemCallFilter`
  containing `pause` and none of a short never-grant list, `GetUnit` returning
  exactly the encoded unit object path, the expected `ControlGroup`, a nonzero
  `InvocationID` and no pending job. Readback is a point-in-time check.
- `lsc_poll` dispatches at most 32 bus messages per call. Event-loop callers use
  `lsc_fd` / `lsc_events` / `lsc_timeout` (relative µs until the next required
  poll: the earlier of sd-bus's own timeout and the 5 s attempt deadline)
  instead of busy-polling. The deadline is checked at poll entry and again after
  the synchronous readback. During readback every blocking call (each property
  Get, GetUnit and both owner() calls) first rechecks the deadline and caps its
  own method-call timeout at the time left (never above 2 s), so one poll can
  overrun the 5 s attempt deadline by at most one bus round trip, not ~60 × 2 s.
- Any error, timeout, mismatched or duplicate event, lost authority/owner or
  fsync failure leaves the state `UNCERTAIN`. Nothing in this module releases a
  reservation, cancels a job or kills anything. `lsc_close` only drops local
  subscriptions.

## Single-use: exactly what is enforced

- Per handle: `lsc_begin` runs once; any later call fails without sending.
- Per journal _content_: `lsc_open` and `lsc_begin` require an empty journal, and
  `INTENT` is written before the send. Once any `INTENT` byte is written (even if
  its fsync failed) the journal is never accepted again.
- **Not single-use before `INTENT`:** a failure before the `INTENT` write (bus
  connect, owner/authority/keeper check, match, `Subscribe`) sends nothing and
  leaves the journal empty, so it can be opened and attempted again.
- `flock(LOCK_EX)` is taken on the caller's **open file description**. It
  excludes concurrent handles opened through _other_ descriptions of the same
  file, but **not** a second `lsc_open` on the same fd (or a dup of it): both
  handles open successfully, and only the empty-journal check stops the second
  from sending after the first wrote `INTENT`. The lock persists until every fd
  on that description is closed. Callers must serialize and must not open two
  handles per journal; the module does not enforce this within one description.
- Unit-name nonreuse across journals is the caller's `exclusive` authority.

## Verified (unprivileged)

`make clean all test analyze sanitize`:

- Fake-bus fixture: typed token messages with sd-bus cursor semantics; a FIFO
  delivered only by `sd_bus_process` (one message per call); every request
  argument asserted (destinations, paths, interfaces, `GetNameOwner`/
  `GetConnectionUnixUser`/`GetUnit` arguments, property object path and type,
  exact match rule, exact `StartTransientUnit` serialization in
  `test-create.trace`), no message leaks.
- Sweeps: every authority re-check (7) and every owner facet × call (4×4) at
  the exact stage; every readback property × perturbation, trailing argument
  and Get failure; `GetUnit` prefix/other/trailing; dispatch bound (32 per poll),
  event-before-reply, separate polls, endless flood to deadline, spoofed sender,
  `sd_bus_process` error, post-readback deadline, clock failures, fsync faults,
  `Subscribe` error/trailing, correlation (`JobRemoved` job 8 vs reply job 7),
  duplicate events, other units; `lsc_fd`/`lsc_events`/`lsc_timeout`.
- Production keeper/journal branches run against a scratch root through the
  `LSC_TESTING`-only hook (missing, symlink, writable, not executable, hardlink,
  directory, symlinked ancestor/root, wrong owner — at open and between open and
  begin; journal mode/owner/nlink 0/2/FIFO/O_WRONLY/O_RDONLY/nonempty/flock).
  `LSC_TESTING` only compiles together with `LSC_FIXTURE_INCLUDE` (set by
  `test-create.c`), and the hook plants a `used` marker that survives `-O2`;
  the Makefile also refuses `LSC_` in `CC`/`CFLAGS`/`CPPFLAGS`. `make
pin-check` runs `pin-scan.sh`, which fails closed: it refuses LTO objects
  (`.gnu.lto_*` bytecode hides the marker from `nm` and `strings`), any
  missing/failing `readelf`/`nm`/`strings` or implausibly empty output, and a
  hook name in the symbol table or raw bytes. `make pin-check-negative`
  (`pin-negative.sh`) proves each refusal with its reason: a bare
  `-DLSC_TESTING` build stops at the `#error` (stderr checked, `-g` and
  `-g0`); hooked objects are refused at `-g` and `-g0` (where only the marker
  carries the name) and by each scan arm alone (`pin-fake-tool.sh` hides the
  name from the other tool); production and hooked `-flto` objects; missing,
  failing-after-output and silent tools; the make tripwire; and `make
pin-check` itself on a hooked `create.o` in a scratch tree. `make test`
  runs both through `pin-check-phony`, which first creates files named
  `pin-check`/`pin-check-negative` so a lost `.PHONY` entry fails. Defaults
  are asserted to be `/` and uid 0.
- Readback budget: the fake bus asserts at every method call and property Get
  during readback that the timeout in force is at most the time left before
  the deadline; slow `GetNameOwner`/`GetConnectionUnixUser`/property calls
  (past the deadline and landing exactly on it) prove the next call is never
  made. The `SystemCallFilter` reader accepts at most 1024 names (exactly 1024
  passes, 1025 fails); the success fixture uses 400 names (this host's
  `@system-service` expands to 395).
- `make mutation` applies 81 mutations in a scratch copy: 64 in
  `mutation/mutations.json` (checked by `test-create`) and 17 in
  `mutation/pin-mutations.json` (`pin-scan.sh`, Makefile `.PHONY`/tripwire,
  hook marker and `#error`; checked by `make pin-check-phony`). All are
  killed. Deleting the LTO refusal (PN5) is caught only through the asserted
  reason: such an object is still refused by the `strings` sanity check.
- Keeper identity/argument/pause tests, GCC analyzer, ASan/UBSan, link test
  against the real `libsystemd.so.0`.

`make host-check` (read-only system bus: Get/GetUnit/Introspect/GetNameOwner):
the production `owner()` passes on this host, unit path encoding equals
`GetUnit`, every sent/read property name and type is present in live
introspection, and the production readers parse real replies. No unit was
created.

## Not done (production blocked)

`make install install-check` refuse on purpose. Missing: host acceptance of the
hardened unit (the sandbox, syscall allow-list, `LimitNOFILE=64` and readback
representations have not been exercised by a real root `StartTransientUnit`),
incarnation-bound stop/kill,
credential transition into the anchored cgroup, composition with
`launch-composition`, independent review and artifact pins.

Startup reconciliation of nonempty journals (read-only ANCHORED /
ABSENT_PROVEN / UNKNOWN decision reusing these exact lines and the observer's
proofs) is in
[`launch-composition/CREATE-RECONCILE.md`](../launch-composition/CREATE-RECONCILE.md);
it is synthetic and unlinked from any service.
