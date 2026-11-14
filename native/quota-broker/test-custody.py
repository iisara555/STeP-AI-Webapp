#!/usr/bin/env python3
"""Real broker-main entry, no root/systemd/cgroup mutation; parent models FD custody."""
import atexit
import os
import pathlib
import select
import signal
import socket
import sys
import tempfile

if not __debug__:
    raise RuntimeError("assertions must be enabled")

binary = os.path.abspath(sys.argv[1])
assert os.geteuid() != 0
ID = "0123456789abcdef0123456789abcdef"
NAME = "qbc-" + ID
children = set()
notify = None

def cleanup():
    for pid in children:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
atexit.register(cleanup)

def start(root, sources, env=None, command="--recover-custody", close_activation=None):
    # Fork rather than preexec_fn: LISTEN_PID must name the exec'd broker itself.
    inp, child_in = os.pipe()
    child_out, out = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.dup2(inp, 0)
        os.dup2(out, 1)
        os.dup2(out, 2)
        copies = [os.dup(fd) for fd in sources]
        # Copies must not collide with activation targets.
        import fcntl
        safe = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 100) for fd in copies]
        for i, fd in enumerate(safe):
            os.dup2(fd, 3 + i, inheritable=True)
        # Deliberately unrelated inherited descriptor, must not survive cleanup.
        os.dup2(safe[0], 80, inheritable=True)
        if close_activation is not None:
            os.close(close_activation)
        e = dict(os.environ)
        for key in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
            e.pop(key, None)
        e.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS=str(len(sources)),
                 LISTEN_FDNAMES=":".join([NAME] * len(sources)))
        e["NOTIFY_SOCKET"] = str(root / "notify")
        e.update(env or {})
        for key in list(e):
            if e[key] is None:
                del e[key]
        args = [binary, command, "--trust-root", str(root), "--policy-dir", "/policy",
                "--broker-dir", "/broker", "--socket-dir", "/socket", "--fake-dir", "/fake"]
        os.execve(binary, args, e)
    children.add(pid)
    os.close(inp)
    os.close(out)
    return pid, child_in, child_out

def line(fd):
    data = b""
    while not data.endswith(b"\n"):
        assert select.select([fd], [], [], 5)[0], data
        got = os.read(fd, 1)
        if not got:
            break
        data += got
    return data.decode()

def finish(p, expected=2):
    pid, w, r = p
    os.close(w)
    text = b""
    while True:
        assert select.select([r], [], [], 5)[0], text
        b = os.read(r, 4096)
        if not b:
            break
        text += b
    os.close(r)
    _, status = os.waitpid(pid, 0)
    children.remove(pid)
    assert notify is not None
    assert not select.select([notify], [], [], 0)[0], "unexpected systemd readiness"
    assert os.waitstatus_to_exitcode(status) == expected, text
    assert b"READY" not in text, text
    return text.decode()

