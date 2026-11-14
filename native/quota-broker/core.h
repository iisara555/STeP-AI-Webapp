#ifndef STEP_QUOTA_BROKER_CORE_H
#define STEP_QUOTA_BROKER_CORE_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* Exact bounded one-shot payload, not JSON. A socket adapter MUST use kernel
 * credentials, framing/deadlines and never obtain peer_uid from this payload. */
int qb_request(const void *frame, size_t length, char workspace[37]);

/* One grant = one user subject (per-user quota pool). Sized for the 300-user target. */
#define QB_MAX_GRANTS 512
struct qb_grant {
    uint32_t peer_uid; /* trusted transport credential, never a wire field */
    char workspace[40]; /* canonical subject (user) UUID + zero padding; field name kept for ABI */
};
struct qb_policy {
    uint8_t epoch[16]; /* independently protected establishment witness required */
    uint8_t mount_uuid[16];
    uint64_t root_device, root_inode;
    uint64_t bytes_hard, inodes_hard;
    uint32_t first_project, last_project, grant_count;
    struct qb_grant grants[QB_MAX_GRANTS];
    /* Directory access layout (bound into the manifest like every other field).
     * QB_LAYOUT_PRIVATE: root and every p<ID> are broker-owned 0700; access_gid,
     *   content_uid and reserved must be 0 (the privileged-acceptance model).
     * QB_LAYOUT_SHARED (per-user pool): root is broker-owned, group access_gid,
     *   mode 0710 (the access group may traverse, not list). A freshly provisioned
     *   user project directory p<ID> becomes broker-owned group access_gid 0750
     *   AFTER quota+inheritance are configured; it is never workload-writable.
     *   qb_workspace creates p<ID>/<workspace-uuid> (inherits the user's project)
     *   with files/ and snapshots/, handed to content_uid:access_gid 02750. Every
     *   later request requires exactly those owners/modes; a changed or interrupted
     *   hand-over is denied, never adopted or repaired. */
    uint32_t layout, access_gid, content_uid, reserved;
    /* Users added after bootstrap (qb_grant_add) are journal state, not policy: every added
     * user's peer_uid is added_peer_uid (the service: gateway_uid); 0 disables adding. */
    uint32_t added_peer_uid, reserved2;
    /* Capacity admission (qb_grant_add / qb_raise): sum ALL full granted hard limits
     * plus reserve_bytes <= filesystem total. A conservative additional veto requires
     * that same sum <= f_bavail * f_frsize, double-charging current user occupancy.
     * No mutable usage snapshot is credited. Reserve must cover non-user growth and
     * metadata; this is NOT a fence against external writers or physical inode use. */
    uint64_t reserve_bytes;
};
#define QB_MAX_RESERVE_BYTES (UINT64_C(1) << 50)
/* Journal events beyond the per-user ones (grant, reserve, directory, revoke): raises. */
#define QB_MAX_RAISES 4096u
#define QB_LAYOUT_PRIVATE 0u
#define QB_LAYOUT_SHARED 1u
struct qb_observation {
    uint32_t project;
    uint64_t bytes_hard, inodes_hard;
    int inherit;
    uint64_t bytes_used, inodes_used; /* the project's current usage (report only) */
};
/* Trusted native-ioctl seam. No enabled production default is shipped; the
 * optional XFS implementation has a compile-time privileged-acceptance gate.
 * All callbacks are synchronous, run under the mutation/revocation mutex and
 * must not reenter the broker. mount must verify XFS UUID, attached mount and
 * project accounting+enforcement (not just mount options). observe reads the
 * directory attributes AND the requested project's two quotas independently.
 * configure must use only retained FDs; no shell or pathname reopen. */
struct qb_adapter {
    void *context;
    int (*mount)(void *, int mount_fd, uint8_t uuid_out[16], int *enforced);
    int (*observe)(void *, int mount_fd, int dir_fd, uint32_t project,
                   struct qb_observation *out);
    int (*configure)(void *, int mount_fd, int dir_fd, uint32_t project,
                     uint64_t bytes_hard, uint64_t inodes_hard);
    /* Optional (NULL: qb_raise refuses ENOTSUP). Raise an ALREADY configured project's two
     * hard limits to exactly these values: never lower either, never touch an unconfigured
     * (zero-limit) project, set only the hard fields, then read both back. Idempotent: if
     * the limits already equal the request nothing is written. */
    int (*raise)(void *, int mount_fd, int dir_fd, uint32_t project,
                 uint64_t bytes_hard, uint64_t inodes_hard);
};
struct qb_receipt {
    int directory_fd; /* owned by recipient; CLOSE it. Not a launch capability. */
    uint32_t project;
    uint64_t device, inode, bytes_hard, inodes_hard;
    uint8_t mount_uuid[16]; /* fixed policy value the live mount was checked against */
};
struct qb;
/* Trusted operator-only APIs, not request operations. Bootstrap requires an
 * empty protected state directory, completed exclusive census and epoch.
 * open NEVER initializes/recreates state. FDs must come from protected startup,
 * not a client. Parents/ancestors must not be replaceable by callers/workloads.
 * No production roots, quotas, ranges or peer mappings are defaulted. */
