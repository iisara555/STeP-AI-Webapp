#ifndef STEP_QUOTA_BROKER_POLICY_H
#define STEP_QUOTA_BROKER_POLICY_H
#include "core.h"
#include <sys/types.h>

/* Install-time service policy (one fixed root-owned file, never a request).
 * Strict line format, every line terminated by '\n':
 *   # comment            (only at the start of a line)
 *   <empty line>
 *   key=value            (no spaces, tabs, CR, NUL; lowercase keys)
 * Required exactly once: version (=1), epoch (32 lowercase hex, not all zero),
 * mount_uuid (canonical lowercase UUID, not all zero), root_device, root_inode,
 * bytes_hard, inodes_hard, first_project, last_project, gateway_uid,
 * gateway_gid, workload_uid. user=<canonical UUID> 1..QB_MAX_GRANTS times,
 * unique: one per-user quota pool (subject) per line; the gateway maps its user
 * ids to these UUIDs (the broker never sees gateway user names). Unknown/duplicate/missing keys and out-of-range values are refused.
 * The result is the core QB_LAYOUT_SHARED policy: access_gid = gateway_gid,
 * content_uid = workload_uid, every user grant's peer_uid = gateway_uid. */
#define QB_POLICY_MAX_BYTES 32768
#define QB_POLICY_MAX_LINE 128
struct qb_service_policy {
    struct qb_policy core;
    uint32_t gateway_uid, gateway_gid, workload_uid;
};
/* EINVAL on any format/range error; *line (if non-NULL) = 1-based line or 0. */
int qb_policy_parse(const char *text, size_t length, struct qb_service_policy *out,
                    unsigned int *line);
/* dir_fd: open policy directory, which must be owned by `owner` and not
 * group/other-writable. The file is opened O_NOFOLLOW beneath it and must be a
 * regular file owned by `owner`, mode exactly 0600 or 0644, one link, 1..
 * QB_POLICY_MAX_BYTES bytes. EPERM for ownership/mode, EFBIG for size. */
int qb_policy_load(int dir_fd, const char *name, uid_t owner, struct qb_service_policy *out,
                   unsigned int *line);
#endif
