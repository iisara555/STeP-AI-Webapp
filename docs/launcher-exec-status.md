# Fixed launcher exec-status handshake — uninstalled prerequisite

This implements the missing descriptor-preservation protocol, not a launch service
or a cgroup manager. Based on integration `57ee78a`; service findings in the separate
`step-native-launch-service` revision `ff56b6b` were read only. That refusal increment
is not part of this base. The current broker still has no launch registration;
`--serve-launch` is unsupported and exits 2. Gateway production refusal is unchanged.

## Two entry points, no new caller policy

- `launch` / `srl_launch`: legacy sudo behavior, still closes **all FDs >= 3**.
  No argv flag or environment variable enables service mode.
- `launch-service` / `srl_launch_service`: a separately built, **not installed**
  service child entry. It accepts the same fixed v1 request and bwrap policy, with
  a single additional compiled-in descriptor, **FD 4**. There is no configurable
  FD, executable, environment forwarding, SCM_RIGHTS request or command protocol.

The future root-owned service must create a private `AF_UNIX/SOCK_SEQPACKET`
socketpair **as root before fork and privilege drop**, retain one reader, and give
only the other endpoint to the fixed child at FD 4. The launcher checks connected
Unix seqpacket type and kernel `SO_PEERCRED` creator UID 0 (testing: scratch owner),
then sets NONBLOCK and CLOEXEC. A root-created socketpair remembers its creation
credentials after the child drops privileges. This does not inspect the parent's
current credentials or prove root-owned executable installation: the trusted
service must verify its fixed executable/ancestors and protect both endpoints.
Never expose these endpoints to the gateway or workload. No root-to-runner switch
is implemented here; real/effective/saved credentials and groups are still checked.

Only FD 4 survives service descriptor cleanup, alongside 0/1/2. FD 3 is cleared
then opened as the validated socket directory; every FD >= 5 is closed. FD 4 stays
CLOEXEC through validation and closes on the fixed bwrap exec. It is not given to
bwrap or the runtime. Runtime capability bootstrap remains unread stdin, workspace
is FD 1, diagnostics FD 2. Both production executables read no environment.

## Status and parent interpretation

Each record is exactly four network-order uint32 values (16 bytes): magic
`0x53524c31`, stage, launcher error, exec errno. Stages:

| Stage                | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1 ENTERED            | Launcher image reached the service entry and validated status FD. Not workspace validation.                           |
| 2 VALIDATED          | All launcher checks completed; immediately before the fixed bwrap exec.                                               |
| 3 FAILED             | Structured validation failure (`srl_error`, errno 0), or bwrap exec failure (`SRL_E_INTERNAL`, actual errno).         |
| 4 LAUNCH_EXEC_FAILED | Trusted post-fork stub could not exec the fixed launcher (actual errno, launcher error 0); only valid before ENTERED. |

The parent uses `srl_status_receive` as a **nonblocking** one-record observer with
its own absolute startup deadline and bounded poll budget. It rejects malformed,
oversized, duplicate/out-of-order or ancillary-bearing messages; received rights
are closed, not accepted as authority. The state has no `running` or `ready` bit.
The future trusted post-fork stub can use `srl_status_send` for stage 4 after its
fixed `execve` returns, then `_exit`; the unprivileged exec fixture exercises this.
No general-purpose spawn helper or production stub is introduced.

Keep these observations separate:

1. `fork()` returning a PID proves only creation; `fork() == -1` is a local fork
   failure with no child, not a status frame. Close the parent's writer immediately.
2. Stage 4 proves launcher exec failure; ENTERED proves launcher image entry.
   No ENTERED plus EOF/deadline is **UNKNOWN**, not successful launcher exec.
3. FAILED identifies the reported validation or bwrap exec error. VALIDATED+EOF
   is only **bwrap-exec-or-child-death**, never definitive bwrap success.
4. **Actual runtime readiness requires a separate fresh per-incarnation nonce /
   capability acknowledgment on the authenticated runtime channel**, with the
   expected kernel peer, role-separated challenge/MAC, and runtime `ready` frame.
   Existing `unix-channel.ts` / `step-runner-driver.ts` implement that layer;
   the service must explicitly compose it, not substitute status EOF or fake
   bwrap's exit 0. This increment preserves that bootstrap but does not wire the
   native service to the runtime channel. The real-runtime and forged-ready TS
   tests exercise the separate layer, not a root service composition.

### Unavoidable ambiguity

A child killed after VALIDATED but before `execve` yields exactly the same frames
and EOF as a successful bwrap exec. A child can also die before ENTERED or while
reporting a failure. A full/closed status socket makes reporting fail; it never
makes launch proceed after a failed ENTERED/VALIDATED send. A lost final failure
frame remains UNKNOWN. No signal handler, wait status or CLOEXEC trick removes
all these windows. Tests deliberately kill real child processes at three stages
to preserve this distinction. Even a later authenticated ready acknowledgment is
a momentary readiness observation, not proof of continued life or descendant
absence. Status is neither launch authority nor permission to retry an incarnation.

## Evidence and blocked installation

Unprivileged tests use `launch-service-testing` and fake bwrap in a scratch tree:
missing/closed FD 4, device/stream/pipe/unconnected socket types, missing stdin,
invalid request, failed launcher exec, bwrap EACCES, successful fake exec, empty
environment, no status FD leakage and byte-exact separate nonce bootstrap.
Protocol tests cover SIGKILL before entry/after ENTERED/after VALIDATED, hostile
frames/rights, wrong creator UID, CLOEXEC and broken-peer SIGPIPE avoidance.
The original successful-ack test failed against the old launcher before the fix.

Verified: runner-launcher `clean all test analyze sanitize`, with normal rebuild;
quota-broker `clean all test analyze sanitize`; `npm run check` (17 existing engine
diagnostics); 17 targeted launcher/Unix-channel/real-runtime tests (all passed,
no skips; existing Node module.register deprecation). No privileged host tests.

**Installation is blocked until independent review and deliberate repinning.**
The changed legacy binary no longer matches the old installer SHA-256;
`make install-check` intentionally fails. Old binary pins/runbook commands are
stale and must not be used or bypassed. No pins or installer privileges were
changed, and there is no installer for `launch-service`. Rebuild reproducibly,
review both entry points and update all independent artifact/bootstrap pins only
as part of the approved lifecycle-complete installation increment.

Durable incarnation ownership, containment-before-exec, crash census,
stop/kill/emptiness and capacity release, protected principal transition, shared
revoke authority, actual authenticated-runtime composition, independent review
and real host/XFS acceptance remain open. Production launch must stay refused.
No root, sudo, host configuration, installation, real-data/XFS operation or push
was performed; the separate service-findings checkout was not modified.
