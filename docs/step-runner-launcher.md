# Protected step-runner launcher (gate 5) — prepared, NOT yet installed

Status: **prepared, unprivileged evidence only.** Nothing was installed or run as
root. The gateway entry is unchanged and still refuses to start. The driver keeps
the old raw-bwrap path as its default until the owner switches.

## Problem

`/etc/sudoers.d/step-runner` lets itsara run `/usr/bin/bwrap` as step-runner with
**any** arguments. The real-XFS acceptance showed that a file owner outside a user
namespace can set its project id to 0 and clear `PROJINHERIT`, escaping the per-user
quota. A compromised gateway could therefore run bwrap as step-runner without
`--unshare-user`, or bind other paths writable.

## What replaces it

| Part                                                           | Files                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Launcher (C): request parser, checks, compiled-in bwrap vector | `native/runner-launcher/launcher.{c,h}`, `launch-main.c`               |
| Unprivileged tests, TESTING build, fake bwrap                  | `test-launcher.c`, `testing-config.{c,h}`, `fake-bwrap.c`, `Makefile`  |
| New sudoers rule                                               | `native/runner-launcher/install/sudoers-step-runner-launch`            |
| Owner install / revoke / restore / uninstall                   | `install/install-runner-launcher.sh`, `install/test-install-script.sh` |
| Driver option `launcher: 'protected'`                          | `server/src/workspace/step-runner-driver.ts`                           |
| TS tests (unprivileged + contract with the native launcher)    | `server/test/step-runner-launcher.test.ts`                             |
| Gated host tests (prepared, not run)                           | `server/test/step-runner-launcher-host.test.ts`                        |

### Sudoers rule

```text
itsara ALL=(step-runner) NOPASSWD: /usr/local/libexec/step-runner-launch/launch v1 *
```

sudo-rs 0.2.13 (`man 5 sudoers-rs`) allows only exact arguments or a trailing `*`;
any other wildcard is a syntax error (checked: `launch v1 p*` is rejected by
`visudo -c -f`). So the rule fixes the request version and the launcher validates
everything else. `make sudoers-check` parses the fragment with the host visudo.

### Request (the only accepted form)

```text
launch v1 p<ID>/<workspace-uuid> <launch-id> <tmpfs-bytes>
  fd 0  the runtime's key (JSON line), passed through unread
  fd 1  the workspace directory, opened O_RDONLY|O_DIRECTORY by the gateway
  fd 2  diagnostics: "step-runner-launch: REFUSED <check>" and exit 2
```

- `<ID>`: six digits, no leading zero, 100000..199999 (the broker range).
- `<workspace-uuid>`: canonical lowercase 8-4-4-4-12; `STEP_WORKSPACE_ID` is
  `ws_<32 hex>` derived from it.
- `<launch-id>`: 32 lowercase hex; names `/var/lib/step-runner-launch/sockets/<id>`.
- `<tmpfs-bytes>`: canonical decimal, multiple of 65536, 64 KiB..1 GiB.
- Exactly five argv entries. Paths are derived from compiled-in roots, never taken
  from the request.

### Checks before exec (any failure: exit 2, bwrap never runs)

1. fds 0–2 open; every fd ≥ 3 closed (`close_range`), not relying on sudo-rs.
2. Credentials: real/effective/saved uid 995 and gid 983, no supplementary group
   other than 983 (so never root and never the gateway group).
3. Trusted paths: `/usr/bin/bwrap`, `/opt/step/node/bin/node`, `/opt/step/node/bin`,
   `/opt/step/app`, all five app bind sources and every ancestor are root-owned,
   not group/other-writable, no symlinks; directory/file types are checked and
   bwrap/node not setuid/setgid. A symlink at an app bind source would otherwise
   make bwrap expose a different host directory before isolation.
4. Workspace descriptor (fd 1), path-independent first:
   - `F_GETFL` is `O_RDONLY` and not `O_PATH`; `fstat`: directory,
     step-runner:itsara, mode exactly `02750`;
   - `st_dev` equals the broker root's device (`/mnt/step-work/step-ai-broker/root`,
     itself root:itsara `0710` in a root-owned `step-ai-broker`);
   - the kernel's path for the descriptor (`/proc/self/fd/1`) is exactly
     `<broker root>/p<ID>/<uuid>`; only root can rename inside `root/` and `p<ID>`,
     so it cannot move afterwards;
   - its parent (`openat(fd, "..", O_PATH)`) is root:itsara `0750`, same device, at
     `<broker root>/p<ID>`;
   - `FS_IOC_FSGETXATTR` on fd 1: project id = `<ID>` and `PROJINHERIT` set;
   - `files/` is a real (not symlink) step-runner directory.
5. Socket directory: parent `/var/lib/step-runner-launch` trusted;
   `sockets/` itsara `0711`; `<launch-id>` opened `O_PATH|O_NOFOLLOW`, itsara `0711`,
   same device, kernel path exact; handed to bwrap as fd 3.
