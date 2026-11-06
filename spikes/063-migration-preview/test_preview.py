import builtins
import copy
import json
import socket
import unittest
from unittest.mock import patch
from preview import preview

BASE = {'type': 'memory', 'id': 'record-1', 'tenant_id': 'tenant-1', 'owner_id': 'user-1', 'visibility': 'private', 'workspace_id': None}
MAP = [{'auth_user_id': 'user-1', 'google_sub': 'sub-1'}]

class PreviewTests(unittest.TestCase):
    def test_non_list_records_rejected_without_values(self):
        for records in (None, 'DO-NOT-PRINT-SECRET', {'DO-NOT-PRINT-SECRET': 1}, (BASE,)):
            with self.subTest(kind=type(records).__name__):
                with self.assertRaisesRegex(TypeError, '^records must be a list$') as error:
                    preview(records, MAP)
                self.assertNotIn('DO-NOT-PRINT-SECRET', str(error.exception))

    def test_duplicate_ids_fail_closed_across_owners_and_invalid_rows(self):
        mappings = MAP + [{'auth_user_id': 'user-2', 'google_sub': 'sub-2'}]
        for other in (dict(BASE), dict(BASE, owner_id='user-2'),
                      dict(BASE, type='session', tenant_id='tenant-2'),
                      dict(BASE, extra='DO-NOT-PRINT-SECRET')):
            with self.subTest(other=other):
                result = preview([BASE, other, dict(BASE, id='record-2')], mappings)
                self.assertNotEqual(result['dispositions'][0], 'candidate_only')
                self.assertNotEqual(result['dispositions'][1], 'candidate_only')
                self.assertEqual(result['dispositions'][2], 'candidate_only')
                self.assertEqual(sum(result['counts'].values()), 3)
                self.assertNotIn('DO-NOT-PRINT-SECRET', json.dumps(result))

    def test_accounting_and_reasons(self):
        rows = [BASE, dict(BASE, id='record-2', type='session'), dict(BASE, id='record-3', type='document'), dict(BASE, id='record-4', visibility='workspace', workspace_id='workspace-1'), dict(BASE, id='record-5', extra='x'), dict(BASE, id='record-6', owner_id='user-2'), None, dict(BASE, id='record-7', type='oauth_states')]
        result = preview(rows, MAP)
        self.assertEqual(result['input_count'], len(rows))
        self.assertEqual(sum(result['counts'].values()), len(rows))
        self.assertEqual(len(result['dispositions']), len(rows))
        self.assertEqual(result['dispositions'], ['candidate_only', 'candidate_only', 'document_import_unsupported', 'shared_or_ambiguous_visibility', 'invalid_or_unknown_fields', 'unmapped_or_ambiguous_identity', 'invalid_or_unknown_fields', 'unsupported_type'])

    def test_mapping_conflicts_fail_closed(self):
        for mappings in [[], MAP + MAP, MAP + [{'auth_user_id':'user-1', 'google_sub':'sub-2'}], MAP + [{'auth_user_id':'user-2', 'google_sub':'sub-1'}], MAP + [{'auth_user_id':'user-2', 'google_sub':'sub-2', 'token':'secret'}], [{'auth_user_id':'real-user', 'google_sub':'sub-1'}]]:
            with self.subTest(mappings=mappings):
                self.assertEqual(preview([BASE], mappings)['dispositions'], ['unmapped_or_ambiguous_identity'])

    def test_secrets_and_unknown_fields_not_returned(self):
        for key in ['access_token', 'refresh_token', 'ciphertext', 'verifier_ciphertext', 'unknown']:
            result = preview([dict(BASE, **{key:'DO-NOT-PRINT-SECRET'})], MAP)
            self.assertEqual(result['dispositions'], ['invalid_or_unknown_fields'])
            self.assertNotIn('DO-NOT-PRINT-SECRET', json.dumps(result))
        self.assertNotIn('DO-NOT-PRINT-SECRET', json.dumps(preview([dict(BASE, owner_id='DO-NOT-PRINT-SECRET')], MAP)))

    def test_determinism_and_immutability(self):
        rows, mappings = [copy.deepcopy(BASE)], copy.deepcopy(MAP)
        original = copy.deepcopy((rows, mappings))
        first = preview(rows, mappings)
        self.assertEqual(first, preview(rows, mappings))
        self.assertEqual((rows, mappings), original)

    def test_no_filesystem_or_network_access(self):
        with patch.object(builtins, 'open', side_effect=AssertionError('file access')), patch.object(socket, 'socket', side_effect=AssertionError('network access')):
            self.assertEqual(preview([BASE], MAP)['dispositions'], ['candidate_only'])

    def test_visibility_fail_closed(self):
        for visibility, workspace in [('private', 'workspace-1'), ('workspace', None), (None, None), ('other', None)]:
            self.assertEqual(preview([dict(BASE, visibility=visibility, workspace_id=workspace)], MAP)['dispositions'], ['shared_or_ambiguous_visibility'])

if __name__ == '__main__':
    unittest.main()
