#ifndef STEP_QUOTA_BROKER_XFS_H
#define STEP_QUOTA_BROKER_XFS_H
#include "core.h"
#include <sys/vfs.h>

struct qb_xfs;
/* Operator startup only. Copies fixed policy; retains a duplicate of root_fd.
 * No pathname acquisition, client IDs or client limits. Close broker BEFORE xfs.
 * Default build refuses ENOTSUP: privileged acceptance has NOT been completed. */
int qb_xfs_open(int root_fd, const struct qb_policy *policy,
                struct qb_xfs **out, struct qb_adapter *adapter);
void qb_xfs_close(struct qb_xfs *xfs);

#ifdef QB_XFS_TESTING
/* Explicit syscall seam, not shipped in the library. Identity/attachment and FD
 * lifetime still use real unprivileged statx/proc/fcntl calls in tests. */
struct qb_xfs_calls {
    void *context;
    int (*ioctl)(void *, int, unsigned long, void *);
    int (*quota)(void *, int, unsigned int, uint32_t, void *);
    int (*statfs)(void *, int, struct statfs *);
};
int qb_xfs_open_test(int root_fd, const struct qb_policy *policy,
                     const struct qb_xfs_calls *calls,
                     struct qb_xfs **out, struct qb_adapter *adapter);
#endif
#endif
