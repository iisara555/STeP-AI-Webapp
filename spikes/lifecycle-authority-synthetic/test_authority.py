import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from authority import Authority, FakeManager, Fenced

HERE = Path(__file__).parent

class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.db = str(Path(self.tmp.name) / 'state.db')
        self.effects = str(Path(self.tmp.name) / 'fake.db')
        Authority.initialize(self.db)
        self.manager = FakeManager(self.effects)
        self.a = Authority(self.db, self.manager, capacity=1)
    def tearDown(self):
        self.a.close()
        self.tmp.cleanup()
    def crash(self, action, point, request='r1'):
        self.a.close()
        env = dict(os.environ, CRASH_POINT=point)
        p = subprocess.run([sys.executable, str(HERE / 'worker.py'), self.db, self.effects, action, request], env=env)
        self.assertEqual(p.returncode, 91)
    def test_durable_reservation_and_idempotency(self):
        op, _ = self.a.start('alice', 'r1', 'work')
        self.assertEqual((op, 'RUNNING'), self.a.start('alice', 'r1', 'work'))
        self.assertEqual(self.manager.count('start'), 1)
        with self.assertRaises(Fenced): self.a.start('alice', 'r1', 'different')
        with self.assertRaises(Fenced): self.a.start('alice', 'r2', 'work')
        self.a.stop('alice', op)
        self.assertEqual(self.a.state(op), 'RELEASED')
        self.a.stop('alice', op)
        self.assertEqual(self.manager.count('stop'), 1)
        self.a.start('alice', 'r2', 'work')
    def test_start_effect_then_exception_retains_capacity_and_cannot_recover(self):
        class EffectThenRaise(FakeManager):
            def effect(self, kind, op):
                super().effect(kind, op)
                if kind == 'start':
                    raise RuntimeError('synthetic response lost')

        self.a.manager = EffectThenRaise(self.effects)
        with self.assertRaisesRegex(RuntimeError, 'synthetic response lost'):
            self.a.start('alice', 'r1', 'work')
        op = self.a.lookup('alice', 'r1')
        self.assertIsNotNone(op)
        self.assertEqual(self.manager.count('start'), 1)
        self.assertEqual(self.a.state(op), 'LAUNCHING')
        self.assertEqual(self.a.start('alice', 'r1', 'work'), (op, 'LAUNCHING'))
        with self.assertRaises(Fenced):
            self.a.start('alice', 'r2', 'work')
        with self.assertRaises(Fenced):
            self.a.stop('alice', op)
        self.a.close()
        self.a = Authority(self.db, self.manager, capacity=1)
        self.assertEqual(self.a.state(op), 'UNKNOWN')
        self.assertEqual(self.a.start('alice', 'r1', 'work'), (op, 'UNKNOWN'))
        with self.assertRaises(Fenced):
            self.a.start('alice', 'r2', 'work')
        with self.assertRaises(Fenced):
            self.a.stop('alice', op)
        self.assertEqual(self.manager.count('start'), 1)
        self.assertEqual(self.manager.count('stop'), 0)

    def test_crash_launch_boundaries_fail_closed(self):
        self.tearDown()
        for point, effects in [('after_reserve',0), ('after_launching',0), ('after_start_effect',1), ('after_running',1)]:
            with self.subTest(point=point):
                self.setUp()
                self.crash('start', point)
                restarted = Authority(self.db, self.manager, capacity=1)
                op = restarted.lookup('alice', 'r1')
                self.assertEqual(restarted.state(op), 'UNKNOWN')
                self.assertEqual(self.manager.count('start'), effects)
                self.assertEqual(restarted.start('alice', 'r1', 'work'), (op, 'UNKNOWN'))
                with self.assertRaises(Fenced): restarted.start('alice', 'r2', 'work')
                with self.assertRaises(Fenced): restarted.stop('alice', op)
                restarted.close()
                self.tearDown()
    def test_crash_stop_boundaries(self):
        self.tearDown()
        for point, expected in [('after_stopping','UNKNOWN'), ('after_stop_effect','UNKNOWN'), ('after_verified','RELEASED'), ('after_release','RELEASED')]:
            with self.subTest(point=point):
                self.setUp()
                self.crash('stop', point)
                restarted = Authority(self.db, self.manager, capacity=1)
                op = restarted.lookup('alice', 'r1')
                self.assertEqual(restarted.state(op), expected)
                if expected == 'UNKNOWN':
                    with self.assertRaises(Fenced): restarted.start('alice', 'r2', 'work')
                else: restarted.start('alice', 'r2', 'work')
                restarted.close()
                self.tearDown()
    def test_invalid_state_and_corruption_fence(self):
        self.a.start('alice', 'r1', 'work')
        with sqlite3.connect(self.db) as db: db.execute("update operations set state='BOGUS'")
        with self.assertRaises(Fenced): self.a.state('irrelevant')
        with open(self.db, 'wb') as f: f.write(b'not a database')
        with self.assertRaises(Fenced): self.a.state('irrelevant')
    def test_missing_store_not_recreated(self):
        os.unlink(self.db)
        with self.assertRaises(Fenced): self.a.state('irrelevant')
        self.assertFalse(os.path.exists(self.db))
    def test_subject_and_request_boundaries(self):
        op, _ = self.a.start('alice', 'r1', 'work')
        with self.assertRaises(Fenced): self.a.stop('bob', op)
        self.assertEqual(self.manager.count('stop'), 0)

if __name__ == '__main__': unittest.main()
