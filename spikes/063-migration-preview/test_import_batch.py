import json
import subprocess
import sys
import unittest
from pathlib import Path

from import_batch import build_batch

HERE = Path(__file__).parent
FIXTURE = json.loads((HERE / 'synthetic_history.json').read_text())


class ImportBatchTests(unittest.TestCase):
    def test_only_approved_private_sessions_become_conversations(self):
        batch = build_batch(FIXTURE)
        ids = [c['sourceConversationId'] for c in batch['conversations']]
        self.assertEqual(ids, ['00000000-0000-0000-0000-000000000001',
                               '00000000-0000-0000-0000-000000000002',
                               '00000000-0000-0000-0000-000000000003'])
        # Every source row is accounted for; shared, memory and document rows are held back, not dropped.
        self.assertEqual(batch['preview']['input_count'], len(FIXTURE['records']))
        self.assertEqual(batch['held_back'], {'deferred_shared': 1, 'document_import_unsupported': 1,
                                              'not_a_conversation': 1})

    def test_mappings_are_released_only_after_approval(self):
        self.assertEqual(build_batch(FIXTURE)['mappings'], [
            {'sourceOwnerId': '00000000-0000-0000-0000-000000000001', 'userId': 'g101'},
            {'sourceOwnerId': '00000000-0000-0000-0000-000000000002', 'userId': 'g202'}])
        unapproved = dict(FIXTURE, approvals=['user-1'])
        batch = build_batch(unapproved)
        self.assertEqual([m['userId'] for m in batch['mappings']], ['g101'])
        # Bob's session is then unmapped and never emitted as an import candidate.
        self.assertNotIn('00000000-0000-0000-0000-000000000003',
                         [c['sourceConversationId'] for c in batch['conversations']])
        self.assertEqual(batch['held_back']['unmapped_or_ambiguous_identity'], 1)

    def test_conversation_carries_source_content_and_owner_but_no_target(self):
        conversation = build_batch(FIXTURE)['conversations'][0]
        self.assertEqual(set(conversation), {'schemaVersion', 'source', 'sourceConversationId', 'sourceOwnerId',
                                             'title', 'createdAt', 'updatedAt', 'messages'})
        self.assertEqual([m['role'] for m in conversation['messages']], ['user', 'status', 'assistant', 'user'])

    def test_missing_content_blocks_the_row(self):
        contents = dict(FIXTURE['contents'])
        del contents['00000000-0000-0000-0000-000000000002']
        batch = build_batch(dict(FIXTURE, contents=contents))
        self.assertEqual(len(batch['conversations']), 2)
        self.assertEqual(batch['held_back']['missing_content'], 1)

    def test_cli_reads_stdin_and_writes_json(self):
        out = subprocess.run([sys.executable, str(HERE / 'import_batch.py')], input=json.dumps(FIXTURE),
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), build_batch(FIXTURE))


if __name__ == '__main__':
    unittest.main()