6. Signals reset, `execve("/usr/bin/bwrap", <vector>, {})` — empty environment.

### The compiled-in vector

Identical to the existing raw-bwrap sandbox (`stepRunnerSandboxArgs`, guarded by
`sandbox-userns.test.ts`), except that the socket directory is `--ro-bind-fd 3`:

```text
--clearenv --setenv PATH … LANG … NODE_ENV production STEP_WORKSPACE_ID ws_… STEP_WORKSPACE_DIR <dir>
  STEP_SYNTHETIC_PROVIDER 1 STEP_RUNTIME_TRANSPORT unix
--unshare-all --unshare-user --disable-userns --die-with-parent --new-session --cap-drop ALL
--proc /proc --dev /dev --size <tmpfs> --tmpfs /tmp
--ro-bind {/usr,/lib,/lib64,/bin,/opt/step/node/bin,/opt/step/app/{node_modules,server/src,server/package.json,package.json,harness}}
--bind-fd 1 <dir> --chdir <dir>/files --ro-bind-fd 3 /run/step-runtime
-- /opt/step/node/bin/node --import file:///opt/step/app/node_modules/tsx/dist/loader.mjs
   --import file:///opt/step/app/server/src/register.mjs /opt/step/app/server/src/workspace/runtime-main.ts
```

Checked locally with bwrap 0.11.1 (unprivileged userns): `--ro-bind-fd` of an
`O_PATH` directory works and bwrap closes both fd 1 and fd 3 before exec.

### Driver

`stepRunnerDriver({ launcher: 'protected', transport: 'authenticated', appRoot:
'/opt/step/app', nodePath: '/opt/step/node/bin/node', socketRoot:
'/var/lib/step-runner-launch/sockets', tmpfsBytes, … })`. The command becomes
`systemd-run --user --scope … -- sudo -n -u step-runner <launcher> v1 p<ID>/<uuid>
<launch-id> <tmpfs>`. Admission, launch journal, descriptor pinning, peer/nonce
authentication, cgroup stop/reap are unchanged. Unpinned starts, specs outside
`<broker root>/p<ID>/<uuid>`, wrong `filesDir`/workspace id, or socket dirs outside
the fixed root fail with `RUNTIME_START_FAILED` / `LAUNCH_SPEC_UNSUPPORTED` before
any socket, journal entry or spawn.

## Evidence (unprivileged, this commit)

- `make -C native/runner-launcher all test analyze sanitize`:
  `test-launcher` 263 checks (request format refusals, exact vector with mandatory
  flags and no forbidden ones, descriptor/location/parent/device/mode/symlink
  refusals on a scratch copy of the layout, socket-dir refusals, trusted-path
  refusals including every app bind source, exec contract through the TESTING main:
  empty env at bwrap, stdin byte for byte, only fds 0–3, refusals never exec);
  `-fanalyzer` clean; ASan/UBSan pass; the production build refuses outside uid 995
  and links no `getenv`. App bind source regressions failed ten checks before the fix.
- `bash native/runner-launcher/install/test-install-script.sh`: 24 checks with
  stubbed privileged tools (real `visudo -c -f` for fragments). Two regressions
  demonstrated successful unsafe installs before the fix: writable or symlinked
  `/opt/step`. The installer now refuses untrusted destination chains before writes
  for install/revoke/restore/uninstall; it never takes over an unsafe existing parent.
- `server/test/step-runner-launcher.test.ts` (6): option/request validation; and a
  contract test that runs the TESTING launcher with exactly the driver's argv and
  requires the exec'd vector to equal the raw-bwrap sandbox.
- `npm run check` passed; `npm test`: 118/118; `npm run test:db`: 29/29;
  `npm run test:engine`: 326/326. Existing raw-bwrap host tests remain gated and
  unchanged, and protected host tests were **not run**.

Not proven: anything through the real sudo rule, real XFS project check on fd 1,
a real runtime under the launcher. Those are the gated host tests below.

## Exact owner commands

Verified SHA-256 (default compiler/flags of this worktree; installer pins launcher,
fragment and Node, not itself):

```text
fb19a64c0bd71aa7eb40b1ecee1c19efb1fd992c17f97d2b015842507bf1a54f  launch
17ad5f375a40519a294e541e0e97871f03b7fee7ce495ee65f58ae9ee830aecd  install/install-runner-launcher.sh
af866337286102d4f687140999a910d08679eec143cb2cc3243136959d0b9a47  install/sudoers-step-runner-launch
08f12d42fb304468e8ee86247fe686aae5b225836ea65e9d6566c11ae6ba2e8e  node (26.12.1 linux-x64)
```

A different compiler or flags can change the binary hash: a mismatched build must
not be installed by bypassing its pin. Review/re-pin the reproducible artifact first.

Build as itsara and compare (reproducible build):

