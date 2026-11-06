# Optional synthetic runtime/runner assembly

## Status and architecture

This is an integration increment, not a production deployment or Desktop-parity sign-off.
`server/src/gateway/main.ts` still refuses startup unconditionally; no environment flag bypass was added.
The existing Web UI and its production provider configuration are unchanged.

Assembly branch `work/runtime-runner-assembly` starts from integration `3c5a2db` in
`/home/itsara/projects/step-runtime-runner-assembly`.

Reviewed overlap before integration:

- Runner `145c36e` / `5164f81`: `process-driver.ts` factors sandbox mounts; `runtime-main.ts` adds a
  nonce-only socket endpoint. Driver owns account switching, peer UID checking, scopes and confirmed cleanup.
- Cleanup branch through `c3c6e68`: adds bounded memory/task/CPU acceptance and fail-closed observation parsers.
  These commits were retained, not replaced with new experiments.
- Unix transport `f883189` / `a89ef14`: same `process-driver.ts` and `runtime-main.ts` overlap, but uses inherited
  JSON bootstrap plus role-separated challenge/MAC authentication and bounded result failure.
- Kept the runner's mount factoring and scope lifecycle, consciously resolved runtime endpoint conflicts, and
  extracted one shared authenticated manager-side handshake used by both drivers. The old runner nonce protocol
  remains compatible for existing standalone fixtures; **the assembly always selects authenticated transport**.
  The integration's newer quota helper files were preserved (the older runner branch predates them).

```text
Explicit Authenticator -> createGateway / RunService -> real RuntimeManager (max 10)
  namespace option -> isolated processDriver -> authenticated Unix channel -> real pinned engine
  runner option    -> explicit synthetic fixture preparation -> stepRunnerDriver
                      -> systemd scope -> existing sudo/bwrap -> authenticated Unix channel -> real pinned engine
```

`createSyntheticAssembly` in `server/src/gateway/synthetic-assembly.ts` is the opt-in composition API:

- Requires `purpose: 'synthetic-only'`, an explicit authenticator, disposable quota-provisioned `dataRoot`,
  explicit workspace quota and a selected runtime kind. There is no anonymous auth or unsandboxed fallback.
- Returns `{server, manager, close}`; does not bind a network listener automatically. Bind **loopback only**.
- Both paths force the existing in-sandbox synthetic AI endpoint and disable public search. No provider key,
  real Google credential or external AI call is required by the tests.
- `runtime: {kind: 'namespace', socketRoot}` is a same-account namespace rehearsal, not account isolation.
- `runtime: {kind: 'step-runner', options, prepareWorkspace}` requires explicit app/Node/socket/UID/resource
  settings and a disposable-fixture provisioning callback. It forces the real runtime entry and authenticated
  1 MiB frames even if a JS caller attempts to override those fields. Preparation is async **outside** admission;
  actual spawn remains synchronous **inside** the manager's authorization fence. No built-in chmod or host
  provisioning policy is hidden in the factory.
- Bootstrap capability goes only over inherited stdin, with the sandbox-local endpoint path. The runner checks
  `SO_PEERCRED` before sending the challenge. Authentication uses fresh challenges and role-separated HMACs;
  readiness is accepted only after authentication. Socket path/UID alone is not authentication.
- Auth transport bounds frames to 1 MiB, output queues to 4 MiB, unauthenticated handshake time to 2 seconds.
  Runner additionally retains 8 pending peers / 32 refusals and its startup deadline. Unlike legacy nonce mode's
  4 KiB first frame, authenticated handshake input currently shares the bounded 1 MiB frame limit.
- Local oversize results produce `RUNTIME_RESULT_TOO_LARGE` without killing the healthy runtime. Closed-channel
  error delivery is guarded. Runner outbound enqueue failure removes its pending RPC and timeout immediately.
- Close is idempotent, closes connections and awaits manager shutdown; failed cleanup remains retryable.

## Reproduce

Use Node 26.12.1 (`/home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin` first on PATH), existing dependencies,
and the pinned Harness submodule. Use a local dependency copy, not a symlink outside this checkout: sandbox
mounts intentionally cannot see the other checkout. Do not install packages or change home traversal permissions
just to make a test pass.

