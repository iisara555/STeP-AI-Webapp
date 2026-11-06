"""Synthetic-only, metadata-only disposition experiment. No I/O or destination API."""
from collections import Counter
import json
import re


def synthetic(value, prefix):
    return isinstance(value, str) and re.fullmatch(prefix + r'-[0-9]+', value) is not None

FIELDS = frozenset({'type', 'id', 'tenant_id', 'owner_id', 'visibility', 'workspace_id'})
TYPES = frozenset({'memory', 'session', 'document'})


def preview(records, mappings):
    if not isinstance(records, list):
        raise TypeError('records must be a list')
    # Mapping rows are explicit pairs, one-to-one in both directions. Any malformed
    # row invalidates the entire mapping set; values never appear in the report.
    invalid = not isinstance(mappings, list)
    pairs = []
    if not invalid:
        for row in mappings:
            if (not isinstance(row, dict) or set(row) != {'auth_user_id', 'google_sub'}
                or not synthetic(row['auth_user_id'], 'user') or not synthetic(row['google_sub'], 'sub')):
                invalid = True
                break
            pairs.append((row['auth_user_id'], row['google_sub']))
    auth_counts = Counter(a for a, _ in pairs)
    sub_counts = Counter(b for _, b in pairs)
    identities = {a for a, b in pairs if auth_counts[a] == 1 and sub_counts[b] == 1}
    # Count IDs even on malformed rows so they cannot hide a collision.
    id_counts = Counter(row['id'] for row in records
                        if isinstance(row, dict) and synthetic(row.get('id'), 'record'))
    dispositions = []
    for row in records:
        # No field contents, identifiers, mapping values or exception text are emitted.
        if not isinstance(row, dict) or set(row) != FIELDS:
            reason = 'invalid_or_unknown_fields'
        elif (row['type'] not in TYPES if isinstance(row['type'], str) else True):
            reason = 'unsupported_type'
        elif not all(synthetic(row[k], prefix) for k, prefix in (('id', 'record'), ('tenant_id', 'tenant'), ('owner_id', 'user'))):
            reason = 'invalid_metadata'
        elif id_counts[row['id']] > 1:
            reason = 'duplicate_record_id'
        elif row['visibility'] != 'private' or row['workspace_id'] is not None:
            reason = 'shared_or_ambiguous_visibility'
        elif invalid or row['owner_id'] not in identities:
            reason = 'unmapped_or_ambiguous_identity'
        elif row['type'] == 'document':
            reason = 'document_import_unsupported'
        else:
            reason = 'candidate_only'
        dispositions.append(reason)
    counts = dict(sorted(Counter(dispositions).items()))
    return {'input_count': len(dispositions), 'counts': counts, 'dispositions': dispositions}


def demo():
    base = {'type': 'memory', 'id': 'record-1', 'tenant_id': 'tenant-1',
            'owner_id': 'user-1', 'visibility': 'private', 'workspace_id': None}
    records = [base, dict(base, id='record-2', visibility='workspace', workspace_id='workspace-1'),
               dict(base, id='record-3', type='document'),
               dict(base, id='record-4', access_token='synthetic-secret')]
    print(json.dumps(preview(records, [{'auth_user_id': 'user-1', 'google_sub': 'sub-1'}]), sort_keys=True))


if __name__ == '__main__':
    demo()
