"""Disposable schema-shaped fixture adapter; not for actual exports or migration."""
from collections import Counter
from uuid import UUID
from preview import preview

FIELDS = frozenset(('id', 'tenant_id', 'owner_id', 'workspace_id', 'visibility'))
TYPES = {'memories': 'memory', 'sessions': 'session', 'documents': 'document'}


def _id(value, prefix):
    try:
        u = UUID(value)
        if str(u) != value or not 0 < u.int <= 999999:
            return None
        return f'{prefix}-{u.int}'
    except (ValueError, TypeError, AttributeError):
        return None


def adapt(records, mappings):
    if not isinstance(records, list):
        raise TypeError('records must be a list')
    projected = []
    blocked = []
    unsupported_fields = unsupported_categories = ambiguous = 0
    for item in records:
        envelope = isinstance(item, dict)
        row = item.get('row') if envelope else None
        has_row = isinstance(row, dict)
        table = item.get('table') if envelope else None
        known = isinstance(table, str) and table in TYPES
        if envelope and 'table' in item and not known:
            unsupported_categories += 1
        if not has_row:
            projected.append({})
            blocked.append(True)
            continue
        unsupported = len(set(row) - FIELDS)
        unsupported_fields += unsupported
        workspace = row.get('workspace_id')
        owner = _id(row.get('owner_id'), 'user')
        p = {'type': TYPES.get(table, 'unknown') if isinstance(table, str) else 'unknown',
             'id': _id(row.get('id'), 'record'),
             'tenant_id': _id(row.get('tenant_id'), 'tenant'),
             'owner_id': owner,
             'visibility': row.get('visibility'),
             # Preserve non-nullness even if the workspace identifier is malformed.
             'workspace_id': _id(workspace, 'workspace') or 'invalid' if workspace is not None else None}
        projected.append(p)
        blocked.append(set(item) != {'table', 'row'} or not known or set(row) != FIELDS)
        # Isolate ownership and visibility from unrelated metadata validation,
        # duplicate IDs, unsupported categories and extra fields.
        ownership_probe = dict(p, type='memory', id='record-1', tenant_id='tenant-1',
                               owner_id=owner or 'user-0')
        reason = preview([ownership_probe], mappings)['dispositions'][0]
        if any(key in row for key in ('owner_id', 'visibility', 'workspace_id')):
            ambiguous += owner is None or reason in ('unmapped_or_ambiguous_identity',
                                                      'shared_or_ambiguous_visibility')
    result = preview(projected, mappings)
    safe_dispositions = ['adapter_blocked' if b else d
                         for b, d in zip(blocked, result['dispositions'])]
    safe_preview = {'input_count': len(records), 'dispositions': safe_dispositions,
                    'counts': dict(sorted(Counter(safe_dispositions).items()))}
    return {'input_count': len(records), 'blocked_count': sum(d != 'candidate_only' for d in safe_dispositions),
            'unsupported_field_count': unsupported_fields, 'unsupported_category_count': unsupported_categories,
            'ambiguous_ownership_count': ambiguous, 'preview': safe_preview}
