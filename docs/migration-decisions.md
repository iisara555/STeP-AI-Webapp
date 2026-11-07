# Migration decisions (owner-approved, 2026-11-06)

Decisions given by the project owner for #56/#63. They bind future implementation; change only with new owner approval.

1. **Identity mapping:** map Supabase users to Google identities by company email, but an administrator must review and approve the full mapping list before any import. Unreviewed, ambiguous or unmatched accounts are blocked, never guessed.
2. **Shared data:** records that are shared (workspace-visible, viewer/editor memberships) are **not** migrated, and are not converted to private copies, until the Cloud destination supports sharing. They stay in Supabase and must be reported as deferred, not dropped.
3. **Offsite backup:** ~~company Google Drive~~ (superseded 2026-11-06). The owner will physically carry a removable disk offsite instead; no cloud upload. Copies on it must be encrypted (tested `rclone crypt` drill applies to a local disk path) because a carried disk can be lost. Rotation schedule and the exact disk are still to be confirmed. `/mnt/step-backup` on the same host remains the first backup copy but is not offsite.
4. **Pilot for administrators and co-developers:** use only the synthetic-data demo until #57 isolation is complete. The production gateway stays fail-closed; no Google-login pilot and no real data in the meantime.

## Host state

- 2026-11-06: owner created system account `step-runner` (uid 995, gid 983, no home, shell `/usr/sbin/nologin`) for running workspace programs apart from the `itsara`/gateway account. It is not used by anything yet. Starting processes as this account still needs a narrowly scoped privileged launcher, to be designed, tested and separately approved. One shared account separates workloads from the gateway only; isolation between workspaces must still come from per-workspace sandboxing or per-workspace accounts.

## Disk quota model: per-user pool (owner decision, 2026-11-07)

- Each user gets **one storage pool of 15 GiB** (one XFS project per user); all of that user's Workspaces live inside it and share it, like Projects in Claude Desktop or folders in Cursor/opencode/Codex. Number of Workspaces per user is not what limits disk use.
- Capacity target: **50 users on the current 954 GB SSD** (750 GB committed, ~100 GB kept for system and backups, no overcommit, so the disk cannot fill from user data). A larger SSD is planned before growing to 300 users; pool size is revisited then.
- When a pool is full: only that user's writes fail (ENOSPC/EDQUOT); other users are unaffected; saved files stay readable, downloadable and deletable; deleting frees space at once (proven on real XFS, docs/native-quota-xfs-acceptance.md).
- Required with it: warnings at 80% and 95% of the pool; already-saved chat history must never be lost or silently stop saving when a pool is full; an operator can **raise** (never lower) one user's pool.
- Supersedes the per-Workspace limit placeholder used in the native broker docs and tests.
