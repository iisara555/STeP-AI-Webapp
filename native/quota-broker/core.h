#ifndef STEP_QUOTA_BROKER_CORE_H
#define STEP_QUOTA_BROKER_CORE_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* Exact bounded one-shot payload, not JSON. A socket adapter MUST use kernel
 * credentials, framing/deadlines and never obtain peer_uid from this payload. */
int qb_request(const void *frame, size_t length, char workspace[37]);

#define QB_MAX_GRANTS 64
struct qb_grant {
    uint32_t peer_uid; /* trusted transport credential, never a wire field */
    char workspace[40]; /* canonical UUID + zero padding */
};
struct qb_policy {
    uint8_t epoch[16]; /* independently protected establishment witness required */
    uint8_t mount_uuid[16];
    uint64_t root_device, root_inode;
    uint64_t bytes_hard, inodes_hard;
    uint32_t first_project, last_project, grant_count;
    struct qb_grant grants[QB_MAX_GRANTS];
};
struct qb_observation {
    uint32_t project;
    uint64_t bytes_hard, inodes_hard;
    int inherit;
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
};
struct qb_receipt {
    int directory_fd; /* owned by recipient; CLOSE it. Not a launch capability. */
    uint32_t project;
    uint64_t device, inode, bytes_hard, inodes_hard;
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
#endif
