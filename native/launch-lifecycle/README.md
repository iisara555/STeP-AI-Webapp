# Native launch-lifecycle authority (review-only library)

This is a durable **capacity and incarnation ledger**, not a launcher, socket
server, process monitor, or installed service. It is deliberately not linked into
`native/quota-broker`, `native/runner-launcher`, or any production target.
`launch.outcome` remains the separate one-shot request/no-replay ledger: a
STARTED/DENIED/UNKNOWN reply from that module is not lifecycle absence proof and
must not release this module's reservation.

## Authority and trust contract

- One `lifecycle.ledger`, opened `O_NOFOLLOW|O_CLOEXEC`, holds one kernel
  `flock(LOCK_EX|LOCK_NB)` for the entire handle lifetime. Other opens, including
  another process, refuse while held. Mutations, reads and reconciliation use a
  non-reentrant try-mutex; contention returns `EBUSY` instead of waiting.
- Establishment is an explicit trusted provisioning operation using `O_EXCL`.
  Open never creates, truncates, repairs, or discards state. Missing state is an
  error, not permission to establish a replacement. **Never unlink/replace the
  ledger, change epoch, or establish another ledger to bypass outstanding work.**
- The caller supplies a retained protected directory FD: owned by the authority's
  effective UID, exactly mode 0700. The file must be a singly linked regular file,
  owned by that UID, exactly mode 0600. The caller must protect every ancestor and
  prevent rename, unlink, replacement, alternate writers and workload access.
  These current-UID fixtures are not proof of a root-owned deployment boundary.
- Trusted configuration supplies a nonzero fixed capacity (at most 65,536), a
  32-character lowercase-hex installation epoch, and the current boot UUID.
  Epoch and capacity must exactly match the persisted header at reopen. Boot is
  recorded for each new reservation; reopening after a different boot preserves
  the old entries' boot identity and still requires reconciliation.
- Every reservation durably binds principal (uint64), canonical lowercase UUID
  user/workspace, epoch, boot, and globally unique 32-character lowercase-hex
  launch ID. Principal authentication/authorization is the caller's job. One
  user/workspace pair may have only one nonterminal reservation, even if a caller
  supplies another principal. A launch ID can never be reused, including after
  release or a boot change.
- Container names are authority-generated:
  `step-lc-<installation epoch>-<16 hexadecimal slot digits>`. Slots monotonically
  increase and terminal entries are retained forever. There is no reset,
  compaction, configurable command, pathname, PID or executable argument API.
  The caller must arrange an exclusive container-name namespace across all
  authorized launchers; this library does not inspect existing containers.

## Lifecycle and recovery

```text
reserve -> RESERVED -> STARTING -> RUNNING -> STOPPING
                         \--------------------^
any nonterminal -> FENCED
any nonterminal --trusted ABSENT_AND_CLEAN proof--> RELEASED
```

Only `lc_reconcile` can release. `lc_transition(..., LC_RELEASED)` refuses.
`RELEASED` is terminal; repeated reconciliation succeeds without calling the
proof callback or writing another record. Capacity is computed from entries,
not a separately incremented/decremented counter. Thus release cannot credit the
same reservation twice. All other states consume capacity.

Every successful open first durably transitions **all** recovered nonterminal
entries to `FENCED`, including RESERVED and apparently RUNNING entries from the
same boot. There is no usable handle during this drain. An interrupted/failed
fence returns no handle; the next open replays and continues fencing. Any FENCED
entry globally blocks new reservations, even if the configured capacity has free
slots. To enumerate recovery entries, call `lc_get` for slots starting at 1 until
`ENOENT` (a poisoned handle instead returns `EIO`). No entry is deleted.

A trusted synchronous, non-reentrant reconciliation callback receives a copy of
the exact retained entry. It must return:

- `LC_UNKNOWN`: cannot prove the required state; retain reservation (`EAGAIN`).
- `LC_PRESENT`: incarnation still exists; retain reservation (`EAGAIN`).
- `LC_ABSENT_AND_CLEAN`: explicitly certifies both incarnation-bound descendant
  absence and completed required container/unit metadata cleanup. Persist
  RELEASED before returning success.

The callback is a protected authority seam, **not evidence supplied by an
untrusted client**. Implementations must not return ABSENT_AND_CLEAN on launcher
exit, PID lookup/absence, `ENOENT`, unit-stop command success, boot mismatch, a
missing cgroup pathname, a launch.outcome reply, or an unsuccessful query.
Trusted startup census and an incarnation-bound container/cgroup ownership and
cleanup adapter are still missing. No absence inference exists in this library.

