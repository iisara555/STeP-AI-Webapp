# Migration decisions (owner-approved, 2026-11-06)

Decisions given by the project owner for #56/#63. They bind future implementation; change only with new owner approval.

1. **Identity mapping:** map Supabase users to Google identities by company email, but an administrator must review and approve the full mapping list before any import. Unreviewed, ambiguous or unmatched accounts are blocked, never guessed.
2. **Shared data:** records that are shared (workspace-visible, viewer/editor memberships) are **not** migrated, and are not converted to private copies, until the Cloud destination supports sharing. They stay in Supabase and must be reported as deferred, not dropped.
3. **Offsite backup:** ~~company Google Drive~~ (superseded 2026-11-06). The owner will physically carry a removable disk offsite instead; no cloud upload. Copies on it must be encrypted (tested `rclone crypt` drill applies to a local disk path) because a carried disk can be lost. Rotation schedule and the exact disk are still to be confirmed. `/mnt/step-backup` on the same host remains the first backup copy but is not offsite.
4. **Pilot for administrators and co-developers:** use only the synthetic-data demo until #57 isolation is complete. The production gateway stays fail-closed; no Google-login pilot and no real data in the meantime.

## Host state

- 2026-11-06: owner created system account `step-runner` (uid 995, gid 983, no home, shell `/usr/sbin/nologin`) for running workspace programs apart from the `itsara`/gateway account. It is not used by anything yet. Starting processes as this account still needs a narrowly scoped privileged launcher, to be designed, tested and separately approved. One shared account separates workloads from the gateway only; isolation between workspaces must still come from per-workspace sandboxing or per-workspace accounts.
