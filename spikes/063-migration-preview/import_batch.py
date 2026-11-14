"""Synthetic-only bridge from the #63 preview/mapping spike to the server history importer's input.

Reads one synthetic fixture (see synthetic_history.json) and emits the importer batch: administrator-approved
owner mappings and HistoryImportV1 conversations for `candidate_only` private sessions. Every other row is
counted in `held_back`, never dropped silently. No I/O besides stdin/stdout; SYNTHETIC FIXTURES ONLY.

Identity bridge (synthetic convention): Supabase auth user UUID with integer N is `user-N`; an approved
`sub-M` Google account is the gateway user id `gM` (auth.ts: userId = 'g' + Google sub).
"""
from collections import Counter
import json
import sys
from uuid import UUID

from adapter import adapt
from mapping import approved_mappings, propose_mappings

CONTENT_FIELDS = ('title', 'createdAt', 'updatedAt', 'messages')


def build_batch(fixture):
    proposals = propose_mappings(fixture['users'], fixture['google_accounts'])
    approvals = set(fixture.get('approvals', []))
    for proposal in proposals:
        # Stands in for the administrator's explicit review of each row.
        proposal['approved'] = proposal['auth_user_id'] in approvals
    mappings = approved_mappings(proposals)
    records = fixture['records']
    result = adapt(records, mappings)
    contents = fixture.get('contents', {})
    held_back = Counter()
    conversations = []
    for item, disposition in zip(records, result['preview']['dispositions']):
        if disposition != 'candidate_only':
            held_back[disposition] += 1
        elif item['table'] != 'sessions':
            held_back['not_a_conversation'] += 1
        elif not isinstance(contents.get(item['row']['id']), dict) \
                or set(contents[item['row']['id']]) != set(CONTENT_FIELDS):
            held_back['missing_content'] += 1
        else:
            content = contents[item['row']['id']]
            conversations.append({'schemaVersion': 1, 'source': 'supabase',
                                  'sourceConversationId': item['row']['id'],
                                  'sourceOwnerId': item['row']['owner_id'],
                                  **{key: content[key] for key in CONTENT_FIELDS}})
    owner_mappings = [{'sourceOwnerId': str(UUID(int=int(m['auth_user_id'].split('-')[1]))),
                       'userId': 'g' + m['google_sub'].split('-')[1]} for m in mappings]
    return {'preview': {'input_count': result['input_count'], 'counts': result['preview']['counts']},
            'mappings': owner_mappings, 'conversations': conversations,
            'held_back': dict(sorted(held_back.items()))}


if __name__ == '__main__':
    json.dump(build_batch(json.load(sys.stdin)), sys.stdout, sort_keys=True)