The owner must drain/join all callers before close. Handles cannot be used after
fork (API checks the original PID); a fork child must close inherited authority
FDs promptly. CLOEXEC closes them on exec. A child retaining a lock FD can delay
recovery, but cannot authorize a new reservation using the inherited handle.
Callbacks must not close the handle, cancel/longjmp out, or reenter it.

## Durability and bounds

The v1 file is a canonical 256-byte header followed by 256-byte full-entry
records: magic/version, contiguous log sequence, slot, principal, state, epoch,
boot, user, workspace, launch ID, reserved zeros, and a little-endian FNV-1a-64
checksum over the first 248 bytes. Integer fields are explicit little-endian;
no native structs or pointers are persisted. Replay checks exact configuration,
record length, canonical padding, identity immutability, contiguous slots and
sequence numbers, legal transitions, historical launch-ID uniqueness, workspace
exclusivity, recovery fences and capacity at each reservation.

Every mutation appends a full record then `fsync`s before exposing success.
Establishment also syncs the directory. Open re-syncs the recovered file and
directory. Any uncertain write or mutation fsync permanently poisons that handle:
all subsequent reads/mutations/proof callbacks refuse, until close and a fully
validated, durably fenced reopen. The caller must not reinterpret an error as
proof that a reservation or release was absent from disk. A complete record may
survive a failed fsync; replay accepts its state but never replays a launch.

Partial/torn records, checksum errors, noncanonical records, sequence replay and
illegal transitions refuse the entire open, without truncation or repair.
The checksum detects accidental corruption, **not malicious rewriting**. Whole
valid-prefix rollback/deletion, storage that lies about fsync, and tampering by
the protected storage owner are outside this component's guarantees. Do not
claim power-loss or anti-rollback acceptance from these tests.

The fixed limits are 65,536 lifetime slots and 1,048,576 total records. Reaching
either limit refuses further work; even recovery can refuse at the record limit.
There is no automatic rollover: safe archival/epoch replacement requires a
separately reviewed offline census. Memory is bounded by the lifetime-slot limit;
replay/reservation use conservative linear scans. Capacity is launch count, not
storage quota or a host free-space estimate.

## Verification

```sh
make -C native/launch-lifecycle clean all test analyze sanitize
npm run check
```

All tests use private disposable current-user directories under `$TMPDIR`.
They exercise real competing-process kernel locks; inherited-handle denial;
release idempotency and capacity; launch-ID/name nonreuse; all lifecycle record
transitions with child-process death before/after fsync and halfway through a
write; interrupted recovery fences; global fence drain; poisoned writes/fsyncs;
configuration mismatch; modified/replayed records; and all 255 partial tail
lengths. `analyze` runs GCC's static analyzer; `sanitize` runs both suites with
ASan/UBSan. Fault-injected process death is **not** sudden-power-loss validation.
No test starts systemd, switches account, uses sudo/root/XFS, installs host files,
or executes a workload.

## Exact next integration (not implemented here)

1. Independently review this component and the adjacent `qbl` request/outcome and
   fixed-policy launcher descriptor/status contracts. Keep the installed broker
   refusing lifecycle composition meanwhile; do not change launcher hashes.
2. Add a protected native startup owner which opens exactly one configured ledger
   before serving requests, retains it through service drain/join, and enumerates
   all FENCED entries. Supply a trusted synchronous container/cgroup reconciliation
   adapter that proves exact epoch/boot/launch/container identity, descendant
   absence and metadata cleanup. Unknown observations retain capacity and block
   admission; do not auto-establish after any open failure.
3. Compose reserve + durable STARTING before the existing one-shot protected
   request enters the quota-core fixed-policy spawn fence. Use this entry's
   launch/container identity, not caller-selected names. Keep launch.outcome
   PENDING/outcome persistence independent. Only verified native/runtime evidence
   may advance RUNNING; neither error-pipe EOF nor launcher death proves runtime
   readiness or absence. A reservation is never permission to replay a launch.
4. Add an unprivileged cross-component regression: child holder dies after fixed
   spawn callback entry but before outcome completion; restarted owner fences the
   reservation, STATUS never spawns, another reserve is denied despite spare
   capacity, UNKNOWN/PRESENT proof retains it, and exact ABSENT_AND_CLEAN proof
   permits exactly one release and a different never-reused container name.
5. Only after that review, implement root-owned startup/service policy, deliberate
   establishment/census, artifact repinning and separately authorized host
   acceptance. No production or host readiness is claimed by this library.
