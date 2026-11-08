#!/usr/bin/env python3
"""Small main-entry mutation gate. Never edits the worktree or talks to systemd."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

if not __debug__:
    raise RuntimeError("assertions must be enabled")

here = pathlib.Path(__file__).resolve().parent
mutations = [
    ("pid", "p != (uint64_t)getpid()", "0"),
    ("canonical-decimal", "(s[0] == '0' && s[1])", "0"),
    ("overflow", "v > (UINT64_MAX - d) / 10", "0"),
    ("full-bounded-set", "n > CUSTODY_MAX", "n >= CUSTODY_MAX"),
    ("duplicate-names", "!strcmp(c->id[i], c->id[j])", "0"),
    ("cloexec", "F_SETFD, FD_CLOEXEC", "F_SETFD, 0"),
    ("close-extras", "close_range(ok ? 3 + c->count : 3, ~0U, 0)", "close_range(90, ~0U, 0)"),
    ("manifest-mode", "(s.st_mode & 07777) == 0600", "1"),
    ("manifest-links", "s.st_nlink == 1", "1"),
    ("manifest-symlink", 'beneath(pdir, "recovery-custody.v1", O_RDONLY | O_NONBLOCK)',
     'openat(pdir, "recovery-custody.v1", O_RDONLY | O_NONBLOCK | O_CLOEXEC)'),
    ("directory-type", "!S_ISDIR(s.st_mode) ||\n            s.st_uid", "0 ||\n            s.st_uid"),
    ("readable-not-opath", "(flags & O_PATH)", "0"),
    ("directory-mode", "(s.st_mode & 022) ||\n            (uint64_t)s.st_dev", "0 ||\n            (uint64_t)s.st_dev"),
    ("expected-device", "(uint64_t)s.st_dev != c->device[i]", "0"),
    ("expected-inode", "(uint64_t)s.st_ino != c->inode[i]", "0"),
]
results = []
source = (here / "broker-main.c").read_text()
with tempfile.TemporaryDirectory(prefix="qb-custody-mutations-", dir=os.environ["TMPDIR"]) as d:
    work = pathlib.Path(d)
    for name in ("core.c", "core.h", "transport.c", "transport.h", "policy.c", "policy.h"):
        shutil.copyfile(here / name, work / name)
    for name, old, new in mutations:
        assert source.count(old) == 1, (name, "BAD-PATTERN")
        (work / "broker-main.c").write_text(source.replace(old, new))
        build = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-O1", "-g0",
                                "-Wall", "-Wextra", "-Werror", "-DQB_BROKER_TESTING", "-pthread",
                                "core.c", "transport.c", "policy.c", "broker-main.c",
                                "-Wl,--wrap=fstatvfs", "-o", "broker"],
                               cwd=work, capture_output=True, text=True, timeout=60)
        assert build.returncode == 0, (name, "BUILD-FAIL", build.stderr)
        test = subprocess.run([sys.executable, str(here / "test-custody.py"), str(work / "broker")],
                              capture_output=True, text=True, timeout=30)
        verdict = "KILLED" if test.returncode else "SURVIVED"
        results.append({"id": name, "verdict": verdict, "output": test.stdout + test.stderr})
        print(name, verdict, flush=True)
        (work / "results.json").write_text(json.dumps(results, indent=2))
    # Optional persistent report outside the temporary compilation directory.
    if len(sys.argv) == 2:
        pathlib.Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + "\n")
assert len(results) == len(mutations) and all(r["verdict"] == "KILLED" for r in results)
print(f"PASS {len(results)} targeted broker-main mutations killed")
