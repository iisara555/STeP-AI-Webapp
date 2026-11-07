# Native broker Unix transport — executable seam, NOT installed

This is an implementation prerequisite, not a deployment or a generic RPC spike.
`native/quota-broker/transport.c/.h` builds `libstep-quota-transport.a` and runs a
real Linux Unix-stream service loop against the existing native core.
`test-transport` executes it in another process, on a joinable service thread,
using a fake quota adapter and real unprivileged filesystem/core/journal/socket
operations. No production daemon constructor, service unit, installer or privileged
execution is supplied. The XFS default still returns **ENOTSUP**. The independent
review of `83b0c88` reported no confirmed security/ABI defect in its unprivileged
scope; that is not real quota acceptance and is not an additional open adapter
review blocker. This increment does not edit that adapter or its review worktree.

## Fixed protocol and authority

Trusted startup supplies an already-open core, a protected listening AF_UNIX
SOCK_STREAM descriptor (NONBLOCK + CLOEXEC), a separate protected pollable stop
FD and one immutable allowlisted client UID. There is no request, environment or
CLI configuration loader, default principal, automatic bootstrap, path lookup or
socket unlink/rebind. Startup must protect the socket namespace/ancestors, set
restrictive socket access, acquire/pin startup FDs and protect the binary and its
dependencies. The service validates descriptor type/flags and fixes listen backlog;
that is **not** proof that a caller-supplied listener/stop FD or its ancestors are
protected. Only trusted startup may invoke this library API.

The only wire request is exactly 46 bytes:

```text
ENSURE/1 <canonical lowercase UUID>\n
```

The client must send exactly that frame and **half-close its write side**, retaining
its read side for the response. Write EOF is the frame boundary; newline alone is
not sufficient. No persistent connection, pipelining, extra/trailing bytes, NUL,
JSON, secret, owner, UID, caller path, project ID, quota limit, ancillary caller FD,
revoke, bootstrap,
repair or launch operation is accepted. Fragmented writes are supported within the
absolute deadline. `SO_PEERCRED` is checked immediately after accept, **before any
read, protocol parse, core call or response**; a mismatched UID gets a close with
zero response bytes. Credentials are kernel-derived, never supplied in the frame.
The native core then checks the fixed UID/workspace grant and durable revocation
under its existing authority. The transport does not introduce another allocator.

Replies to allowed peers are only `OK/1\n` or `DENIED/1\n`, then close. Missing or
partial replies mean an unknown/failed exchange, never success. Replies contain no
policy, error detail, paths, IDs, limits, inode/device identity, directory FD or
receipt. Successful receipt FDs stay internal and are closed before replying; no
SCM_RIGHTS is sent. A disconnected client or failed response does not undo a
committed allocation. A retry of the same request uses the core's idempotence;
there is no automatic rollback, deletion or ID reuse.

**A UID identifies a host principal, not a Google user.** A compromised process
with the allowlisted UID (or a passed/compromised connection) can exercise that
principal's fixed workspace grants. Neither peer PID nor random request fields
repair this. Use a protected dedicated per-subject principal/mapping, or design a
separately reviewed authenticated delegation authority before shared-gateway use.
This seam is not a same-UID sandbox or proof of end-user authentication. A broad
privileged broker RPC or treating gateway owner strings as authority is forbidden.

## Bounds and lifetime

- Eight accepted clients; at most eight accepts per poll iteration. Excess clients
  close without parsing. Backlog is reset to eight (Linux can admit one additional
  pending connection); the protected launcher must also restrict who can connect.
- Fixed 47-byte receive arrays: any 47th byte denies, including extra requests.
  SO_RCVBUF/SO_SNDBUF are requested as 1024 bytes per accepted socket; Linux applies
  its own minimum/doubling and kernel accounting. No user-sized allocations or
  unbounded userspace receive/reply queue. Replies use one tiny nonblocking send.
- Absolute 500 ms monotonic input deadline from acceptance, not extended by a slow
  sender. Rechecked per client after synchronous core work. No blocking socket
  reads/writes. Expired payloads never enter the core.