Namespace assembly (10 synthetic identities, real HTTP/manager/engine, authenticated Unix transport):

```sh
node --import tsx --import ./server/src/register.mjs --test server/test/synthetic-assembly.test.ts
```

Actual account-switched runner assembly on an **already provisioned** test host:

```sh
STEP_STEP_RUNNER_TESTS=1 node --import tsx --import ./server/src/register.mjs --test --test-name-pattern='authenticated assembly' server/test/step-runner-driver.test.ts
```

The host test reuses the established runner harness and existing sudo rule; it copies code/Node to its own
`/mnt/step-work/step-driver-test-*` fixture because the runner cannot traverse the private service home.
Only disposable workspace fixture directories get shared access (0777); this is explicitly **not** a production
permissions policy. Cleanup removes runner-owned synthetic files through the same existing runner/bwrap path,
proves absence of new runner PIDs, units and sockets, and deletes the fixture. No sudoers, host accounts,
mounts, package installation, production data or remote writes are changed.

Both assembly tests open ten distinct live runtimes before work, exercise ten concurrent requests, reject
unauthenticated/cross-owner access, and stop/resume persisted conversation history. Synthetic bearer identities
are injected at the approved auth seam; this is not real Google-account acceptance. Namespace coverage runs
jobs through HTTP RunService; the runner test uses HTTP identity/start/denial and manager ask/history seams.

## Verification and review scope

- Node 26.12.1, unchanged `desktop-v0.6.20` Harness pin (`90ee71c`).
- `npm run check`, build, engine-pin check and `git diff --check` pass; server checker retains the existing
  17 upstream engine diagnostics delegated to Desktop CI, and Vite retains the existing chunk-size warning.
- `npm test`: 118 passed. `npm run test:db`: 29 passed. Ungated `npm run test:engine`: 241 passed;
  the opt-in runner suite is explicitly disabled in that command, not credited as passed.
- Actual opt-in runner suite with `--test-skip-pattern='bounded (memory|task|CPU)'`: 21 passed, zero failed.
  Three pressure tests are excluded from that command and **not claimed rerun**. The ten-user authenticated
  runner assembly passed both its initial focused run and the broader non-pressure host run. The latter also
  verified an early wrong-UID peer gets zero bytes, a wrong-capability same-UID peer gets only a random
  challenge, genuine startup succeeds, and local oversized outbound RPC rejection leaves the same PID healthy.
- Relevant `cloud-workspace.spec.ts` Playwright checks: 2 desktop passed, 2 existing mobile skips. This uses
  the existing scripted UI fixture and is not a browser-to-runner/Google deployment acceptance test.
- Independent checked inventory: pgrep exit 1 with empty stdout/stderr; systemctl exit 0 with empty streams;
  no runner scope cgroups or `step-driver-test-*` folders. Existing integration remains clean at `3c5a2db`.
- Local manual standards review: preserved pinned-engine provenance, no dependency/pin/production-entry change,
  no private data committed; shared handshake avoids a second authentication implementation. This focused
  subagent could not spawn independent review agents; parent independent review is still required before merge.
- Local manual spec review: optional assembled synthetic runtime/runner slice is implemented and exercised;
  real-data deployment and near-Desktop parity remain explicitly incomplete. The permissive disposable runner
  fixture is a known test limitation, not an approved production access policy.

## Review fix semantics

The review fixes start at `03d277db14c03e4c2199984a5573225487842628` on the same assembly branch.

- `stop()`/`stopWithAdmission()` succeed only after both process-absence proof and required systemd unit
  cleanup confirmation. A failed stop/reset command is harmless only when the subsequent successful query
  confirms `LoadState=not-found` or `ActiveState=inactive`; failed/unknown queries never establish cleanup.
- `RUNTIME_STOP_FAILED` still means process cleanup was not confirmed. `RUNTIME_CLEANUP_FAILED` means
  processes **were proven absent**, but required unit metadata cleanup is unconfirmed. It does not assert
  that a process survived. The latter rejects stop/shutdown and accompanies the driver's one-shot `onExit`
  notification as its optional second argument, so even autonomous crash cleanup retains the manager handle,
  failed state and conservative capacity reservation. No replacement start can bypass that reservation.
