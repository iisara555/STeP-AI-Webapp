# Running workspaces as `step-runner` (#57): proposed sudo rule and probe

Host facts (ik-node-01): sudo is **sudo-rs 0.2.13**, with no `-C`/`closefrom_override`, so Node's fork IPC channel (fd 3) may not survive the account switch. `/home/itsara` is `0750` and `~/.hermes` is `0700`, so `step-runner` cannot read app code or the Node binary from their current locations; a real deployment must place code and Node in a root-owned, world-readable path (e.g. `/opt/step`). AppArmor restricts unprivileged user namespaces, but Ubuntu's `bwrap-userns-restrict` profile permits bwrap.

`sudoers-step-runner` lets `itsara` run only `/usr/bin/bwrap` as `step-runner`, without a password. It only ever lowers privilege. Validated with `visudo -c -f` (parsed OK).

`probe.py` checks, after installation: bwrap runs as uid 995; any other program as step-runner, and bwrap as root, are refused; step-runner cannot list `/home/itsara` or `/mnt/step-work/step-ai` and cannot signal an itsara process (each negative check first proves the program really ran as 995, so a sudo refusal cannot pass as a block); the caller's environment is not inherited and `bwrap --setenv` passes values. It also reports whether fd 3 survives sudo-rs, which decides between keeping fork IPC and switching to the per-sandbox Unix-socket protocol in `spikes/57-synthetic-ipc`.

Before installation: 2/8 pass (only the two "refused" checks), as expected.

Not established: workspace-to-workspace separation when all share one account (relies on bwrap mount/PID namespaces), resource limits, descendant cleanup, and the runtime itself running this way. Remove the rule with `sudo rm /etc/sudoers.d/step-runner`.

## Result after installation (2026-11-06)

Owner installed the rule as `/etc/sudoers.d/step-runner` (root:root 0440); `sudo -l -u step-runner` lists only `/usr/bin/bwrap`. Probe: **8/8 passed**. **fd 3 does not survive sudo-rs**, so Node fork IPC cannot be used across the account switch; the runtime must use the per-sandbox Unix-socket protocol instead (see `spikes/57-synthetic-ipc`, which also showed that a same-UID peer can forge `ready`, so each sandbox needs its own socket directory bound only into it, plus peer-credential and nonce checks).
