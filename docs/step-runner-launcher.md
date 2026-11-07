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
- `make -C native/runner-launcher install-script-test`: 26 lifecycle checks with
  stubbed privileged tools (real unprivileged `visudo -c -f` for fragments), plus
  three Python tests exercising the **actual documented inline bootstrap** with
  real hashes, modes and symlinks in a remapped scratch layout. Tests cover
  independent full pins for each copied artifact, successful verification before
  execution, and non-root/group-writable/other-writable/symlinked destination
  ancestors refusing before any write. Bootstrap ownership is simulated, not
  privileged acceptance. The lifecycle regressions failed before the fixes:
  busy purge deleted app/Node; live-principal purge succeeded. Both now refuse
  before removing even the sudoers rule and preserve app/Node; unexpected socket
  parent entries also preserve the installation. Purge requires the offline
  maintenance prerequisite below; process snapshots do not fence concurrent launch.
- `server/test/step-runner-launcher.test.ts` (6): option/request validation; and a
  contract test that runs the TESTING launcher with exactly the driver's argv and
  requires the exec'd vector to equal the raw-bwrap sandbox.
- `npm run check` passed; `npm test`: 118/118; `npm run test:db`: 29/29;
  `npm run test:engine`: 326/326. Existing raw-bwrap host tests remain gated and
  unchanged, and protected host tests were **not run**.

Not proven: anything through the real sudo rule, real XFS project check on fd 1,
a real runtime under the launcher. Those are the gated host tests below.

## Exact owner commands

Verified SHA-256 (default compiler/flags of this worktree; the bootstrap below
independently pins installer, launcher and fragment; the installer also pins
launcher, fragment and Node):

```text
fb19a64c0bd71aa7eb40b1ecee1c19efb1fd992c17f97d2b015842507bf1a54f  launch
93b9289a21af661faecabeee1a96c420da424d209fef84c15fa737714b476326  install/install-runner-launcher.sh
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

Install (one password prompt). Obtain the three full expected hashes below from
an independently reviewed/trusted copy of this runbook, NOT from the checkout or
the installer being copied. The inline root shell is the bootstrap trust base;
review it too. It validates every existing destination ancestor before its first
write. Root executes only the installed copy after all three independent checks
pass. No checkout script is executed as root. Do not run during concurrent
privileged updates.

```sh
sudo /bin/bash <<'ROOT_BOOTSTRAP'
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077
src=/home/itsara/projects/step-protected-launcher/native/runner-launcher
dst=/usr/local/libexec/step-runner-launch
# Validate ALL existing ancestors before install -d, copies or any other writes.
trusted_existing_dirs() {
  local p=$1 meta
  while :; do
    if [[ -e $p || -L $p ]]; then
      [[ -d $p && ! -L $p ]] || { echo "REFUSED directory: $p" >&2; exit 2; }
      meta=$(stat -c '%u %a' -- "$p")
      [[ ${meta%% *} == 0 ]] && (( (8#${meta#* } & 8#022) == 0 )) ||
        { echo "REFUSED ownership/mode: $p" >&2; exit 2; }
    fi
    [[ $p != / ]] || break
    p=$(dirname -- "$p")
  done
}
for p in "$dst" /opt/step /var/lib /etc/sudoers.d; do
  trusted_existing_dirs "$p"
done
for p in "$dst" /opt/step/app /opt/step/node /var/lib/step-runner-launch /etc/sudoers.d/step-runner-launch; do
  [[ ! -e $p && ! -L $p ]] || { echo "REFUSED existing destination: $p" >&2; exit 2; }
done
install -d -o root -g root -m 0700 -- "$dst"
install -o root -g root -m 0755 -- "$src/launch" "$dst/launch"
install -o root -g root -m 0755 -- "$src/install/install-runner-launcher.sh" "$dst/install"
install -o root -g root -m 0444 -- "$src/install/sudoers-step-runner-launch" "$dst/sudoers-step-runner-launch"
# Hash the COPIES in the validated root-only chain, not the mutable sources.
sha256sum --check --strict <<'EXPECTED_SHA256'
fb19a64c0bd71aa7eb40b1ecee1c19efb1fd992c17f97d2b015842507bf1a54f  /usr/local/libexec/step-runner-launch/launch
93b9289a21af661faecabeee1a96c420da424d209fef84c15fa737714b476326  /usr/local/libexec/step-runner-launch/install
af866337286102d4f687140999a910d08679eec143cb2cc3243136959d0b9a47  /usr/local/libexec/step-runner-launch/sudoers-step-runner-launch
EXPECTED_SHA256
chmod 0755 -- "$dst"
"$dst/install" --install \
  --app-source /home/itsara/projects/step-protected-launcher \
  --node-source /home/itsara/.hermes/tools/node-26.12.1-linux-x64/bin/node
ROOT_BOOTSTRAP
```

On copy/hash failure nothing is executed. Inspect/remove the partial root-owned
bootstrap directory before retrying; never bypass a mismatching hash.

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

Undo (restoring bwrap reopens gate 5; it is not needed to uninstall):

**`--purge` is offline-only, not a concurrent deployment operation.** The enforced
operational prerequisite is a boot with `systemd.unit=emergency.target`, network
disconnected, using the root console (not an itsara SSH/sudo session). Do not start
multi-user services, cron/at, gateway/workload user managers, containers, or allow
logins/jobs for uid 1000 or 995 until purge completes. There must be no remaining
processes with either real or effective uid 1000/995; the installer checks both
and refuses before any removal. This snapshot is defense in depth, **not a launch
fence**: emergency/offline maintenance is what prevents a new process from
appearing after the check. A stopped gateway service or empty socket directory
alone is insufficient, especially while the old arbitrary-bwrap rule exists.
If this prerequisite cannot be enforced, use `--uninstall` **without `--purge`**
and leave app/Node/socket files intact. Do not remove the bootstrap directory
while workloads may still run.

From that offline root console, purge using:

```sh
/usr/local/libexec/step-runner-launch/install --uninstall --purge
rm -r /usr/local/libexec/step-runner-launch
```

Non-purging undo (files retained, so it does not require offline purge):

```sh
sudo /usr/local/libexec/step-runner-launch/install --restore-bwrap # optional; reopens the unsafe rule
sudo /usr/local/libexec/step-runner-launch/install --uninstall
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
