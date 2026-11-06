# Synthetic IPC protocol spike (#57)

## Scope and verdict: PARTIAL

This is a standalone synthetic protocol experiment, not production wiring. **The actual runtime endpoints have not been adapted or exercised. All external behavior is synthetic:** the Node service, method calls, events, errors, and session data are test fixtures. No provider or real workspace data is used. It does not establish production compatibility, authentication, or isolation.

A separate same-UID process successfully connected and forged a valid `ready` message. UID checking alone therefore does not authenticate the service. The harness also compares Linux `SO_PEERCRED` PID with the transient unit's `MainPID` for the legitimate connection; this one-time comparison is a diagnostic observation, not an authentication mechanism or production isolation boundary.

## Run and safety

On Linux with a working systemd user manager, Python 3, and the Node executable at the hard-coded path in `ipc-protocol-57.py`, run:

```sh
python3 spikes/57-synthetic-ipc/ipc-protocol-57.py
```

The harness uses a fresh random unit name, a private temporary directory under `$TMPDIR` (or `/home/itsara/.hermes/cache/scratch`), and a private Unix socket. It starts a synthetic Node process and a transient systemd user service with `RuntimeMaxSec=30s` and `KillMode=control-group`. The regular cleanup path stops and resets the exact unit and checks it is inactive, not found, and has `MainPID=0`; it removes the temporary directory. The subprocess calls and socket operations have timeouts. Abrupt termination can bypass Python cleanup and leave a temporary directory or transient unit metadata; the unit runtime limit bounds the service itself, not every possible artifact. Run only in an environment where a transient user service is acceptable; check and clean up any specific leftover unit if interrupted. The Node path and fallback scratch directory are host-specific.

## Observed execution

One execution of the preserved harness succeeded on the original host (exit 0):

```text
PASS distinct forged same-UID process passes UID-only check and sends ready
PASS systemd service peer SO_PEERCRED UID/PID match and ready
PASS split UTF-8 frame, coalesced requests, events, error, nonce correlation, out-of-order concurrent results
PASS disconnect exits service; in-flight call receives no result
CLEANUP hermes57-ipc-6b7f507acf1f428f90f901b5a8900201.service LoadState=not-found ActiveState=inactive MainPID=0
CLEANUP temporary directory removed
```

No matching units appeared in the user manager listing immediately after the run. The host user manager reported `degraded` before the test; the test still passed, and the cause of that broader manager state was not investigated.

### What worked

The synthetic framing handled split UTF-8, coalesced frames, events and out-of-order nonce-correlated results; disconnect ended the service with a request in flight. Unit cleanup passed on this run.

### What did not / recommendation

Same-UID spoofing passed. Do not use UID, this toy protocol, or the observed PID check as a production trust boundary. Design and validate authentication, process lifecycle and actual runtime endpoint integration separately before considering production use.
