# systemd-create — fixed-policy containment anchor (NOT installed, NOT a launcher)

Creates exactly one transient system service per durable `LC_STARTING` lifecycle
entry, through a typed `StartTransientUnit` call on the system bus. The service
runs only `step-container-keeper`, which accepts no arguments and does nothing
but `pause()`: it holds the cgroup open so a later protected step can place the
workload inside it. It never starts a workload, parses commands or reads files.

## Contract

- Unit name is derived from the lifecycle entry (`step-lc-<epoch>-<slot>.service`);
  callers cannot choose a unit, path, PID, command, environment or limit.
- Fixed properties: `Type=exec`, `Restart=no`, `Delegate=no`,
  `KillMode=control-group`, `MemoryMax=512 MiB`, `TasksMax=64`,
  `CPUQuotaPerSecUSec=1s`, `NoNewPrivileges=yes`, null stdio, mode `fail`.
- Before connecting: the expected system-bus id and the expected systemd manager
  unique name (strict `:<digits>.<digits>`; it is interpolated into a match rule)
  are verified, plus peer credentials uid 0 and `GetConnectionUnixUser == 0`.
- A durable `INTENT` line is fsynced to a fresh, private, single-use journal
  **before** the async call; then `JOB` on reply and `ANCHOR` only after the exact
  `JobRemoved(done)` for that job plus readback of `ActiveState=active`, the
  expected `ControlGroup`, a nonzero `InvocationID` and no pending job.
- One attempt per journal. Any error, timeout (5 s), mismatched event, lost
  exclusive authority or fsync failure leaves the state `UNCERTAIN`. Nothing in
  this module releases a reservation, cancels a job or kills anything.
- `lsc_close` only drops local subscriptions.

## Verified (unprivileged)

`make clean all test analyze sanitize`: 18 fake-bus scenarios (exact serialized
arguments and property types, reply/event/readback mismatches, timeouts, fsync
faults, wrong bus id/owner/uid, authority loss, and rejected manager names),
keeper identity/argument/pause tests, GCC analyzer, ASan/UBSan, and a link test
against the real `libsystemd.so.0`. No real unit was created.

## Not done (production blocked)

`make install install-check` refuse on purpose. Missing: startup reconciliation
of nonempty journals, incarnation-bound stop/kill, credential transition into
the anchored cgroup, composition with `launch-composition`, independent review,
host acceptance and artifact pins.
