import json
import unittest
from mapping import approved_mappings, propose_mappings
from preview import preview

USERS = [{'auth_user_id': 'user-1', 'email': 'Alice@Example.test'},
         {'auth_user_id': 'user-2', 'email': 'bob@example.test'}]
GOOGLE = [{'google_sub': 'sub-1', 'email': 'alice@example.test'},
          {'google_sub': 'sub-2', 'email': 'bob@example.test'}]


class MappingTests(unittest.TestCase):
    def test_email_match_is_proposed_but_never_preapproved(self):
        proposals = propose_mappings(USERS, GOOGLE)
        self.assertEqual([p['status'] for p in proposals], ['matched', 'matched'])
        self.assertTrue(all(p['approved'] is False for p in proposals))
        # Nothing reaches the preview until an administrator approves it.
        self.assertEqual(approved_mappings(proposals), [])

    def test_only_approved_matched_rows_become_mappings(self):
        proposals = propose_mappings(USERS, GOOGLE)
        proposals[0]['approved'] = True
        self.assertEqual(approved_mappings(proposals), [{'auth_user_id': 'user-1', 'google_sub': 'sub-1'}])
        base = {'type': 'memory', 'id': 'record-1', 'tenant_id': 'tenant-1', 'owner_id': 'user-1',
                'visibility': 'private', 'workspace_id': None}
        result = preview([base, dict(base, id='record-2', owner_id='user-2')], approved_mappings(proposals))
        self.assertEqual(result['dispositions'], ['candidate_only', 'unmapped_or_ambiguous_identity'])

    def test_unmatched_ambiguous_and_invalid_are_not_approvable(self):
        users = USERS + [{'auth_user_id': 'user-3', 'email': 'carol@example.test'},
                         {'auth_user_id': 'user-4', 'email': 'dup@example.test'},
                         {'auth_user_id': 'user-5', 'email': 'DUP@example.test'},
                         {'auth_user_id': 'user-6', 'email': None}]
        google = GOOGLE + [{'google_sub': 'sub-4', 'email': 'dup@example.test'}]
        proposals = propose_mappings(users, google)
        self.assertEqual([p['status'] for p in proposals],
                         ['matched', 'matched', 'unmatched', 'ambiguous', 'ambiguous', 'invalid'])
        for p in proposals:
            p['approved'] = True  # even a careless approval cannot promote unsafe rows
        self.assertEqual([m['auth_user_id'] for m in approved_mappings(proposals)], ['user-1', 'user-2'])

    def test_duplicate_google_email_is_ambiguous(self):
        proposals = propose_mappings(USERS[:1], GOOGLE[:1] + [{'google_sub': 'sub-9', 'email': 'ALICE@example.test'}])
        self.assertEqual(proposals[0]['status'], 'ambiguous')
        self.assertIsNone(proposals[0]['google_sub'])

    def test_non_synthetic_input_is_refused(self):
        for users, google in [([{'auth_user_id': 'user-1', 'email': 'alice@real-company.com'}], GOOGLE),
                              (USERS, [{'google_sub': 'sub-1', 'email': 'alice@real-company.com'}]),
                              ([{'auth_user_id': 'real-uuid', 'email': 'alice@example.test'}], GOOGLE)]:
            with self.subTest(users=users):
                with self.assertRaisesRegex(ValueError, '^synthetic fixtures only$') as error:
                    propose_mappings(users, google)
                self.assertNotIn('real-company', str(error.exception))

    def test_approval_must_be_literal_true(self):
        proposals = propose_mappings(USERS, GOOGLE)
        proposals[0]['approved'] = 'yes'
        proposals[1]['approved'] = 1
        self.assertEqual(approved_mappings(proposals), [])

    def test_proposals_are_deterministic_json(self):
        self.assertEqual(json.dumps(propose_mappings(USERS, GOOGLE)), json.dumps(propose_mappings(USERS, GOOGLE)))


if __name__ == '__main__':
    unittest.main()
