#!/usr/bin/env python3
"""Exercise the actual documented root bootstrap unprivileged in a scratch layout.
Only ownership and install's -o/-g are simulated; hashes/modes/symlinks are real.
"""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
DOC = HERE.parents[2] / 'docs/step-runner-launcher.md'


class Bootstrap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch')))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / 'usr/local/libexec/step-runner-launch'
        self.dest.parent.mkdir(parents=True)
        self.source = self.root / 'source'
        (self.source / 'install').mkdir(parents=True)
        self.marker = self.root / 'executed'
        self.writes = self.root / 'writes'
        artifacts = {
            'launch': b'launcher fixture\n',
            'install/install-runner-launcher.sh': f'#!/bin/bash\ntouch {self.marker}\n'.encode(),
            'install/sudoers-step-runner-launch': b'sudoers fixture\n',
        }
        text = DOC.read_text()
        match = re.search(r"<<'ROOT_BOOTSTRAP'\n(.*?)\nROOT_BOOTSTRAP", text, re.S)
        self.assertIsNotNone(match, 'owner command must contain independently testable root bootstrap')
        assert match is not None
        self.script = match[1]
        for name, content in artifacts.items():
            (self.source / name).write_bytes(content)
            actual = HERE.parent / name
            pin = hashlib.sha256(actual.read_bytes()).hexdigest()
            self.assertIn(pin, self.script, f'independent full pin missing: {name}')
            self.script = self.script.replace(pin, hashlib.sha256(content).hexdigest())
        self.script = self.script.replace('/usr/local/libexec/step-runner-launch', str(self.dest))
        self.script = self.script.replace('/home/itsara/projects/step-protected-launcher/native/runner-launcher', str(self.source))
        stub = self.root / 'stub'
        stub.mkdir()
        bodies = {
            'stat': f'''last=${{!#}}; [[ $last == {self.root}* ]] || {{ echo '0 755'; exit; }}; [[ $last != "${{BAD_OWNER_PATH:-}}" ]] || {{ echo '1000 755'; exit; }}; a=(); for x in "$@"; do a+=("${{x//%u/0}}"); done; exec /usr/bin/stat "${{a[@]}}"''',
            'install': f'''echo write >>{self.writes}; a=(); while (($#)); do case $1 in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; exec /usr/bin/install "${{a[@]}}"''',
        }
        for name, body in bodies.items():
            path = stub / name
            path.write_text('#!/bin/bash\n' + body + '\n')
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{stub}:/usr/bin:/bin')
        self.script = self.script.replace('export PATH=/usr/sbin:/usr/bin:/sbin:/bin', f'export PATH={stub}:/usr/sbin:/usr/bin:/sbin:/bin')
        for prefix in ['/opt', '/var', '/etc']:
            (self.root / prefix[1:]).mkdir()
            self.script = self.script.replace(prefix + '/', str(self.root) + prefix + '/')
        (self.root / 'var/lib').mkdir()
        (self.root / 'etc/sudoers.d').mkdir()
        for path in self.root.rglob('*'):
            if path.is_dir():
                path.chmod(0o755)

    def run_bootstrap(self):
        return subprocess.run(['/bin/bash', '-c', self.script], env=self.env, capture_output=True, text=True)

    def test_valid(self):
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.marker.exists())

    def test_each_artifact_tamper(self):
        for name in ['launch', 'install/install-runner-launcher.sh', 'install/sudoers-step-runner-launch']:
            with self.subTest(name=name):
                path = self.source / name
                before = path.read_bytes()
                path.write_bytes(before + b'# tampered\n')
                result = self.run_bootstrap()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.marker.exists())
                path.write_bytes(before)
                if self.dest.exists():
                    import shutil
                    shutil.rmtree(self.dest)

    def test_unsafe_ancestors_before_any_write(self):
        for level in ['usr', 'usr/local', 'usr/local/libexec', 'opt', 'var', 'var/lib', 'etc', 'etc/sudoers.d']:
            path = self.root / level
            moved = path.with_name(path.name + '-real')
            for kind in ['nonroot', 'group-write', 'other-write', 'symlink']:
                with self.subTest(level=level, kind=kind):
                    if kind == 'nonroot':
                        self.env['BAD_OWNER_PATH'] = str(path)
                    elif kind == 'symlink':
                        moved = path.with_name(path.name + '-real')
                        path.rename(moved)
                        path.symlink_to(moved, target_is_directory=True)
                    else:
                        path.chmod(0o775 if kind == 'group-write' else 0o757)
                    result = self.run_bootstrap()
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertFalse(self.writes.exists(), 'unsafe ancestor allowed a root write')
                    self.assertFalse(self.marker.exists())
                    self.env.pop('BAD_OWNER_PATH', None)
                    if kind == 'symlink':
                        path.unlink()
                        moved.rename(path)
                    path.chmod(0o755)


if __name__ == '__main__':
    if os.getuid() == 0:
        raise SystemExit('refusing root')
    unittest.main()