- One calling service thread, no per-client/detached workers. Stop readiness wins
  at poll; every accepted socket is closed before return. Borrowed listener/stop
  FDs remain owned by startup. Do not concurrently run two loops on one listener,
  close/reuse borrowed descriptors, or close the core while this loop is running.
  Startup signals stop, **joins/drains the service**, then closes core, adapter and
  startup FDs in that order. Stopping this loop does not revoke grants or workloads.
- Core callbacks/fsync/mutation are synchronous and cannot be safely cancelled.
  The I/O deadline is **not** a hard wall-clock bound on a committed mutation,
  response or shutdown while kernel/core work is in flight. Stop waits for that
  operation; production supervision/crash recovery is still required. Queued
  sockets expire rather than gaining a fresh deadline after a slow mutation.
- `qb_revoke` stays a protected operator-only internal API, never a socket opcode.
  It shares the core mutex with actual mutation/readback. An in-flight mutation
  may finish before revoke completes; later ensures must deny. The test's separate
  inherited control pipes exist only inside the unprivileged fixture, not in the
  transport library, and are not an operator endpoint shipped for deployment.

## TypeScript coordination — no invented receipt bridge

Read the separate `step-native-quota-integration` worktree's
`server/src/workspace/native-quota.ts`: `NativeQuotaRpc.ensure(frame)` already
forms the same canonical `ENSURE/1 UUID\n` request. Its strict rich Receipt schema
is explicitly an **application seam, not a wire response**. This status-only socket
protocol does not implement or satisfy that schema. A future TS socket client must
use half-close, bounded I/O and exact complete reply matching; it must not turn
`OK/1` into invented mount/enforcement/identity fields or reopen a path and call it
a protected launch authority. No TS file, synthetic-only refusal, production
composition, admission fence or runtime publication path was changed here.

The **single native core journal remains the allocator**. Do not stack
`DiskQuotaLedger.reserve`, an independently writable SQLite ledger or TS project
assignment behind/in front of it. Any future protected receipt/FD bridge must
bind actual core receipt identity and fixed policy without inventing evidence.
A receipt/status is not a launch capability: a protected FD-consuming launcher
must authorize and spawn under the same revocation authority/fence. That launcher
is still missing; this service deliberately neither sends directory FDs nor starts
workloads.

## Reproduce and verified scope

As an ordinary user with `TMPDIR` under user scratch:

```sh
make -C native/quota-broker clean all test analyze
make -C native/quota-broker sanitize
```

All test executables refuse root. `test-transport` uses real cross-process sockets,
SO_PEERCRED, fragmented/half-closed requests, malformed/oversize/trailing/multiple
frames, NUL/uppercase/JSON/revoke attempts, unknown workspace, idle/slow/no-EOF
peers, pre-read rejection of a real kernel peer not on the configured allowlist,
eight-client saturation/recovery, disconnect recovery, no ancillary-FD disclosure,
100 retry/disconnect rounds with child RLIMIT_NOFILE=64, partially sent requests
revoked while connected, preexisting revocation, idle stop/drain/join and a blocked
fake mutation overlapping operator revoke and stop. The service waits for mutation
and joins before core destruction; revoke cannot finish while mutation holds the
core fence. Existing core and fake-XFS tests are retained.

Only unprivileged synthetic fixtures were executed. Zero root/sudo/install,
real quota/attribute ioctl/quotactl, XFS mutation/mount, real data/provider or host
policy changes. App/DB/engine/browser suites are unrelated to this isolated native
increment and were not rerun. Local standards/spec self-review is not independent
review of the new transport; the completed adapter review remains completed.

## Still missing before installation

Approved host mount/root identity, exclusive project census/range, fixed limits,
subject/workspace/delegation/access policy and protected startup principals/FDs;
protected binary/socket/state/ancestors; **independent anti-rollback witness** and
restore/reconciliation (live-journal poisoning is not restart rollback protection);
one allocator and exclusion of alternate quota/launch routes; manager metadata/
publication policy; the protected FD launcher and revocation-through-spawn fence;
real isolated XFS enforcement/exhaustion/escape/mount/crash acceptance; service
supervision and explicit host-change/deployment approval. No runtime request can
bypass the production ENOTSUP gate, and this user-writable checkout must never be
executed as root. Nothing is installed, enabled or real-data ready.
