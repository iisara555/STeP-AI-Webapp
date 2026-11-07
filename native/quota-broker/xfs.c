#define _GNU_SOURCE
#include "xfs.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/dqblk_xfs.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/quota.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef QB_XFS_TESTING
struct qb_xfs_calls {
    void *context;
    int (*ioctl)(void *, int, unsigned long, void *);
    int (*quota)(void *, int, unsigned int, uint32_t, void *);
    int (*statfs)(void *, int, struct statfs *);
};
#endif
struct identity { uint64_t device, inode, mount; };
struct qb_xfs {
    int root;
    struct identity identity;
    struct qb_policy policy;
    struct qb_xfs_calls calls;
};
static int deny(int error) { errno = error; return -1; }
/* No pathname reopen of a target. Reading the current namespace's mount table
 * is mandatory: statx alone continues to identify a lazily detached mount. */
static int identify(int fd, struct identity *out) {
    struct stat s; struct statx x;
    if (fstat(fd, &s) < 0 || statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
                                 STATX_INO | STATX_MNT_ID, &x) < 0) return -1;
    if (!S_ISDIR(s.st_mode) || !s.st_nlink ||
        (x.stx_mask & (STATX_INO | STATX_MNT_ID)) != (STATX_INO | STATX_MNT_ID) ||
        x.stx_ino != s.st_ino) return deny(ESTALE);
    out->device = (uint64_t)s.st_dev; out->inode = s.st_ino; out->mount = x.stx_mnt_id;
    return 0;
}
static int attached(uint64_t mount) {
    FILE *f = fopen("/proc/self/mountinfo", "re");
    if (!f) return -1;
    char *line = NULL; size_t cap = 0; int found = 0;
    while (getline(&line, &cap, f) >= 0) {
        char *end; errno = 0;
        unsigned long long id = strtoull(line, &end, 10);
        if (!errno && end != line && *end == ' ' && (uint64_t)id == mount) found = 1;
    }
    int bad = ferror(f); free(line);
    if (fclose(f) != 0) bad = 1;
    if (bad) return deny(EIO);
    return found ? 0 : deny(ESTALE);
}
static int same_root(struct qb_xfs *x, int root) {
    struct identity a, b;
    if (identify(x->root, &a) < 0 || identify(root, &b) < 0) return -1;
    if (a.device != x->identity.device || a.inode != x->identity.inode ||
        a.mount != x->identity.mount || b.device != a.device ||
        b.inode != a.inode || b.mount != a.mount) return deny(ESTALE);
    return attached(a.mount);
}
static int directory(struct qb_xfs *x, int fd) {
    struct identity d;
    if (identify(fd, &d) < 0) return -1;
    if (d.device != x->identity.device || d.mount != x->identity.mount) return deny(EXDEV);
    return 0;
}
static int quota(struct qb_xfs *x, unsigned int op, uint32_t project, void *arg) {
    /* No quotactl(path), /proc/self/fd pathname trick, or ENOSYS fallback. */
    return x->calls.quota(x->calls.context, x->root, op, project, arg);
}
static int mount_check(void *v, int root, uint8_t uuid[16], int *enforced) {
    struct qb_xfs *x = v;
    memset(uuid, 0, 16); *enforced = 0;
    if (same_root(x, root) < 0) return -1;
    struct statfs fs;
    if (x->calls.statfs(x->calls.context, x->root, &fs) < 0) return -1;
    if (fs.f_type != XFS_SUPER_MAGIC || (fs.f_flags & ST_RDONLY)) return deny(EXDEV);
    struct fsuuid2 u = {0};
    if (x->calls.ioctl(x->calls.context, x->root, FS_IOC_GETFSUUID, &u) < 0) return -1;
    if (u.len != 16 || memcmp(u.uuid, x->policy.mount_uuid, 16)) return deny(EXDEV);
    struct fs_quota_statv q = { .qs_version = FS_QSTATV_VERSION1 };
    if (quota(x, QCMD(Q_XGETQSTATV, PRJQUOTA), 0, &q) < 0) return -1;
    unsigned int required = FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD;
    if (q.qs_version != FS_QSTATV_VERSION1 || (q.qs_flags & required) != required)
        return deny(EDQUOT);
    if (same_root(x, root) < 0) return -1;
    memcpy(uuid, u.uuid, 16); *enforced = 1;
    return 0;
}
static int check(struct qb_xfs *x, int root, int dir, uint32_t project) {
    if (project < x->policy.first_project || project > x->policy.last_project) return deny(EACCES);
    uint8_t uuid[16]; int enforced;
    if (mount_check(x, root, uuid, &enforced) < 0) return -1;
    return directory(x, dir);
}
static int attributes(struct qb_xfs *x, int dir, struct fsxattr *a) {
    memset(a, 0, sizeof(*a));
    if (x->calls.ioctl(x->calls.context, dir, FS_IOC_FSGETXATTR, a) < 0) return -1;
    /* Realtime data has separate accounting/limits; this backend does not
     * support it. Never pretend the ordinary block limit covers it. */
    if (a->fsx_xflags & (FS_XFLAG_REALTIME | FS_XFLAG_RTINHERIT)) return deny(ENOTSUP);
    return 0;
}
/* absent_ok: XFS reports a never-allocated or all-zero ("uninitialized") dquot
 * as ENOENT when no default limits exist (xfs_qm_scall_getquota:
 * XFS_IS_DQUOT_UNINITIALIZED / dqget(can_alloc=false)). That is exactly zero
 * limits and zero usage, so it is mapped to a blank record ONLY for that errno
 * and ONLY where blank is a legal answer. The post-write readback never
 * accepts absence. ESRCH (quota off) and every other error stay fatal. */
