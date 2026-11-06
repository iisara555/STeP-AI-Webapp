# Migration decisions (owner-approved, 2026-11-06)

Decisions given by the project owner for #56/#63. They bind future implementation; change only with new owner approval.

1. **Identity mapping:** map Supabase users to Google identities by company email, but an administrator must review and approve the full mapping list before any import. Unreviewed, ambiguous or unmatched accounts are blocked, never guessed.
2. **Shared data:** records that are shared (workspace-visible, viewer/editor memberships) are **not** migrated, and are not converted to private copies, until the Cloud destination supports sharing. They stay in Supabase and must be reported as deferred, not dropped.
3. **Offsite backup:** a copy outside this machine goes to the company's existing cloud storage. Provider name and access are still to be confirmed; `/mnt/step-backup` on the same host is not offsite.
4. **Pilot for administrators and co-developers:** use only the synthetic-data demo until #57 isolation is complete. The production gateway stays fail-closed; no Google-login pilot and no real data in the meantime.