with tempfile.TemporaryDirectory(prefix="qb-custody-", dir=os.environ["TMPDIR"]) as d:
    root = pathlib.Path(d)
    notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    notify.bind(str(root / "notify"))
    (root / "policy").mkdir(mode=0o700)
    original = root / "original"
    original.mkdir(mode=0o700)
    substitute = root / "substitute"
    substitute.mkdir(mode=0o700)
    fd = os.open(original, os.O_RDONLY | os.O_DIRECTORY)
    bad = os.open(substitute, os.O_RDONLY | os.O_DIRECTORY)
    s = os.fstat(fd)
    manifest = root / "policy/recovery-custody.v1"
    valid = f"QB-CUSTODY/1\n{ID} {s.st_dev} {s.st_ino} directory\n"
    def publish(text=valid, mode=0o600):
        manifest.write_text(text)
        manifest.chmod(mode)
    publish()
    # RED tracer: main must retain the original descriptor, not reopen the replaced path.
    p = start(root, [fd])
    assert line(p[2]) == f"CUSTODY UNKNOWN {ID} {s.st_dev} {s.st_ino}\n"
    assert os.stat(f"/proc/{p[0]}/fd/3").st_ino == s.st_ino
    assert set(os.listdir(f"/proc/{p[0]}/fd")) == {"0", "1", "2", "3"}
    flags = pathlib.Path(f"/proc/{p[0]}/fdinfo/3").read_text().split("flags:\t")[1].splitlines()[0]
    assert int(flags, 8) & os.O_CLOEXEC
    original.rename(root / "retained")
    original.mkdir(mode=0o700)
    os.kill(p[0], signal.SIGKILL)
    finish(p, -signal.SIGKILL)
    # Parent retained fd survives child death; fresh exec must get that same inode.
    p = start(root, [fd])
    assert line(p[2]) == f"CUSTODY UNKNOWN {ID} {s.st_dev} {s.st_ino}\n"
    assert os.stat(f"/proc/{p[0]}/fd/3").st_ino != original.stat().st_ino
    assert "recovery unavailable" in finish(p)
    print("PASS original FD across broker death/reexec and pathname substitution, CLOEXEC, extra-FD closure")
    cases = [
        {"LISTEN_PID": "1"}, {"LISTEN_PID": "01"}, {"LISTEN_PID": None},
        {"LISTEN_FDS": "-1"}, {"LISTEN_FDS": "01"}, {"LISTEN_FDS": "17"},
        {"LISTEN_FDS": "18446744073709551617"}, {"LISTEN_FDS": "1x"},
        {"LISTEN_FDS": None}, {"LISTEN_FDNAMES": None},
        {"LISTEN_FDNAMES": "qbc-" + "f" * 32},
        {"LISTEN_FDNAMES": "unknown"}, {"LISTEN_FDNAMES": NAME[:-1]},
        {"LISTEN_FDNAMES": NAME + ":"}, {"LISTEN_FDNAMES": NAME * 100},
        {"LISTEN_FDS": "2", "LISTEN_FDNAMES": NAME},
        {"LISTEN_FDS": "0", "LISTEN_FDNAMES": ""},
        {"LISTEN_PID": None, "LISTEN_FDS": None, "LISTEN_FDNAMES": None},
    ]
    for e in cases:
        text = finish(start(root, [fd], e))
        assert "REFUSED" in text and "CUSTODY UNKNOWN" not in text, (e, text)
    assert "custody activation UNKNOWN" in finish(start(root, [fd, fd]))
    for missing in (3, 4):
        assert "custody activation UNKNOWN" in finish(start(
            root, [fd, bad], {"LISTEN_FDNAMES": NAME + ":qbc-" + "f" * 32},
            close_activation=missing))
    assert "custody identity" in finish(start(root, [bad]))
    regular = root / "regular"
    regular.write_text("not a directory")
    regular.chmod(0o600)
    reg = os.open(regular, os.O_RDONLY)
    st = os.fstat(reg)
    publish(f"QB-CUSTODY/1\n{ID} {st.st_dev} {st.st_ino} directory\n")
    assert "custody identity" in finish(start(root, [reg]))
    os.close(reg)
    publish()
    pathfd = os.open(root / "retained", os.O_PATH)
    assert "custody identity" in finish(start(root, [pathfd]))
    os.close(pathfd)
    publish(valid.replace(f" {s.st_dev} ", f" {s.st_dev + 1} "))
    assert "custody identity" in finish(start(root, [fd]))
    publish()
    (root / "retained").chmod(0o777)
    assert "custody identity" in finish(start(root, [fd]))
    (root / "retained").chmod(0o700)
    print("PASS malformed activation, duplicate/unknown/truncated names, substituted descriptor")
    for text in [valid[:-1], valid + valid.split("\n", 1)[1],
                 valid.replace(str(s.st_ino), "18446744073709551617"),
                 valid.replace("directory", "regular"), ""]:
        publish(text)
        assert "custody manifest" in finish(start(root, [fd]))
    publish()
    os.link(manifest, root / "manifest-link")
    assert "custody manifest" in finish(start(root, [fd]))
    (root / "manifest-link").unlink()
    publish(mode=0o666)
    assert "custody manifest" in finish(start(root, [fd]))
    manifest.unlink()
    (root / "other-manifest").write_text(valid)
    (root / "other-manifest").chmod(0o600)
    manifest.symlink_to(root / "other-manifest")
    assert "custody manifest" in finish(start(root, [fd]))
    manifest.unlink()
    assert "custody manifest" in finish(start(root, [fd]))
    publish()
    # Full bounded set, deliberately reverse manifest order: bind by entry,
    # never by manifest row number, FDNAME alone or all-to-one identity.
    many = []
    records = []
    ids = [f"{i:032x}" for i in range(16)]
    for i in range(16):
        path = root / f"entry-{i}"
        path.mkdir(mode=0o700)
        many.append(os.open(path, os.O_RDONLY | os.O_DIRECTORY))
        st = os.fstat(many[-1])
        records.append(f"{ids[i]} {st.st_dev} {st.st_ino} directory\n")
    publish("QB-CUSTODY/1\n" + "".join(reversed(records)))
    names = ":".join("qbc-" + i for i in ids)
    p = start(root, many, {"LISTEN_FDNAMES": names})
    for i, held in enumerate(many):
        st = os.fstat(held)
        assert line(p[2]) == f"CUSTODY UNKNOWN {ids[i]} {st.st_dev} {st.st_ino}\n"
    assert set(os.listdir(f"/proc/{p[0]}/fd")) == {str(i) for i in range(19)}
    assert "recovery unavailable" in finish(p)
    # Correct names, wrong per-entry assignment must fail too.
    assert "custody identity" in finish(start(root, many[::-1], {"LISTEN_FDNAMES": names}))
    for held in many:
        os.close(held)
    publish()
    assert "quota-only" in finish(start(root, [fd], command="--serve"))
    # Repeated real child startup failures must not accumulate parent descriptors.
    baseline = len(os.listdir("/proc/self/fd"))
    for _ in range(32):
        assert "custody identity" in finish(start(root, [bad]))
    assert len(os.listdir("/proc/self/fd")) == baseline
    os.close(fd)
    os.close(bad)
    notify.close()
    print("PASS protected manifest refusal, quota-only serve, 32 repeated failures without FD leaks")
