import unittest
from adapter import adapt

class AdapterTests(unittest.TestCase):
    def test_schema_row_is_not_silently_projected(self):
        row = {'id':'00000000-0000-0000-0000-000000000001', 'tenant_id':'00000000-0000-0000-0000-000000000002', 'owner_id':'00000000-0000-0000-0000-000000000003', 'workspace_id':None, 'visibility':'private', 'title':'synthetic', 'body':'synthetic'}
        records = [{'table':'memories','row':row}, {'table':'messages','row':{}}, {'table':'memories','row':dict(row, visibility='workspace', workspace_id='00000000-0000-0000-0000-000000000004')}]
        result = adapt(records, [])
        self.assertEqual(result['input_count'], 3)
        self.assertEqual(result['blocked_count'], 3)
        self.assertEqual(result['unsupported_field_count'], 4)
        self.assertEqual(result['unsupported_category_count'], 1)
        self.assertEqual(result['ambiguous_ownership_count'], 2)
        self.assertEqual(result, adapt(records, []))
        self.assertEqual(row['title'], 'synthetic')

    def test_overlapping_issues_are_independently_accounted_without_disclosure(self):
        import json
        uid = lambda n: f'00000000-0000-0000-0000-{n:012d}'
        row = {'id': uid(1), 'tenant_id': 'SECRET-TENANT', 'owner_id': uid(3),
               'workspace_id': None, 'visibility': 'private', 'SECRET-FIELD': 'SECRET-VALUE'}
        records = [{'table': 'unknown-SECRET', 'row': row},
                   {'table': 'memories', 'row': dict(row)},
                   {'table': 'sessions', 'row': dict(row, id=uid(2), tenant_id=uid(2), visibility='workspace')},
                   {'table': 'memories', 'row': dict(row, id=uid(3)), 'extra': 'SECRET-ENVELOPE'},
                   None]
        result = adapt(records, [])
        self.assertEqual(result['unsupported_field_count'], 4)
        self.assertEqual(result['unsupported_category_count'], 1)
        self.assertEqual(result['ambiguous_ownership_count'], 4)
        self.assertEqual(len(result['preview']['dispositions']), len(records))
        self.assertEqual(sum(result['preview']['counts'].values()), len(records))
        self.assertEqual(result['blocked_count'], len(records))
        self.assertNotIn('SECRET', json.dumps(result))

    def test_unknown_or_malformed_envelope_duplicate_blocks_valid_record(self):
        uid = lambda n: f'00000000-0000-0000-0000-{n:012d}'
        row = {'id': uid(1), 'tenant_id': uid(2), 'owner_id': uid(3),
               'workspace_id': None, 'visibility': 'private'}
        mappings = [{'auth_user_id': 'user-3', 'google_sub': 'sub-3'}]
        for other in ({'table': 'unknown', 'row': row},
                      {'table': 'memories', 'row': row, 'extra': 'x'}):
            result = adapt([{'table': 'memories', 'row': row}, other], mappings)
            self.assertEqual(result['preview']['dispositions'][0], 'duplicate_record_id')
            self.assertEqual(result['blocked_count'], 2)

    def test_no_io(self):
        from unittest.mock import patch
        with patch('builtins.open', side_effect=AssertionError('I/O')), patch('socket.socket', side_effect=AssertionError('network')):
            self.assertEqual(adapt([{'table':'messages', 'row':{}}], [])['blocked_count'], 1)

if __name__ == '__main__': unittest.main()
