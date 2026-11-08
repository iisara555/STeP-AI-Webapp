#!/usr/bin/env python3
"""Mutation harness: delete one guard of create-reconcile.c in a scratch copy,
rebuild test-create-reconcile, run it. Same style as native/systemd-create/mutation.
usage: run.py <worktree> <after> <mutations.json> <out.json>"""
import json, os, shutil, subprocess, sys
wt, phase, spec, out = sys.argv[1:5]
muts = json.load(open(spec))
base = os.path.join(os.path.dirname(os.path.abspath(out)), 'work-' + phase)
BUILT = ('*.o', '*.a', 'test-composition', 'test-sanitize', 'test-systemd-observer', 'test-observer-sanitize',
         'test-systemd-bus', 'test-bus-sanitize', 'test-create-reconcile', 'test-reconcile-sanitize', 'mutation')
results = []
for m in muts:
    find, repl = m.get(phase + '_find'), m.get(phase + '_repl', '')
    if find is None:
        continue
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base + '/native')
    for d in ('launch-composition', 'launch-lifecycle', 'quota-broker'):
        ignore = shutil.ignore_patterns(*BUILT) if d == 'launch-composition' else None
        shutil.copytree(os.path.join(wt, 'native', d), os.path.join(base, 'native', d), ignore=ignore)
    src = os.path.join(base, 'native/launch-composition', m.get('file', 'create-reconcile.c'))
    text = open(src).read()
    n = text.count(find)
    if n != 1:
        results.append({'id': m['id'], 'result': 'BAD-PATTERN(count=%d)' % n}); continue
    open(src, 'w').write(text.replace(find, repl))
    d = os.path.join(base, 'native/launch-composition')
    b = subprocess.run(['make', '-s', 'test-create-reconcile'], cwd=d, capture_output=True, text=True)
    if b.returncode:
        results.append({'id': m['id'], 'result': 'BUILD-FAIL', 'log': b.stderr[-400:]}); continue
    try:
        r = subprocess.run(['./test-create-reconcile'], cwd=d, capture_output=True, text=True, timeout=120)
        res = 'SURVIVED' if r.returncode == 0 else 'KILLED'
        log = (r.stdout + r.stderr)[-300:]
    except subprocess.TimeoutExpired:
        res, log = 'KILLED(timeout)', ''
    results.append({'id': m['id'], 'result': res, 'log': log})
json.dump(results, open(out, 'w'), indent=1)
for x in results:
    print('%-6s %s' % (x['id'], x['result']))
