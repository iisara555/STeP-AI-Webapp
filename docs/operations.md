# Pilot operations

The pilot enforces 20 active members/tenant, one active job/member, 50 starts/day
in Bangkok time and two running jobs globally. Files are limited to 10 MiB,
25 MB/member and 800 MB/tenant, including prepared images. The free database and
egress limits are separate; monitor these in the provider dashboard.

Review growth at 70% capacity. At 85%, stop onboarding and archive with owners or
make a separate upgrade decision. Automatic capacity alerts and database-size
admission control are not implemented. No paid upgrade is configured. Free
Supabase projects can pause after inactivity.

Jobs reserve estimated cost under a tenant lock; idempotency keys and leases
prevent duplicate responses. Expired calls become interrupted and never replay
automatically. Cancellation or revoked rights blocks committing results, although
the provider may already have billed. Reconcile ambiguous reservations with Google
before releasing them manually. Never bulk-retry interrupted jobs.

Errors expose codes/request IDs, not raw provider JSON or credentials. Audit
events contain metadata only. Run events expire after 30 days; OAuth states have
short expiry. Staff control document/memory/conversation deletion. Removing a
source does not erase quotations already saved in authorized conversations. Deleting
a conversation or source erases its job inputs/results but retains content-free
accounting rows, so deletion cannot refund a provider call already billed.

## Backup and restore

Database backups do **not** include Storage objects. Before staff use, select an
approved encrypted offsite backup destination and retention. Use official CLI
exports for schema, roles and data, and an operator account for bucket objects.
Record object path/document ID/hash mappings and schema version. Preserve grant
encryption keys separately. Private grants/Vault data belong only in encrypted
operator backups, never Git, Pages, CI artifacts or public buckets.

Keep temporary exports in ignored `.exports/` (directory 0700, files 0600), encrypt
before transfer. Restore to a separate empty project first; restore data and files,
compare counts/hashes, configure Auth/callbacks and run synthetic role-isolation
checks. Verify a document, memory owner, shared workspace, draft, receipt review
and source version. Prefer reconnecting Google grants across trust boundaries.
No restore drill with live staff data has been completed in the initial setup.

## Advisory findings

Every public data table and private grant/state table has RLS. Private credential
tables intentionally have no client privileges or policies; their INFO advisory
does not require adding permissive policies. Twelve authenticated SECURITY
DEFINER RPCs are intentional, checking auth.uid()/resource access with a fixed
empty search_path. Worker, grant-reading, bootstrap, import, sandbox reservation and Vault configuration
RPCs are service-only. `configure_free_trial` is an intentional authenticated RPC
that checks active administrator membership; private sandbox accounting has RLS
and no client policies. Its INFO advisory does not justify granting client access.
Tests emulate Supabase's permissive function defaults; revoking PUBLIC alone is
insufficient because schema-level authenticated/anon defaults also exist.

Review the [SECURITY DEFINER guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
[private-table advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
and [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security)
when changing access. Organization admins manage members and aggregate usage;
infrastructure operators retain technical access and require operational controls.
