import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from authority import Authority, FakeManager, Fenced

class AdversarialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.path = str(Path(self.tmp.name) / 'state.db')
        Authority.initialize(self.path)
        self.manager = FakeManager(str(Path(self.tmp.name) / 'manager.db'))
    def tearDown(self):
        self.tmp.cleanup()
    def test_capacity_persisted_across_constructors(self):
        a = Authority(self.path, self.manager, 1)
        a.start('alice', 'one', 'work')
        a.close()
        with self.assertRaises(Fenced):
            Authority(self.path, self.manager, 2)
    def test_live_authority_cannot_be_recovered_by_second_instance(self):
        a = Authority(self.path, self.manager, 1)
        op, _ = a.start('alice', 'one', 'work')
        with self.assertRaises(Fenced):
            Authority(self.path, self.manager, 1)
        self.assertEqual(a.state(op), 'RUNNING')
    def test_replay_reports_current_state(self):
        a = Authority(self.path, self.manager, 1)
        op, _ = a.start('alice', 'one', 'work')
        a.stop('alice', op)
        self.assertEqual(a.start('alice', 'one', 'work'), (op, 'RELEASED'))
    def test_invalid_valid_state_transition_is_fenced_before_admission(self):
        a = Authority(self.path, self.manager, 1)
        a.start('alice', 'one', 'work')
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE operations SET state='RELEASED'")
        with self.assertRaises(Fenced):
            a.start('alice', 'two', 'work')
        self.assertEqual(self.manager.count('start'), 1)
    def test_claimed_subject_can_be_spoofed(self):
        a = Authority(self.path, self.manager, 1)
        op, _ = a.start('alice', 'one', 'work')
        # Inputs have no authenticated transport: any caller can claim 'alice'.
        a.stop('alice', op)
        self.assertEqual(a.state(op), 'RELEASED')