```sh
cd /home/itsara/projects/step-protected-launcher/native/runner-launcher
export TMPDIR=/home/itsara/.hermes/cache/scratch
make clean launch install-check sudoers-check     # pinned == actual, "parsed OK"
sha256sum launch install/install-runner-launcher.sh install/sudoers-step-runner-launch
```

Install (one password prompt; copies root-owned files, the installer re-verifies the pins):

```sh
cd /home/itsara/projects/step-protected-launcher/native/runner-launcher && sudo sh -c '
test ! -e /usr/local/libexec/step-runner-launch &&
test ! -L /usr/local/libexec/step-runner-launch &&
install -d -o root -g root -m 0755 /usr/local/libexec/step-runner-launch &&
install -o root -g root -m 0755 launch /usr/local/libexec/step-runner-launch/launch &&
install -o root -g root -m 0755 install/install-runner-launcher.sh /usr/local/libexec/step-runner-launch/install &&
install -o root -g root -m 0444 install/sudoers-step-runner-launch /usr/local/libexec/step-runner-launch/sudoers-step-runner-launch &&
/usr/local/libexec/step-runner-launch/install --install \
  --app-source /home/itsara/projects/step-protected-launcher \
  --node-source /home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin/node'
```

Then tier A host tests, then close the gate:

```sh
cd /home/itsara/projects/step-protected-launcher && export PATH=/home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin:$PATH
STEP_STEP_RUNNER_TESTS=1 STEP_RUNNER_LAUNCHER_INSTALLED=1 node --import tsx --import ./server/src/register.mjs --test server/test/step-runner-launcher-host.test.ts
sudo /usr/local/libexec/step-runner-launch/install --revoke-bwrap
STEP_STEP_RUNNER_TESTS=1 STEP_RUNNER_LAUNCHER_INSTALLED=1 STEP_RUNNER_BWRAP_REVOKED=1 node --import tsx --import ./server/src/register.mjs --test server/test/step-runner-launcher-host.test.ts
```

After `--revoke-bwrap` the existing raw-bwrap gated suite
(`step-runner-driver.test.ts`) can no longer pass; it must move to the protected
mode (with the broker installed, tier B) before it is run again.

Undo:

```sh
sudo /usr/local/libexec/step-runner-launch/install --restore-bwrap     # undo --revoke-bwrap
sudo /usr/local/libexec/step-runner-launch/install --uninstall --purge # undo --install
sudo rm -r /usr/local/libexec/step-runner-launch
```

## Residual risks

- **The bwrap rule stays until `--revoke-bwrap`.** Until then gate 5 is open.
- **App code is gateway-supplied.** `/opt/step/app` is a root-owned copy of what
  itsara provided; a compromised gateway can stage malicious runtime code at the next
  install. That code still runs only inside the fixed sandbox (own user namespace,
  one workspace), so it cannot escape the quota or reach another workspace, but it
  can misuse the workspace it was given. Same for the old path.
- **The gateway chooses which workspace to launch.** The launcher proves fd 1 is a
  genuine broker workspace at the requested location, not that the gateway user may
  use it; per-user authorisation stays in the gateway.
- **Synthetic provider forced** (`STEP_SYNTHETIC_PROVIDER=1` is compiled in). A
  production provider needs a new launcher version and request field.
- **`/mnt/step-work` is itsara-owned**: renaming `step-ai-broker` away is a denial
  of service (launches refused), not an escape — the launcher requires root-owned
  `step-ai-broker`/`root`/`p<ID>`.
- **Socket root is gateway-owned** (`0711`): the gateway controls which socket
  directory a runtime sees, which it already does; the runtime's peer and key checks
  are unchanged.
- **Root/admin updates are not serialized with launch.** App/bwrap/Node paths are
  checked with `lstat` and later consumed by pathname, not pinned executable/bind
  descriptors. The trusted ancestor chains prevent gateway substitution, but a
  concurrent privileged update can race them. Do not update the installed tree
  while launches are allowed; atomic deployment/fencing is not implemented.
- **Broker revocation is not fenced through spawn.** Workspace ownership, location
  and project attributes are checked at launch, not atomically with a broker grant
  epoch/revocation. This does not close gate 6. Workspace `files/` and the
  gateway-owned socket directory can change after checks; the workspace and socket
  mount sources stay descriptor-pinned, but their contents are not immutable.
- **Resource limits come from the gateway's `systemd-run` scope**, not from the
  launcher. A compromised gateway can launch with no scope (no memory/task/CPU
  limit); it cannot remove the namespace or quota boundary. Moving limits under
  root control is a separate change.
- **rlimits/umask/cwd** are inherited from the gateway through sudo; they can only
  make a launch fail, not widen the sandbox.
- Tier B host tests leave one workspace directory per run in the test user's pool
  (the broker never deletes).
- Staging copies app files with GNU tar run as root on a stream produced as itsara;
  tar's member-name sanitising and delayed symlink creation are relied on.
