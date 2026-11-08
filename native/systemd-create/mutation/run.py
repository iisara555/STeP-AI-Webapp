#!/usr/bin/env python3
"""Mutation harness: apply one find/replace in a scratch copy, rebuild, run the check.
usage: run.py <worktree> <before|after> <mutations.json> <out.json>
Each entry: id, desc, <phase>_find, <phase>_repl, optional file (default create.c),
optional build/run argv (default: make -s test-create / ./test-create).
KILLED = build ok and check failed; SURVIVED = check passed."""
import json, os, shutil, subprocess, sys
wt, phase, spec, out = sys.argv[1:5]
muts = json.load(open(spec))
base = os.path.join(os.path.dirname(os.path.abspath(out)), 'work-' + phase)  # keep out under a scratch dir
results = []
for m in muts:
    find, repl = m.get(phase + '_find'), m.get(phase + '_repl', '')
    if find is None:
        continue
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base + '/native')
    for d in ('systemd-create', 'launch-lifecycle'):
        shutil.copytree(os.path.join(wt, 'native', d), os.path.join(base, 'native', d),
                        ignore=shutil.ignore_patterns('*.o', '*.a', 'test-create', 'test-sanitize', 'fixture-*',
                                                      'pin-check', 'pin-check-negative'))
    src = os.path.join(base, 'native/systemd-create', m.get('file', 'create.c'))
    text = open(src).read()
    n = text.count(find)
    if n != 1:
        results.append({'id': m['id'], 'result': 'BAD-PATTERN(count=%d)' % n}); continue
    open(src, 'w').write(text.replace(find, repl))
    d = os.path.join(base, 'native/systemd-create')
    b = subprocess.run(m.get('build', ['make', '-s', 'test-create']), cwd=d, capture_output=True, text=True)
    if b.returncode:
        results.append({'id': m['id'], 'result': 'BUILD-FAIL', 'log': b.stderr[-400:]}); continue
    try:
        r = subprocess.run(m.get('run', ['./test-create']), cwd=d, capture_output=True, text=True, timeout=300)
        res = 'SURVIVED' if r.returncode == 0 else 'KILLED'
        log = (r.stdout + r.stderr)[-300:]
    except subprocess.TimeoutExpired:
        res, log = 'KILLED(timeout)', ''
    results.append({'id': m['id'], 'result': res, 'log': log})
shutil.rmtree(base, ignore_errors=True)
json.dump(results, open(out, 'w'), indent=1)
for x in results:
    print('%-6s %s' % (x['id'], x['result']))
