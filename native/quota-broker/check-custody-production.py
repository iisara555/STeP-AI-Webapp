#!/usr/bin/env python3
"""Refuse fake broker seams in a production object (nm AND retained string scan)."""
import pathlib
import sys

if not __debug__:
    raise RuntimeError("assertions must be enabled")

symbols, strings = [pathlib.Path(p).read_text() for p in sys.argv[1:]]
assert " main" in symbols, "missing main symbol / invalid nm output"
assert "recovery-custody.v1" in strings, "missing known production string"
for forbidden in ("QB_CUSTODY_TEST_SEAM", "CUSTODY UNKNOWN %s", "--trust-root",
                  "fake_space_dir", "__wrap_fstatvfs"):
    assert forbidden not in symbols + strings, "test seam in production: " + forbidden
print("PASS production broker object has no custody test seams")
