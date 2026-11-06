# Optional runtime Unix transport — development boundary only

The real `runtime-main.ts` endpoint now supports `processDriver({ transport: 'unix' })`.
`isolated: true` adds the existing Bubblewrap namespace profile and binds **only this
incarnation's socket directory** into that sandbox. The default remains fork IPC;
Gateway configuration and its unconditional production refusal are unchanged.

This is not an account-switched production driver. Do not activate it as one.

## Protocol and authority

- The manager creates a fresh endpoint and 256-bit capability per start. The capability
  is sent only over the spawned process's standard input, which is then closed. It is
  absent from arguments, environment, workspace files and protocol traffic.
- Each side challenges the other with a fresh 256-bit random challenge. HMAC-SHA256
  uses role-separated `step-runtime-v1` domains. A runtime must authenticate before
  `ready`, result or event messages are accepted. The runtime also verifies the manager
  before sending application messages. A second authenticated connection cannot replace
  the first; the endpoint is never reused for a successor incarnation.
- Mode 0711 on the manager-owned endpoint directory and 0666 on its socket intentionally
  permit a different account to connect without giving it directory mutation rights.
  Permissions, a random path, and **shared UID are not authentication**. The HMAC proves
  possession of the private inherited capability, not kernel PID/UID identity.
- The trusted computing base includes the launcher and intermediaries handling stdin.
  A process able to inspect manager memory or steal/intercept that pipe can impersonate
  the runtime. The unsandboxed/same-account mode is for tests, not a hostile same-UID
  boundary. For account-switched use, the manager must be a distinct protected principal;
  the sandbox must not see the manager/other runtimes' procfs or inherited capabilities.
- JSON frames are newline-delimited UTF-8, limited to 1 MiB, with at most 4 MiB queued
  output. Malformed frames, invalid envelopes, excess queueing and failed authentication
  close the channel. Eight concurrent unauthenticated peers and two-second handshake
  deadlines bound handshake state. An endpoint-local attacker can still deny service;
  this is not a promise of availability under a local DoS attack.

## Lifecycle

`prepareUnixRuntime()` prepares the socket asynchronously, outside admission. Actual
`spawn` remains synchronous inside the existing start admission callback. Calls still
write synchronously before returning their Promise, so existing revocation/COMMIT fences
remain meaningful. Existing nonce correlation, events, health, start timeout, stop
admission, forced cleanup and retained uncertain handles remain in the process driver.
Socket destruction asks the real runtime to exit; `stop()` waits for child exit and
socket cleanup. Denied/skipped start admission removes prepared endpoints. Failed
post-spawn admission kills and confirms exit before returning the original error.

`prepareUnixRuntime().spawn(command, args, options)` can feed a trusted launcher such as
sudo/Bubblewrap over fd 0 without requiring inherited fd 3. It is deliberately a transport
primitive, **not** a complete cross-account lifecycle or deployment policy.

## Account-switch / resource-control blockers

The current process driver's PID signalling is appropriate only for its existing
same-account child. It must **not** be mechanically prefixed with `sudo -u step-runner`:
prior probes proved that the user manager cannot signal the switched workload, and the
launcher exiting is not proof its descendants are gone.

Before an account-switched driver can be accepted, a separate implementation must:

1. Validate a root-owned, runner-readable code/Node/dependency layout (the current home
   and Hermes Node path are inaccessible to the runner). Do not chmod the private home
   or pass a broad home bind as a workaround. Stage/approve deployment separately.
2. Pass the allowlisted runtime environment explicitly through Bubblewrap after sudo's
   environment filtering; bind only its provisioned workspace and its own endpoint.
3. Launch inside a unique bounded cgroup with memory, CPU, pids and lifetime limits;
   hold authority through startup ambiguity, crashes and restart reconciliation.
4. Stop gracefully over the authenticated socket, then use the narrowly authorized
   cgroup kill path. Confirm the exact incarnation is empty before releasing capacity;
   launcher `exit`, `systemctl stop` success, a socket disconnect or UID equality is
   insufficient. See `spikes/057-step-runner-sudo/README.md`.
5. Provision workspace ownership and disk/inode quotas using an approved helper, not
   transport code or arbitrary privileged commands. Exercise exhaustion and recovery.
6. Exercise the real runtime across the actual account switch, including inherited
   stdin secrecy, concurrent hostile runner peers, descendant cleanup and crash recovery.

No privileged host changes, account switch, deployment, live provider or production data
are part of this implementation. Existing synthetic isolation tests passing is not
acceptance of the unfinished account-switched boundary.

## Verification

Node 26.12.1: new tests exercise real runtime SQLite/conversation RPC, errors, health,
stop/resume, isolated synthetic engine answers, a distinct same-UID forged-ready peer,
split UTF-8/coalesced frames, malformed/oversized frames, and denied/skipped/post-spawn
admission cleanup. TDD red runs demonstrated the missing socket endpoint, missing sandbox
socket mount, premature stop completion and disconnect cleanup bypass. All six transport/manager tests pass;
the complete engine suite passes 223/223. Unit tests 118/118, database tests 29/29, build,
server type policy and engine pin also pass. Node emits existing module.register
warnings; server type policy allows 17 existing pinned-engine diagnostics. The two
Cloud Workspace desktop Playwright checks could not launch Chromium because the host
lacks `libatk-1.0.so.0`; no browser assertions ran and no privileged install was attempted.
