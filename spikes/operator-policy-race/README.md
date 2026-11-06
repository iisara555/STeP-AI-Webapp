# Operator invitation race: unresolved evidence

These deliberately failing, synthetic proofs exercise the existing file-backed policy. They are outside the normal test suite and are not a production fix:

```sh
node --import tsx --test spikes/operator-policy-race/repro.mjs
```

A child process overwrites a temporary operator file, without acquiring the SQLite writer lock. The first test shows an enqueue occurring after that overwrite while the lock is held. The second shows a removed admin mutating the managed policy using an earlier snapshot. Both fail on the baseline. These tests describe the *old file-authoritative interface*: if the file ceases to be live authority, they must be replaced with tests of the coordinated SQLite operator API rather than made green by treating file edits as revocations.

A safe implementation must establish one SQLite authority, explicitly validate and import the initial ceiling without automatic migration, and atomically replace it using the same writer transaction as dispatch and credential-validated admin mutation. It must check membership inside that fence, preserve admin protection and existing denials, and define empty/uninitialized and invalid replacement behavior. Test competing processes, lock ordering, crash rollback, recovery, invalid replacement, stale credentials/admins, and all existing invitation/admin tests. Operator access and database filesystem permissions need an explicit operational contract; no direct file edits may be presented as live revocation. This investigation does not implement or verify that design.
