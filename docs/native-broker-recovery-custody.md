# Broker entry recovery custody (not enabled)

This bounded increment connects systemd-style returned descriptors to the **actual
`native/quota-broker/broker-main.c` process entry**. It does not connect the
reconciler, launch, stop, reset, release or service deployment.

## Entry contract

Before opening files or performing descriptor cleanup, main captures and validates
`LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` together:

- All absent means no custody. Partial activation is refused.
- PID must be canonical decimal equal to this process; count must be canonical,
  overflow-checked decimal in `0..16`.
- Exactly one name per returned FD, at descriptors `3..3+count-1`.
  Each name is `qbc-` plus a 32-character lowercase hex entry identifier.
  Empty, truncated, unknown-format, extra and duplicate names are refused.
- Each claimed descriptor must exist before main opens anything. Accepted candidate
  descriptors are set `FD_CLOEXEC`; all other inherited descriptors above stdio
  are closed. Invalid activation closes all descriptors above stdio and refuses.
- Activation environment variables are removed. Names only select expectations;
  **a name never establishes descriptor identity or lifecycle authority**.

`--serve` remains quota-only. It refuses a nonempty returned custody set rather
than ignoring recovery state and publishing readiness. Normal quota-only startup
without activation retains its existing behavior.

## Fixed protected expectations, no provisioning

The separate `--recover-custody` command reads only the fixed production path
`/etc/step-quota-broker/recovery-custody.v1`. There is no production path option or
environment override. Its parent and ancestors use the existing root-owned,
non-group/other-writable, symlink-free directory walk. The manifest must be a
root-owned regular file, mode `0600`, one link, at most 4096 bytes, opened without
following symlinks. Its exact grammar is:

```text
QB-CUSTODY/1
<32 lowercase hex entry identifier> <canonical decimal st_dev> <canonical decimal st_ino> directory
```

The final newline is required. There must be exactly one manifest record per
returned entry; missing, duplicate or extra entries refuse startup. Each retained
FD must independently match its entry's expected device, inode and directory type,
be readable rather than `O_PATH`, be root-owned and not group/other-writable.
Manifest row ordering is irrelevant. No cgroup pathname is stored or reopened to
replace a missing or mismatched descriptor.

**There is deliberately no manifest provisioning/publishing command.** The reader
specifies an input contract, not a procedure to derive authority from currently
visible pathnames or returned FDs. Nobody should synthesize expectations from
those inputs. Even a fully matching manifest ends in explicit `UNKNOWN`/startup
refusal before readiness: the remaining recovery composition is unavailable.

The current directory checks do not establish cgroup-v2 identity, boot continuity,
unit invocation identity or any absence proof. A future trusted publisher must
bind the entry to durable launch-time metadata, installation epoch and boot, and
the future observer must perform its own cgroup-v2 and identity checks.

## Evidence

`make -C native/quota-broker test` includes `test-custody.py`, which forks and execs
the actual `QB_BROKER_TESTING` broker executable, not a custody helper:

- The parent retains an original directory FD; the child reaches the common
  manifest/identity validation, is killed, and a fresh broker exec receives the
  parent's retained FD after the original pathname has been replaced.
- `/proc/<child>/fd` and `fdinfo` check the original inode, exact live descriptor
  set and CLOEXEC. The unrelated inherited FD is gone.
- Wrong/partial PID metadata, malformed/overflow counts, missing descriptors,
  duplicate/unknown/truncated names and swapped descriptor identities refuse.
- All 16 distinct entries work with reversed manifest order; swapping their FDs
  does not. Wrong device, file type, `O_PATH` and writable directories refuse.
- Missing, symlinked, multiply linked, writable or malformed manifests refuse.
  Every completed child path is checked for **no systemd readiness datagram**.
  Repeated refused child invocations leave the parent's descriptor count intact.

Only the testing build has the existing scratch trust-root/owner seam and the
post-validation diagnostic/stdin barrier used to inspect and kill the child.
The barrier emits `CUSTODY UNKNOWN`, never readiness or a recovered verdict. A
production-object `nm` and retained-string scan, plus a negative check against an
optimized debug-free fake object, checks that these seams are not shipped.

`make -C native/quota-broker custody-mutation` reruns 15 targeted mutations of the
real main against the same executable tests. All are killed; this is a selected
regression set, not a claim that every existing startup guard is mutation-covered.
The type-check test explicitly sets file permissions so the writable-mode guard
does not mask deletion of the directory-type guard.

Verified unprivileged gates: normal broker suite, GCC analyzer, ASan+UBSan suite,
production-object seam exclusion, targeted mutations and `npm run check`.
No root operations, real cgroup/XFS mutation, installed service or systemd FDSTORE
was exercised. Unit and installer files/pins are unchanged; the changed binary
must not be installed under the old pin.

## Remaining gates

1. Protected launch-time manifest provisioning, durable entry/epoch/boot binding,
   atomic publication and crash/rollback semantics.
2. Actual systemd FDSTORE deposit, acknowledged retention barrier, and verified
   returned-descriptor behavior across installed broker crash/reexec.
3. Startup-owner and reconciler wiring, protected boot/journal/unit invocation
   inputs, real cgroup-v2 checks, and independently gated absence/cleanup proof.
4. A continuously enforced lifetime/nonreuse fence against every possible
   start/restart/attach and escaped descendant. **A journal lock is not that fence.**
5. Independently reviewed composition, deliberate artifact repinning and owner-run
   installed service acceptance. No launch/release/reset/deployment is enabled.
