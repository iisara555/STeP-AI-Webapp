#!/usr/bin/env python3
"""Probe the step-runner sudo rule. Synthetic only: runs id/ls/kill/sh, never app code or data."""
import os, subprocess, sys

SUDO = ['sudo', '-n']
RUN = SUDO + ['-u', 'step-runner', '/usr/bin/bwrap']
SYS = ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
       '--ro-bind', '/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=30, **kw)


# 1. The rule allows exactly bwrap as step-runner.
r = run(RUN + ['--unshare-all', '--die-with-parent'] + SYS + ['--', '/usr/bin/id', '-u'])
check('bwrap runs as step-runner (uid 995)', r.returncode == 0 and r.stdout.strip() == '995', (r.stdout + r.stderr).strip()[:120])
r = run(SUDO + ['-u', 'step-runner', '/usr/bin/id'])
check('any other program as step-runner is refused', r.returncode != 0)
r = run(SUDO + ['-u', 'root', '/usr/bin/bwrap', '--ro-bind', '/', '/', '--', '/usr/bin/id', '-u'])
check('bwrap as root is refused', r.returncode != 0)

# 2. step-runner cannot reach itsara's files or the gateway data, even with the whole filesystem mounted.
# Each negative check must prove the program really ran as step-runner first ('ran:995'),
# otherwise a sudo refusal would be mistaken for a successful block.
def as_runner(script):
    return run(RUN + ['--ro-bind', '/', '/', '--', '/bin/sh', '-c', 'echo ran:$(id -u); ' + script])

for path in ['/home/itsara', '/mnt/step-work/step-ai']:
    r = as_runner(f'ls {path}')
    check(f'step-runner cannot list {path}', 'ran:995' in r.stdout and r.returncode != 0 and 'denied' in r.stderr.lower(), (r.stdout + r.stderr).strip()[:100])

# 3. step-runner cannot signal itsara's processes.
r = as_runner(f'kill -0 {os.getpid()}')
check('step-runner cannot signal an itsara process', 'ran:995' in r.stdout and r.returncode != 0, (r.stdout + r.stderr).strip()[:100])

# 4. The caller's environment is not passed through; bwrap --setenv is the way to pass values.
env = dict(os.environ, STEP_PROBE_SECRET='synthetic-not-secret', NODE_CHANNEL_FD='3')
r = run(RUN + ['--clearenv', '--setenv', 'STEP_OK', 'yes', '--unshare-all'] + SYS + ['--', '/usr/bin/env'], env=env)
check('caller environment is not inherited', r.returncode == 0 and 'STEP_OK=yes' in r.stdout and 'STEP_PROBE_SECRET' not in r.stdout and 'NODE_CHANNEL_FD' not in r.stdout)
check('values can be passed with bwrap --setenv', 'STEP_OK=yes' in r.stdout, r.stdout.strip()[:80])

# 5. Informational: does an open file descriptor survive sudo-rs? Decides fork-IPC vs Unix-socket IPC.
import fcntl
r0, w0 = os.pipe()
rfd = fcntl.fcntl(r0, fcntl.F_DUPFD, 20); wfd = fcntl.fcntl(w0, fcntl.F_DUPFD, 21)
os.close(r0); os.close(w0)
saved = fcntl.fcntl(3, fcntl.F_DUPFD, 30) if os.path.exists('/proc/self/fd/3') else None
os.dup2(wfd, 3, inheritable=True)
p = subprocess.run(RUN + ['--unshare-all'] + SYS + ['--', '/bin/sh', '-c', 'echo through >&3'],
                   capture_output=True, text=True, timeout=30, pass_fds=(3,))
os.close(3); os.close(wfd)
if saved is not None:
    os.dup2(saved, 3); os.close(saved)
os.set_blocking(rfd, False)
try:
    got = os.read(rfd, 64).decode()
except BlockingIOError:
    got = ''
print('INFO fd 3 survives sudo-rs:', 'yes' if 'through' in got else 'no', f'(exit {p.returncode})', flush=True)

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
