# Startup reconciliation of systemd-create journals (synthetic, install blocked)

`create-reconcile.[ch]` (`libstep-create-reconcile.a`) is the single startup
owner's read-only decision for **one nonempty** `native/systemd-create` journal
against its durable lifecycle slot after a crash or restart. It reuses the
creator's exact journal lines and the existing proof types. It does not add a
journal format, a second lifecycle authority or any systemd mutation.

## Inputs

- `owner`: the `lco` startup owner (its reopen has already fenced every
  nonterminal slot). `slot`: the lifecycle slot the caller bound to this journal.
- `journal_fd`: the protected create journal, opened readable. `lcr_open` dups it
  CLOEXEC and takes `flock(LOCK_EX|LOCK_NB)` on that open file description for
  the handle lifetime, so a holder on another description (an in-flight
  `lsc` creator) makes open fail with `EWOULDBLOCK`. Like `lsc_open`, two
  handles on the _same_ description are not excluded; callers serialize.
- Observer inputs from the owner's protected launch-time record (never from the
  journal or a peer): `boot_fd`, retained original `cgroup_fd` with its
  device/inode, `trusted_uid` (production `lcr_open` requires 0), and
  `lifetime_fenced`. Bus id, manager, unit, InvocationID and ControlGroup for the
  observer come **only from the journal** (`INTENT` and `ANCHOR`).

## Strict parser

The journal must be a regular, singly linked, `trusted_uid`-owned 0600 file of
at most 1024 bytes, read in one `pread` that also detects growth. Lines are
exactly create.c's:

```text
INTENT v1 <slot> <principal> <epoch> <boot> <user> <workspace> <launch> <unit> <bus id> <manager>
JOB <job> /org/freedesktop/systemd1/job/<job>
ANCHOR <job> <invocation> /system.slice/<unit>
```

Single spaces, `\n` terminators, canonical decimals (no sign, no leading zero,
overflow-checked; slot and job nonzero, job ≤ UINT32_MAX), lowercase nonzero
32-hex ids, lowercase UUIDs, manager `:<digits>.<digits>` shorter than 128,
unit derived from the line's own epoch+slot, JOB path digits identical to the
job, ANCHOR job equal to JOB's and cgroup exactly `/system.slice/<unit>`. Lines
must appear in that order, at most once each. A trailing partial line is TORN;
everything else outside the grammar (CR, tab, NUL, extra/missing fields or
lines, empty lines, duplicates) is GRAMMAR. Fixed field widths bound valid
lines at 455/55/130 bytes.

## Decision

1. Journal bytes changed since this handle's first read: UNKNOWN, and the handle
   stays poisoned even if the bytes are restored. A failed attribute check
   (type/owner/mode/links/size/read) is a non-poisoning UNKNOWN for that call
   only; no release follows either way.
2. Empty / INTENT only / INTENT+JOB / torn / grammar: UNKNOWN **without any bus
   query**: an empty journal has no absence proof, an `INTENT` without `JOB` may
   or may not have reached systemd, a `JOB` without `ANCHOR` may still exist.
3. `INTENT` must bind exactly the ledger entry (unit = `<container>.service`,
   principal, boot, user, workspace, launch); a slot already durably RELEASED
   reports the distinct verdict ALREADY_RELEASED (reason RELEASED) without
   observing. It is not an absence proof and never permits deleting the journal
   or other evidence, because a different path may have released the slot.
4. Current boot (pinned `boot_fd`: root-owned, not group/other-writable, exactly
   37 bytes) must equal the `INTENT` boot.
5. One read-only snapshot through the observer's own seam
   (`lso_ops.snapshot`; production `lso_bus_snapshot`, the observer's existing
   sd-bus reader, now exported) for the journal's unit and manager. Malformed
   or failed → QUERY; other bus id → BUS; other manager → MANAGER; NoSuchUnit →
   COLLECTED; other InvocationID/ControlGroup → INVOCATION; pending job or
   another state → TRANSIENT.
6. `active`, exact invocation/cgroup, no job → **ANCHORED** (capacity retained).
7. `inactive`/`failed` with exact identity → open `lso` (production `lso_open`)
   with the journal's bus/manager/invocation/cgroup and the owner's pinned
   descriptors, require `lso_absent`, then `lso_reconcile` →
   `lco_reconcile` → `lc_reconcile` (absence **and** separate cleanup proof).
   Only that path releases capacity → **ABSENT_PROVEN**. A lost cgroup
   descriptor → NO_PIN. Proof failure → UNPROVEN.
8. NoSuchUnit is accepted as cleanup evidence only after **this handle** proved
   absence (in-memory receipt, as in the observer). A fresh handle after another
   crash sees COLLECTED → UNKNOWN.

UNKNOWN always retains capacity and the recovery fence. The module never
writes the journal, never calls `StartTransientUnit`/stop/kill/reset and never
returns a value that could feed a retry: `lsc_open` already refuses any
nonempty journal, and the unit name is the ledger's never-reused container.

## Evidence (unprivileged, `make -C native/launch-composition all test analyze sanitize mutation`)

`test-create-reconcile` links the actual parser, observer (`lso`), composition
owner, lifecycle ledger and quota core; only the snapshot seam is fake. It
prints 55 `ok` lines (9 scenarios plus 46 UNKNOWN fixtures): parser bounds/fields; ANCHORED with retained capacity; ABSENT_PROVEN
via absence, failed cleanup retry, lost-fence retry, release, idempotence and a
new never-reused container; collected-without-receipt; 46 UNKNOWN fixtures
(every reason above incl. boot/bus/manager change, mismatched invocation and
cgroup, job, transient states, malformed snapshots, lost descriptor, lost
fence, populated subtree, changed cgroup inode, journal mode/link/size/owner,
boot mode/length/newline, ledger mismatches); poison on change; open refusals
and lock exclusion/release; 39 grammar edits (including missing fields) plus 10 self-consistent whole-line variants and
8 structural cases; **every torn-write prefix** (both with a live anchor and an
absence-ready unit, 0 bus queries); **every single-byte substitution** at every
offset with 14 replacement bytes (both fixtures, none reaches the absence
proof). The journal bytes are compared before/after each reconciliation. GCC
`-fanalyzer` and ASan/UBSan pass.

`make mutation` deletes each of 83 guards in a scratch copy and requires
`test-create-reconcile` to fail; all are killed. Not mutation-proven
unprivileged (kept as defense in depth): `S_ISREG` on journal/boot (non-regular
descriptors already fail `pread`), the short-read/growth comparison (cannot be
provoked on a regular file without a race), and the boot file owner check
(needs a foreign-owned file); production `lso_open`/`lso_bus_snapshot` wiring
needs root, cgroup2 and the real bus.

## Remaining (production blocked; `install`/`install-check` still refuse)

- Incarnation-bound stop/kill and job draining of anchors (no mutation exists
  anywhere; UNKNOWN/ANCHORED slots stay fenced until it does).
- Credential transition of the workload into the anchored cgroup.
- Durable capture of the anchor cgroup's device/inode and a retained descriptor
  across owner crashes: today a crash loses the pinned descriptor, so a crashed
  create can only reach ANCHORED or UNKNOWN (NO_PIN), never ABSENT_PROVEN.
- Census/naming that maps every ledger slot to its protected journal file, the
  real `lifetime_fenced` implementation and service wiring of the startup owner.
- Independent review, artifact pins and host acceptance against real systemd.