static int limits(struct qb_xfs *x, uint32_t project, struct fs_disk_quota *q, int absent_ok) {
    memset(q, 0, sizeof(*q));
    if (quota(x, QCMD(Q_XGETQUOTA, PRJQUOTA), project, q) < 0) {
        if (!absent_ok || errno != ENOENT) return -1;
        memset(q, 0, sizeof(*q));
        q->d_version = FS_DQUOT_VERSION; q->d_flags = FS_PROJ_QUOTA; q->d_id = project;
        return 0;
    }
    if (q->d_version != FS_DQUOT_VERSION || q->d_flags != FS_PROJ_QUOTA ||
        q->d_id != project || q->d_blk_hardlimit > UINT64_MAX / 512 ||
        q->d_blk_softlimit || q->d_ino_softlimit || q->d_rtb_hardlimit ||
        q->d_rtb_softlimit || q->d_rtbcount) return deny(EUCLEAN);
    return 0;
}
static int observe(void *v, int root, int dir, uint32_t project, struct qb_observation *out) {
    struct qb_xfs *x = v;
    memset(out, 0, sizeof(*out));
    if (check(x, root, dir, project) < 0) return -1;
    struct fsxattr a; struct fs_disk_quota q;
    if (attributes(x, dir, &a) < 0 || limits(x, project, &q, 1) < 0 ||
        check(x, root, dir, project) < 0) return -1;
    out->project = a.fsx_projid;
    out->inherit = !!(a.fsx_xflags & FS_XFLAG_PROJINHERIT);
    out->bytes_hard = q.d_blk_hardlimit * 512;
    out->inodes_hard = q.d_ino_hardlimit;
    /* Usage for reporting only (d_bcount is in 512-byte basic blocks). */
    if (q.d_bcount > UINT64_MAX / 512) return deny(EUCLEAN);
    out->bytes_used = q.d_bcount * 512;
    out->inodes_used = q.d_icount;
    return 0;
}
static int configure(void *v, int root, int dir, uint32_t project, uint64_t bytes, uint64_t inodes) {
    struct qb_xfs *x = v;
    if (bytes != x->policy.bytes_hard || inodes != x->policy.inodes_hard) return deny(EACCES);
    if (check(x, root, dir, project) < 0) return -1;
    struct fsxattr a; struct fs_disk_quota old;
    if (attributes(x, dir, &a) < 0 || limits(x, project, &old, 1) < 0) return -1;
    if (a.fsx_projid || (a.fsx_xflags & FS_XFLAG_PROJINHERIT) ||
        old.d_blk_hardlimit || old.d_ino_hardlimit || old.d_bcount || old.d_icount)
        return deny(EEXIST);
    /* Quota FIRST: do not assign a directory to an unlimited project. No
     * rollback/retry after a partial write; the core's readback denies it. */
    struct fs_disk_quota q = {
        .d_version = FS_DQUOT_VERSION, .d_flags = FS_PROJ_QUOTA,
        .d_fieldmask = FS_DQ_BHARD | FS_DQ_IHARD, .d_id = project,
        .d_blk_hardlimit = bytes / 512, .d_ino_hardlimit = inodes,
    };
    if (check(x, root, dir, project) < 0 ||
        quota(x, QCMD(Q_XSETQLIM, PRJQUOTA), project, &q) < 0) return -1;
    if (limits(x, project, &old, 0) < 0) return -1;
    if (old.d_blk_hardlimit != q.d_blk_hardlimit || old.d_ino_hardlimit != inodes) return deny(EDQUOT);
    if (check(x, root, dir, project) < 0) return -1;
    a.fsx_projid = project; a.fsx_xflags |= FS_XFLAG_PROJINHERIT;
    a.fsx_nextents = 0; memset(a.fsx_pad, 0, sizeof(a.fsx_pad));
    if (x->calls.ioctl(x->calls.context, dir, FS_IOC_FSSETXATTR, &a) < 0 || fsync(dir) < 0) return -1;
    struct qb_observation o;
    if (observe(x, root, dir, project, &o) < 0) return -1;
    if (o.project != project || !o.inherit || o.bytes_hard != bytes || o.inodes_hard != inodes)
        return deny(EDQUOT);
    return 0;
}
static int create(int root, const struct qb_policy *p, const struct qb_xfs_calls *calls,
                  struct qb_xfs **out, struct qb_adapter *adapter) {
    if (!out || !adapter) return deny(EINVAL);
    *out = NULL; memset(adapter, 0, sizeof(*adapter));
    if (!p || !calls || !calls->ioctl || !calls->quota || !calls->statfs ||
        p->first_project < 100000 || p->last_project > 199999 || p->first_project > p->last_project ||
        p->bytes_hard < 4096 || p->bytes_hard > UINT64_C(1099511627776) || p->bytes_hard % 4096 ||
        !p->inodes_hard || p->inodes_hard > 10000000) return deny(EINVAL);
    struct qb_xfs *x = calloc(1, sizeof(*x)); if (!x) return -1;
    x->root = fcntl(root, F_DUPFD_CLOEXEC, 3); x->policy = *p; x->calls = *calls;
    uint8_t uuid[16]; int enforced;
    if (x->root < 0 || identify(x->root, &x->identity) < 0) goto fail;
    if (x->identity.device != p->root_device || x->identity.inode != p->root_inode) {
        errno = ESTALE; goto fail;
    }
    if (mount_check(x, root, uuid, &enforced) < 0) goto fail;
    *adapter = (struct qb_adapter){x, mount_check, observe, configure}; *out = x;
    return 0;
fail: {
    int saved = errno; qb_xfs_close(x); return deny(saved);
}}
static int native_ioctl(void *v, int fd, unsigned long op, void *arg) {
    (void)v; return ioctl(fd, op, arg);
}
static int native_quota(void *v, int fd, unsigned int op, uint32_t id, void *arg) {
    (void)v;
#ifdef SYS_quotactl_fd
    return (int)syscall(SYS_quotactl_fd, fd, op, id, arg);
#else
    (void)fd; (void)op; (void)id; (void)arg; return deny(ENOSYS);
#endif
}
static int native_statfs(void *v, int fd, struct statfs *s) { (void)v; return fstatfs(fd, s); }
int qb_xfs_open(int root, const struct qb_policy *p, struct qb_xfs **out, struct qb_adapter *adapter) {
    const struct qb_xfs_calls calls = {NULL, native_ioctl, native_quota, native_statfs};
    /* Explicit compile-time gate; no environment/request/runtime bypass. An
     * acceptance-enabled build is NOT a declaration of production readiness. */
#if !defined(QB_XFS_PRIVILEGED_ACCEPTANCE) || QB_XFS_PRIVILEGED_ACCEPTANCE != 1
    (void)root; (void)p; (void)calls; (void)create;
    if (out) *out = NULL;
    if (adapter) memset(adapter, 0, sizeof(*adapter));
    return deny(ENOTSUP);
#else
    return create(root, p, &calls, out, adapter);
#endif
}
#ifdef QB_XFS_TESTING
int qb_xfs_open_test(int root, const struct qb_policy *p, const struct qb_xfs_calls *calls,
                     struct qb_xfs **out, struct qb_adapter *adapter) {
    return create(root, p, calls, out, adapter);
}
#endif
void qb_xfs_close(struct qb_xfs *x) {
    if (!x) return;
    if (x->root >= 0) close(x->root);
    free(x);
}
