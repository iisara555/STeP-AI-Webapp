"""Synthetic-only identity mapping proposal for administrator review. No I/O.

Owner decision: match Supabase users to Google accounts by company email, but an
administrator must approve every row before it can be used. Matching is exact after
trimming and case-folding only; no alias, dot or plus normalisation is attempted.
"""
from collections import Counter
import re

_SYNTHETIC_EMAIL = re.compile(r'[a-z0-9._-]+@example\.test')


def _synthetic(value, prefix):
    return isinstance(value, str) and re.fullmatch(prefix + r'-[0-9]+', value) is not None


def _email(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('synthetic fixtures only')
    email = value.strip().lower()
    if not _SYNTHETIC_EMAIL.fullmatch(email):
        raise ValueError('synthetic fixtures only')
    return email


def propose_mappings(users, google_accounts):
    """Return one review row per source user. Rows are never pre-approved."""
    for row in users:
        if not isinstance(row, dict) or set(row) != {'auth_user_id', 'email'} or not _synthetic(row['auth_user_id'], 'user'):
            raise ValueError('synthetic fixtures only')
    for row in google_accounts:
        if not isinstance(row, dict) or set(row) != {'google_sub', 'email'} or not _synthetic(row['google_sub'], 'sub'):
            raise ValueError('synthetic fixtures only')
    source = [(row['auth_user_id'], _email(row['email'])) for row in users]
    target = [(row['google_sub'], _email(row['email'])) for row in google_accounts]
    source_counts = Counter(email for _, email in source if email)
    target_counts = Counter(email for _, email in target if email)
    by_email = {email: sub for sub, email in target if email}
    proposals = []
    for auth_user_id, email in source:
        if email is None:
            status, sub = 'invalid', None
        elif source_counts[email] > 1 or target_counts[email] > 1:
            status, sub = 'ambiguous', None
        elif email in by_email:
            status, sub = 'matched', by_email[email]
        else:
            status, sub = 'unmatched', None
        proposals.append({'auth_user_id': auth_user_id, 'email': email, 'google_sub': sub,
                          'status': status, 'approved': False})
    return proposals


def approved_mappings(proposals):
    """Only matched rows explicitly approved with the literal True are usable."""
    return [{'auth_user_id': p['auth_user_id'], 'google_sub': p['google_sub']}
            for p in proposals
            if p.get('status') == 'matched' and p.get('approved') is True and p.get('google_sub')]
