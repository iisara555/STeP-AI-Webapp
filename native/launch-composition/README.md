# Composed native launch recovery (synthetic, installation blocked)

This connects the **actual** `launch-lifecycle` ledger and quota-broker `qbl`
request/outcome adapter, including the actual quota core's final synchronous
launch fence. It is not another model of either state machine. The normal
`test-composition` executable links `libstep-launch-composition.a`,
`libstep-lifecycle.a`, `libstep-launch-request.a` and `libstep-quota-core.a`.
Only the quota observations, fixed synchronous spawn and reconciliation backend
are fake. Tests refuse root, use disposable `$TMPDIR` directories, real Unix
stream sockets (including accepted child peers checked with `SO_PEERCRED`) and
process death. No workload, account switch, systemd or real XFS mutation runs.

## One startup owner

A trusted startup caller explicitly provisions the ledger out of band, opens the
quota core, then calls `lco_open` **once** before accepting requests. This owner
holds the sole lifecycle ledger lock until drain/close. `lc_open` validates the
post-lock file snapshot and durably fences **every** nonterminal entry before the
composition handle is returned. No parallel lifecycle manager or counter is
introduced. The borrowed quota core must outlive the owner; drain/join all users,
close this owner, then close the core. Inherited handles cannot serve requests.
The caller must protect all directory ancestry, configuration, callbacks and the
container namespace from peers/workloads. Same-user fixtures do not prove that
production trust boundary.

`lco_prepare` reserves capacity durably before establishing the one-shot outcome
file. The immutable slot binds principal, user/workspace and unique launch ID;
both qbl wire IDs equal this ledger launch ID. The qbl header additionally binds
the prepared directory identity. At callback admission the path is:

```text
owner mutex
  -> qbl: authenticate peer, exact frame + EOF, fsync PENDING
    -> quota core mutex: fresh grant/quota/mount/retained-directory checks
      -> composition: require RESERVED, fsync STARTING
        -> synchronous fixed spawn(exact ledger entry, borrowed receipt)
    -> qbl: persist outcome (independent of lifecycle capacity)
```

The fixed spawn receives the authority-generated never-reused container name,
epoch, boot and launch ID. It must neither invent a different identity nor defer
spawn beyond the callback. STARTED means callback success, not runtime readiness;
this module never promotes RUNNING from that result. Errors, DENIED, UNKNOWN,
launcher exit and missing outcome files never release capacity. Errors after
reservation establishment leave that slot reserved, even if qbl establishment
fails; the caller receives its durable entry in the output and must reconcile it,
not retry as repair.

Only one outcome slot is attached at a time. `lco_detach` closes that outcome
handle but **does not release its lifecycle reservation**. This keeps the module
small while permitting enumeration/reconciliation of many pending slots under
one owner. `lco_attach` opens existing state only and checks its exact ledger
binding. Recovered EMPTY outcome state cannot authorize another spawn: the
ledger entry is FENCED and callback admission refuses it. STATUS/replays never
respawn a pending or completed outcome.

`lco_reconcile` is a trusted local API, not a wire request. The first callback must
prove **exact-incarnation descendant absence**; only then is the independent
metadata-cleanup callback consulted for that same retained entry. Each must
return exactly 1. Unknown, present, mismatched identity, missing proof, query
errors and cleanup errors retain capacity and recovery fencing. The callbacks
receive the original boot/epoch/container/launch, even after restart under a new
boot. Release is durable and idempotent; terminal history preserves launch-ID
and container-name nonreuse. The owner mutex excludes serving, attachment and
reconciliation from interleaving; callbacks are synchronous/non-reentrant.

## Executable evidence

```sh
make -C native/launch-lifecycle clean all test analyze sanitize
make -C native/quota-broker clean all test analyze sanitize
# Rebuild normal archives after the broker sanitizer's clean/rebuild.
make -C native/quota-broker all
make -C native/launch-composition clean all test analyze sanitize
npm run check
# Expected refusal (nonzero):
make -C native/launch-composition install-check
```

The composition executable prints **13 named scenarios**, passed normally and
under ASan/UBSan:

1. Child owner exits inside fixed spawn, before qbl outcome completion; reopen
   fences; STATUS and LAUNCH replay return UNKNOWN with zero respawns; fresh ID
   cannot evade drain; absent/error/wrong-incarnation/metadata failures retain;
   exact two-part proof permits idempotent release and a new container name.
2. All three pending reservations fenced on reopen; spare capacity cannot bypass
   partial drain; original boot identities retained until all proofs complete.
3. Callback failure retains the capacity reservation for a distinct workspace.
4. Quota revocation DENIED retains capacity without invoking spawn.
5. qbl PENDING fsync failure never calls spawn and cannot replay after restart.
6. Lifecycle STARTING fsync failure never calls spawn; restart fences it.
7. Outcome-completion fsync failure cannot replay; reservation stays fenced.
8. Missing callback, competing owner, changed peer/launch/directory identity and
   missing outcome state refuse; STATUS on an untouched slot never spawns.
9. Release fsync failure poisons the owner; new preparation and proof retry refuse.
10. Recovered EMPTY outcome cannot spawn through a FENCED lifecycle entry.
11. Outcome establishment error retains the durable reservation and capacity.
12. Child owner exits after durable reservation but before outcome establishment;
    reopening fences the reservation, attach refuses the missing outcome without
    creating it, new-workspace preparation is blocked until both proofs succeed.
13. Child owner exits after durable outcome establishment but before any request;
    reopened EMPTY status cannot authorize launch, capacity remains fenced until
    exact absence and cleanup proofs succeed, and the next container is distinct.

The two prepare crash cases use a linker wrapper around `qbl_establish` to exit
the real child process immediately before or after the actual establishment.
They do not add production crash hooks, issue systemd requests or kill processes.

GCC `-fanalyzer` passes for composition and fixture. The lifecycle suite also
includes a deterministic real-two-process lock-handoff regression: contender B
pauses at wrapped `flock` after its early `fstat`; holder A appends three durable
reservations and closes; B acquires the real lock and must fence all three from a
fresh post-lock snapshot. The regression failed on the base revision, passed
after the fix, and passes with ASan/UBSan. No sleep-based race scheduling is used.

The existing quota suite passed (including 12 qbl scenarios, 25 core tests,
5 policy tests and 7 broker-main tests plus its launch, capacity, transport, XFS
syscall-seam and SQLite self-tests), normally and under ASan/UBSan; GCC analysis
passed. The unchanged base runner-launcher passed 263 checks normally and with
ASan/UBSan, plus analysis and unprivileged refusal checks.

Syscall failures/process death are **not** power-loss acceptance. Whole-valid-
prefix rollback remains outside the append ledger's guarantees. A completion
write may survive an injected fsync failure (the fixture observes STARTED on
reopen); real storage loss may recover PENDING instead. Neither permits replay.

## Production gate / remaining work

Production broker/service/launcher targets do **not** link this module. The
broker rejects `--launch` with usage status 2. This directory's `install` and
`install-check` always refuse until reviewed backend and artifact-pin work is
provided. No installer hashes are repinned or bypassed. On this requested older
base, the unchanged legacy broker/launcher pin checks still match their legacy
artifacts; they do not certify or install the composition. The separate
`f16b589` main exec-status handshake is deliberately not edited or backported;
its installation gate must remain intact when integrating these commits.

The concrete read-only [systemd/cgroup observer](SYSTEMD-OBSERVER.md) now supplies
narrow exact-incarnation absence and independent unit/cgroup metadata-cleanup
callbacks using sd-bus and pinned descriptors. It does not supply create/stop or
exclusive lifetime authority; missing authority/evidence returns UNKNOWN.

Still required: actual protected systemd/cgroup incarnation ownership and
startup census, durable protected expectation/absence records, a real single
owner lifetime-fence implementation, fixed-policy launcher linkage (including the separate exec-status
handshake and authenticated runtime-ready acknowledgment), root-owned startup
policy, independent review, deliberately reviewed artifact pins, and separately
authorized host acceptance. Never infer absence from a PID, launcher death,
EOF, ENOENT or a failed systemd query. No root/sudo/systemd/XFS/host installation,
real-data changes or push was performed for this increment.
