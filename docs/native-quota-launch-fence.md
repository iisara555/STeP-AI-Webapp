# Native revoke-through-launch core seam (not connected)

## Contract

`qb_launch_workspace` is a trusted **in-process** API, not a socket operation.
Its inputs are the authenticated peer UID, canonical user/workspace UUIDs, a
prepared `(device, user_inode, workspace_inode)` identity and a trusted synchronous
`qb_spawn_adapter`. There are no command, argv, environment or caller FD fields.
The identity is a stale-preparation veto, **not authorization**. Status replies
and old receipts cannot authorize a launch.

Under the existing broker mutex the call:

1. Rechecks the user's grant and peer mapping, durable-state health, attached mount
   and quota enforcement, recorded pool identity, workspace ownership/mode,
   project/inheritance and current hard limits.
2. Opens only an already provisioned workspace; never allocates, adopts or repairs
   one. Checks the named pool and workspace still match their retained FDs after
   adapter observations, then compares the prepared identity.
3. Calls the protected adapter with a borrowed receipt/FD while **still holding
   the same mutex as `qb_revoke`**. The adapter must perform the actual fixed-policy
   spawn synchronously, not authorize or enqueue future work.
4. Closes the borrowed FD and releases the mutex on success or callback error,
   preserving the callback's errno. There is no automatic retry.

If launch wins the mutex, revoke waits through callback completion and FD release.
If revoke has completed, no later callback for that user can begin, including
replay after core restart. Revoke does not stop already admitted work. Repeated
requests for a still-authorized user are fresh checks/launch attempts, **not an
exactly-once protocol**; a callback error may follow an actual spawn, so a future
transport must reconcile uncertain outcomes rather than blindly replay.

The grant authorizes the user's pool under the existing policy; this adds no
separate per-workspace delegation ACL or runtime-incarnation identity.

## Trusted-code and lifetime limits

The callback is trusted host code, never selected or supplied by a wire request.
C cannot enforce synchronous behavior of a function pointer. It must not retain
or duplicate the FD for later launches, queue an asynchronous spawn, reopen a
pathname, expose arbitrary commands, reenter/close the broker, exit its thread or
allow thread cancellation during the call. Fork/exec FD handover must be confined
to the one synchronously admitted child. All broker users must be drained/joined
before `qb_close`, as for existing mutation APIs. A slow callback blocks revoke
and quota operations; this seam has no timeout/cancellation promise. Protected
parents and mount administration remain trusted; name checks do not fence a
hostile privileged administrator.

There is no default adapter (`ENOTSUP`), no adapter registered in the service,
no new wire verb and no new root service. Gateway production refusal, existing
transport status-only replies and the fixed-argument runner launcher are unchanged.
**This does not close the end-to-end revoke-through-spawn gate.**

## Evidence

`test-launch.c` uses real unprivileged directory FDs, fake quota/spawn adapters,
condition variables and barriers. A link-time mutex observer proves revoke sees
`EBUSY` during the blocked callback (no sleep-based inference) and sees the
borrowed FD closed when it finally acquires the mutex. Both successful and failing
callbacks are covered; threads are joined before core destruction. Other checks
cover wrong/unknown peers, malformed UUIDs, missing adapter, unallocated/missing
workspace without provisioning, stale identities and substituted workspace/pool,
mode drift, disabled enforcement, quota mismatch, 100 explicit callback-error
attempts, a still-open receipt after revoke, repeated denied requests and restart.

Test-first evidence: the initial new API test failed to compile because the seam
was absent. A later test reproduced a named pool substitution during the final
workspace observation; it failed until the final pool identity recheck was added.
A deliberate temporary unlock-before-callback mutation failed the deterministic
`EBUSY` assertion; the mutation was restored before verification.

Verified unprivileged: native `clean all test analyze`, ASan/UBSan `sanitize`, app
`npm run check` and `npm run check:engine-pin`. No root, sudo, host install,
real XFS/quotactl mutation, runtime launch or real-data change was performed.

## Exact next increment / gates still open

Connect a protected, bounded, authenticated launch request to this API **inside
the same broker authority**, with fixed host-side runtime policy and incarnation-
bound lifecycle/outcome reconciliation. The callback must synchronously invoke
the reviewed `native/runner-launcher` FD-consuming fixed-argument path, preserving
the retained workspace FD through account switch and spawn. Do not add a reply
that the gateway can later redeem independently or defer a privileged spawn until
after the callback. Share revoke with that authority, drain/join transport and
callbacks before core close, and test disconnects, uncertain spawn outcomes and
replay without broad command/FD delegation.

That wiring, root-owned artifacts/ancestors, retirement of alternate broad launch
permissions, actual host FD/account-switch enforcement, XFS acceptance, crash
reconciliation and independent review remain pending. Existing installation and
acceptance hash pins describe older artifacts, not this core-only increment;
**do not install these rebuilt binaries**. Rebuild reproducibly, refresh binary
and wrapper/installer pins and obtain review before publishing owner commands.
No UI/cutover or production-composition change is included.