int qb_bootstrap(int state_fd, const struct qb_policy *policy);
int qb_open(int root_fd, int state_fd, const struct qb_policy *policy,
            const struct qb_adapter *adapter, struct qb **out);
void qb_close(struct qb *broker); /* caller must drain threads first */
int qb_ensure(struct qb *broker, uid_t authenticated_peer_uid,
              const void *frame, size_t length, struct qb_receipt *out);
/* Durable irreversible deny; serialized with actual mutation, not an async
 * pre/post check. Only a protected operator endpoint may call this. No regrant,
 * ID reuse, quota reduction or deletion. Does not stop already-launched work. */
int qb_revoke(struct qb *broker, const char workspace[37]);

/* Per-user pool (QB_LAYOUT_SHARED only). Frame, exactly 86 bytes:
 *   "WORKSPACE/1 <user-uuid> <workspace-uuid>\n"
 * Ensures the user's project (as qb_ensure) and then the workspace directory
 * inside it. The receipt FD is the workspace directory; the caller closes it. */
struct qb_workspace_receipt {
    int directory_fd;
    uint32_t project;
    uint64_t device, user_inode, inode, bytes_hard, inodes_hard;
    uint8_t mount_uuid[16];
};
int qb_workspace(struct qb *broker, uid_t authenticated_peer_uid, const void *frame, size_t length,
                 struct qb_workspace_receipt *out);
/* Trusted in-process launch seam, NOT a wire operation or reusable authorization.
 * Identity is only a stale-preparation veto, never authority. Every call rechecks
 * the authenticated peer's live user grant, journal, mount, quota and retained
 * workspace identity under the SAME mutex as qb_revoke. Never provisions.
 * A replay while still authorized is a new launch attempt, not deduplicated;
 * after completed revoke no callback can start (also after broker restart).
 *
 * The adapter is protected host code, NEVER supplied/selected by an untrusted
 * request. It must synchronously perform the actual fixed-policy spawn before
 * returning: no async queue, FD retained/duplicated for later launches, arbitrary
 * command, argv, environment or path reopen. FD inheritance is only for the one
 * synchronously admitted fixed-policy child. The borrowed receipt expires on return.
 * Return 0 or -1 with errno; no automatic retry, even on an uncertain spawn error.
 * Must not reenter/close the broker, exit the thread, or allow cancellation while
 * inside this call. Caller drains/joins every user before qb_close. A slow
 * callback blocks all mutations/revocations; no timeout can cancel a spawn.
 * This core contract alone does NOT connect or secure a production launcher. */
struct qb_launch_identity { uint64_t device, user_inode, inode; };
struct qb_spawn_adapter {
    void *context;
    int (*spawn)(void *, const struct qb_workspace_receipt *borrowed);
};
int qb_launch_workspace(struct qb *broker, uid_t authenticated_peer_uid,
                        const char *user, const char *workspace,
                        const struct qb_launch_identity *expected,
                        const struct qb_spawn_adapter *adapter);

/* Read-only usage report of an ALREADY allocated user project. Frame, 45 bytes:
 *   "USAGE/1 <user-uuid>\n"   Never allocates; ENOENT if not allocated yet. */
struct qb_usage {
    uint32_t project;
    uint64_t bytes_used, bytes_hard, inodes_used, inodes_hard;
};
int qb_usage(struct qb *broker, uid_t authenticated_peer_uid, const void *frame, size_t length,
             struct qb_usage *out);

/* ---- Operator-only pool operations. NOT request operations: the transport has no frame
 * for them; only the root operator command (broker-main --add-user / --raise-user, which
 * needs the exclusive journal lock, i.e. the service stopped) calls them. ---- */
struct qb_capacity {
    uint64_t available;  /* free bytes of the filesystem (f_bavail * f_frsize of the root) */
    uint64_t reserve;    /* policy reserve_bytes */
    uint64_t committed;  /* sum of FULL durable hard limits AFTER operation, revoked included */
    uint32_t users;      /* grants counted (policy + journal, revoked included) */
};
/* Append a durable user grant (journal event) with a fresh, never reused project id taken
 * from the policy range. EINVAL: not a canonical UUID; EEXIST: already a user (policy or
 * journal, revoked included: no regrant); EPERM: policy added_peer_uid is 0; ENOSPC: id
 * range or QB_MAX_GRANTS exhausted; EFBIG: no-overcommit check failed. Nothing is written
 * on any refusal. The pool directory itself is still created by the first ENSURE. */
int qb_grant_add(struct qb *broker, const char *user, uint32_t *project,
                 struct qb_capacity *capacity);
/* Raise one ALLOCATED user's pool. Both limits may only increase (EINVAL otherwise, nothing
 * written); same bounds as the policy. Order: no-overcommit check (EFBIG), durable journal
 * record, adapter raise (Q_XSETQLIM), independent readback. If anything after the record
 * fails, the journal value stands and every request for that user is denied (EDQUOT) until
 * the operator repeats the same raise, which then only applies + reads back (no new record).
 * Repeating an already applied raise succeeds without writing. ENOENT: not allocated yet;
 * EACCES: revoked; ENOSPC: QB_MAX_RAISES reached; ENOTSUP: adapter without raise. */
int qb_raise(struct qb *broker, const char *user, uint64_t bytes_hard, uint64_t inodes_hard,
             struct qb_capacity *capacity);
#endif
