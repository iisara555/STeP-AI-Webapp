# Encrypted offsite backup rehearsal (#62): synthetic only

Owner decision: the offsite copy goes to the company's Google Drive. `drill.sh` rehearses that path with rclone v1.75.2 `crypt`, using a **local folder in place of Google Drive** and throwaway keys. It needs a synthetic backup under `/mnt/step-backup/step-ai/synthetic-cross-user-*`.

Verified on ik-node-01: encrypted copy has no original file names or plaintext; `rclone cryptcheck` matches the source; a restore is SHA-256 identical for every file; a wrong key restores nothing; one flipped ciphertext bit is rejected (`failed to authenticate decrypted block`).

Not yet established: a real Google Drive remote (needs the owner's authorisation), key custody and recovery, scheduling, retention and failure alerts. This is also not a consistent production backup: live workspaces still lack a cross-process write fence (see #62 findings), so only synthetic data may be uploaded until that is solved.

Planned real setup: Drive scope `drive.file` (rclone sees only files it created), a dedicated folder preferably on a company Shared Drive, and an encryption passphrase held by the owner in a password manager. Losing the passphrase makes every backup unreadable; never put it in chat or in the repository.