- A retry redoes outstanding unit cleanup, not cgroup signalling/proof. Once it succeeds the manager removes
  the reservation and reports stopped. Gateway assembly close already delegates to retryable manager shutdown;
  no production entry or host policy was opened by this change. Manager state is not durable across a crash
  of the supervisor; orphan reconciliation remains a separate release gate.
- Unix process-driver synchronous send rejection invokes the same finalizer used by replies, exit and timeout:
  RPC message/exit listeners and any timer are removed before rejection. No listener-limit increase or socket
  teardown hides the leak. Sixteen oversized local calls reject without MaxListeners warnings or listener/timer
  growth, followed by same-PID health and successful small RPC. Existing Node loader deprecation warnings remain.
- Red/green evidence: all three real-manager stop/shutdown/crash cases failed before the cleanup fix; a further
  metadata-retry fault test failed when cgroup re-observation incorrectly changed a known process-absence result
  to `RUNTIME_STOP_FAILED`. The Unix test emitted both exit/message MaxListeners warnings before the send fix.

Verification on the review-fix worktree (Node 26.12.1): `npm run check`, build, engine-pin and
`git diff --check` pass; application **118/118**, database **29/29**, ungated engine **242/242**.
The opt-in runner command excluding `bounded (memory|task|CPU)` passes **24/24**, including the three
real-manager fault tests, retry without renewed cgroup access, post-retry capacity release and ten-runtime
assembly. Three pressure cases were deliberately excluded, not rerun. Relevant Cloud Workspace Playwright:
**2 desktop passed, 2 existing mobile skips**; this remains a scripted UI fixture, not browser-to-runner auth
acceptance. Final independent read-only inventory: `pgrep` exit 1 with empty streams, `systemctl` exit 0 with
empty streams, no runner scope cgroups or `step-driver-test-*` fixture/socket folders. Existing 17 upstream
engine diagnostics, Node loader deprecations and Vite chunk warning remain. Local standards/spec review found
no additional blocking defect in this scope; independent parent review is still required before integration
(this focused subagent cannot spawn the two independent reviewers). No merge, deployment or host policy change.

## Remaining release gates (do not remove the production refusal yet)

1. Enforced exclusive launcher/broker: the existing sudo rule still permits alternate bwrap invocations as
   step-runner. Constrain launches to the approved namespace/mount/network/resource policy; audit every bypass.
2. Root-owned runner-readable app/Node/dependency installation and least-privilege per-workspace provisioning.
   Replace permissive synthetic fixture access with verified service/runner access and inaccessible peer data.
   Prove manager reads of stopped runner-owned indexes/backups under that actual policy.
3. Socket-root group/ACL hardening, endpoint/procfs/bootstrap confidentiality, hostile same-UID/early-peer and
   denial-of-service acceptance on the assembled authenticated runner path. Component tests do not certify this.
4. Workspace disk **and inode** quota provisioning/exhaustion/recovery on the actual mounted storage; the quota
   helper proposal is preserved but neither installed nor accepted here. CPU/memory/task tests are retained;
   resource acceptance must cover the final authenticated deployed policy, not only legacy protocol fixtures.
5. Gateway/host crash and restart reconciliation of orphan scopes; retain capacity/handles on unknown cleanup,
   recover persistent metadata, and prove no old runtime survives a new supervisor incarnation.
6. Real HTTPS/proxy/Web routing, Google domain/invitation/revocation/expiry and real provider/short-lived secret
   acceptance on the deployed path. No injected synthetic identity counts as that acceptance.
7. Ten concurrent authenticated **real deployed** sessions: cross-user denial, streaming/reconnect/cancel,
   quota contention, persistence, enforced resource limits and recovery under representative workload.
8. Encrypted off-machine/removable-offsite backup, restore drill, migration/rollback verification and owner
   operational acceptance. Do not use existing private data for synthetic tests.
9. Near-Desktop feature acceptance: files/document export, workspace memory/knowledge, approvals, allowed
   Google/Browser/MCP integrations and their UI on the real runtime path; native-only features stay explicitly
   unavailable. Passing this assembly slice does not complete that scope.
