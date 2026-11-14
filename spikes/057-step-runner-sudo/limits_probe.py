#!/usr/bin/env python3
"""Synthetic: can itsara's user manager limit and fully stop step-runner processes?

Starts `sudo -u step-runner bwrap ... sh` inside a uniquely named user scope with
MemoryMax/TasksMax/CPUQuota, spawns a detached descendant that ignores SIGTERM,
then stops the scope and checks every process is gone. Sleepers only; no app code.
"""
import os, subprocess, time, uuid

UNIT = f'step-limit-probe-{uuid.uuid4().hex[:12]}.scope'
SYS = ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
       '--ro-bind', '/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
# Leader writes its own and a detached child's host PIDs (no PID namespace so host PIDs are real),
# the child ignores TERM and lives in a new session.
SCRIPT = ('trap "" TERM; setsid sh -c \'trap "" TERM; while :; do sleep 1; done\' & '
          'echo "$$ $!" > /tmp/pids; cat /proc/self/cgroup; while :; do sleep 1; done')
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def prop(name):
    return subprocess.run(['systemctl', '--user', 'show', UNIT, '-p', name, '--value'],
                          capture_output=True, text=True).stdout.strip()


def runner_pids():
    out = subprocess.run(['pgrep', '-u', 'step-runner'], capture_output=True, text=True).stdout
    return {int(p) for p in out.split()}


before = runner_pids()
proc = subprocess.Popen(
    ['systemd-run', '--user', '--scope', '--quiet', f'--unit={UNIT}',
     '-p', 'MemoryMax=128M', '-p', 'TasksMax=16', '-p', 'CPUQuota=50%',
     'sudo', '-n', '-u', 'step-runner', '/usr/bin/bwrap', '--unshare-net', '--unshare-ipc',
     '--die-with-parent', '--new-session'] + SYS + ['--', '/bin/sh', '-c', SCRIPT],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    time.sleep(3)
    cg = prop('ControlGroup')
    path = '/sys/fs/cgroup' + cg
    procs = [int(p) for p in open(path + '/cgroup.procs').read().split()] if cg else []
    uids = {p: int(open(f'/proc/{p}/status').read().split('Uid:')[1].split()[0]) for p in procs if os.path.exists(f'/proc/{p}')}
    check('scope created with a cgroup', bool(cg), cg)
    check('step-runner (995) processes are inside the scope', 995 in uids.values(), str(sorted(set(uids.values()))))
    mem, pids_max = open(path + '/memory.max').read().strip(), open(path + '/pids.max').read().strip()
    cpu = open(path + '/cpu.max').read().strip()
    check('memory limit applied', mem == str(128 * 1024 * 1024), mem)
    check('process-count limit applied', pids_max == '16', pids_max)
    check('CPU limit applied', cpu.startswith('50000 '), cpu)
    inside = runner_pids() - before
    check('detached step-runner descendant exists', len(inside) >= 2, str(sorted(inside)))

    # Finding: itsara's user manager cannot signal uid 995, so `systemctl --user stop` leaves
    # step-runner processes behind. The kernel's cgroup.kill does not need per-process
    # signal permission, only write access to the delegated cgroup file.
    t0 = time.time()
    with open(path + '/cgroup.kill', 'w') as f:
        f.write('1')
    # Proof of emptiness: either cgroup.events says `populated 0`, or the cgroup directory is gone.
    # The kernel refuses to remove a populated cgroup, and unit names are random and never reused,
    # so disappearance of THIS path proves THIS incarnation emptied.
    evidence = None
    for _ in range(100):
        try:
            if 'populated 0' in open(path + '/cgroup.events').read():
                evidence = 'populated 0'
        except FileNotFoundError:
            evidence = 'cgroup removed by kernel'
        if evidence:
            break
        time.sleep(0.05)
    elapsed = time.time() - t0
    left = [p for p in inside if os.path.exists(f'/proc/{p}')]
    check('cgroup.kill removed every step-runner process', not left, f'{elapsed:.2f}s, left={left}')
    check('emptiness proven before release', evidence is not None, str(evidence))
    subprocess.run(['systemctl', '--user', 'stop', UNIT], capture_output=True, text=True, timeout=60)
    time.sleep(0.3)
    check('scope cgroup is gone after stop', not os.path.exists(path))
finally:
    subprocess.run(['systemctl', '--user', 'stop', UNIT], capture_output=True)
    subprocess.run(['systemctl', '--user', 'reset-failed', UNIT], capture_output=True)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    stray = runner_pids() - before
    print('cleanup: unit', prop('LoadState') or 'gone', '| stray step-runner pids:', sorted(stray) or 'none')

print(f'\n{sum(results)}/{len(results)} checks passed')
