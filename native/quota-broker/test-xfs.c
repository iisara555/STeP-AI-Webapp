#define _GNU_SOURCE
#define QB_XFS_TESTING 1
#include "xfs.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/dqblk_xfs.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/quota.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

struct fake {
    struct fsxattr attr;
    struct fs_disk_quota dq;
    int writes, calls, fail_at, ignore_quota, ignore_attr;
    int bad_uuid, bad_version, bad_id, bad_flags, unenforced, readonly, not_xfs;
    int absent, quota_errno; /* absent: real-XFS ENOENT for an all-zero dquot */
    int quota_fd, attr_fd;
};
static int fault(struct fake *f) {
    f->calls++;
    if (f->fail_at && f->calls == f->fail_at) { errno = EIO; return -1; }
    return 0;
}
static int fake_statfs(void *v, int fd, struct statfs *s) {
    struct fake *f = v; assert(fcntl(fd, F_GETFD) >= 0);
    if (fault(f) < 0) return -1;
    memset(s, 0, sizeof(*s)); s->f_type = f->not_xfs ? 0 : XFS_SUPER_MAGIC;
    s->f_flags = f->readonly ? ST_RDONLY : 0; return 0;
}
static int fake_ioctl(void *v, int fd, unsigned long op, void *arg) {
    struct fake *f = v; assert(fcntl(fd, F_GETFD) >= 0);
    if (fault(f) < 0) return -1;
    if (op == FS_IOC_GETFSUUID) {
        struct fsuuid2 *u = arg; u->len = 16; memset(u->uuid, 1, 16);
        if (f->bad_uuid) u->len = 15;
    } else if (op == FS_IOC_FSGETXATTR) { f->attr_fd = fd; *(struct fsxattr *)arg = f->attr; }
    else if (op == FS_IOC_FSSETXATTR) {
        f->attr_fd = fd;
        if (!f->ignore_attr) f->attr = *(struct fsxattr *)arg;
        f->writes++;
    } else assert(0);
    return 0;
}
static int fake_quota(void *v, int fd, unsigned int op, uint32_t id, void *arg) {
    struct fake *f = v; assert(fcntl(fd, F_GETFD) >= 0); f->quota_fd = fd;
    if (fault(f) < 0) return -1;
    if (op == QCMD(Q_XGETQSTATV, PRJQUOTA)) {
        struct fs_quota_statv *s = arg; assert(s->qs_version == 1);
        s->qs_flags = FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD;
        if (f->unenforced) s->qs_flags = FS_QUOTA_PDQ_ACCT;
        if (f->bad_version) s->qs_version = 2;
    } else if (op == QCMD(Q_XGETQUOTA, PRJQUOTA)) {
        if (f->quota_errno) { errno = f->quota_errno; return -1; }
        if (f->absent && !f->dq.d_blk_hardlimit && !f->dq.d_ino_hardlimit &&
            !f->dq.d_bcount && !f->dq.d_icount) { errno = ENOENT; return -1; }
        *(struct fs_disk_quota *)arg = f->dq;
        struct fs_disk_quota *q = arg;
        q->d_id = id; q->d_version = 1; q->d_flags = FS_PROJ_QUOTA;
        if (f->bad_id) q->d_id = id + 1;
        if (f->bad_flags) q->d_flags = FS_USER_QUOTA;
    } else if (op == QCMD(Q_XSETQLIM, PRJQUOTA)) {
        struct fs_disk_quota *q = arg;
        assert(id == 100000 && q->d_id == id && q->d_version == 1);
        assert(q->d_flags == FS_PROJ_QUOTA);
        assert(q->d_fieldmask == (FS_DQ_BHARD | FS_DQ_IHARD));
        assert(q->d_blk_hardlimit == 8192 && q->d_ino_hardlimit == 100);
        if (!f->ignore_quota) f->dq = *q;
        f->writes++;
    } else assert(0);
    return 0;
}
static void open_fake(int fd, const struct qb_policy *p, struct fake *f,
                       struct qb_xfs **x, struct qb_adapter *a) {
    struct qb_xfs_calls calls = { f, fake_ioctl, fake_quota, fake_statfs };
    assert(qb_xfs_open_test(fd, p, &calls, x, a) == 0);
    assert(f->quota_fd != fd); /* quota always targets the retained duplicate */
    assert(fcntl(f->quota_fd, F_GETFD) & FD_CLOEXEC);
    f->calls = 0;
}
static int configure(struct qb_adapter *a, int fd, int dir) {
    return a->configure(a->context, fd, dir, 100000, 4194304, 100);
}
static void integration(int parent, struct qb_policy p) {
    const char workspace[] = "12345678-1234-1234-1234-123456789abc";
    const char frame[] = "ENSURE/1 12345678-1234-1234-1234-123456789abc\n";
    assert(mkdirat(parent, "core-root", 0700) == 0);
    assert(mkdirat(parent, "core-state", 0700) == 0);
    int root = openat(parent, "core-root", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int state = openat(parent, "core-state", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(root >= 0 && state >= 0);
    struct stat s; assert(fstat(root, &s) == 0);
    p.root_device = (uint64_t)s.st_dev; p.root_inode = s.st_ino;
    memset(p.epoch, 7, 16); p.grant_count = 1;
    p.grants[0].peer_uid = (uint32_t)geteuid();
    memcpy(p.grants[0].workspace, workspace, sizeof(workspace));
    struct fake f = {0}; struct qb_xfs *x; struct qb_adapter a;
    open_fake(root, &p, &f, &x, &a);
    assert(qb_bootstrap(state, &p) == 0);
    struct qb *b; assert(qb_open(root, state, &p, &a, &b) == 0);
    struct qb_receipt r;
    assert(qb_ensure(b, geteuid(), frame, sizeof(frame) - 1, &r) == 0);
    assert(r.directory_fd >= 0 && r.project == 100000 && f.writes == 2);
    struct stat d; assert(fstat(r.directory_fd, &d) == 0);
    assert((uint64_t)d.st_ino == r.inode && r.bytes_hard == 4194304 && r.inodes_hard == 100);
    close(r.directory_fd);
    assert(qb_ensure(b, geteuid(), frame, sizeof(frame) - 1, &r) == 0);
    close(r.directory_fd); assert(f.writes == 2);
    f.dq.d_ino_hardlimit = 99;
    assert(qb_ensure(b, geteuid(), frame, sizeof(frame) - 1, &r) < 0 && r.directory_fd == -1);
    assert(f.writes == 2); /* retry cannot repair either limit */
    f.unenforced = 1; assert(qb_revoke(b, workspace) < 0);
    f.unenforced = 0; assert(qb_revoke(b, workspace) == 0);
    qb_close(b); qb_xfs_close(x);
    assert(unlinkat(root, "p100000", AT_REMOVEDIR) == 0);
    assert(unlinkat(state, "manifest", 0) == 0 && unlinkat(state, "journal", 0) == 0);
    close(root); close(state);
    assert(unlinkat(parent, "core-root", AT_REMOVEDIR) == 0);
    assert(unlinkat(parent, "core-state", AT_REMOVEDIR) == 0);
}
int main(void) {
    if (geteuid() == 0) { fputs("refuse root\n", stderr); return 1; }
    const char *tmp = getenv("TMPDIR"); assert(tmp);
    char path[4096]; int n = snprintf(path, sizeof(path), "%s/step-xfs-XXXXXX", tmp);
    assert(n > 0 && (size_t)n < sizeof(path)); assert(mkdtemp(path));
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(fd >= 0);
    assert(mkdirat(fd, "child", 0700) == 0);
    int dir = openat(fd, "child", O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(dir >= 0);
    struct stat s; assert(fstat(fd, &s) == 0);
    struct qb_policy p = { .root_device = (uint64_t)s.st_dev, .root_inode = s.st_ino,
        .bytes_hard = 4194304, .inodes_hard = 100, .first_project = 100000, .last_project = 100001 };
    memset(p.mount_uuid, 1, 16);
    struct fake f = {0}; struct qb_xfs *x = NULL; struct qb_adapter a;
    assert(qb_xfs_open(fd, &p, &x, &a) < 0 && errno == ENOTSUP && !x && !a.configure);
    open_fake(fd, &p, &f, &x, &a);
    assert(configure(&a, fd, dir) == 0);
    int configure_calls = f.calls;
    struct qb_observation o;
    assert(a.observe(a.context, fd, dir, 100000, &o) == 0);
    assert(o.project == 100000 && o.inherit == 1 && o.bytes_hard == 4194304 && o.inodes_hard == 100);
    assert(f.writes == 2 && f.attr_fd == dir);
    int retained = f.quota_fd;
    assert(configure(&a, fd, dir) < 0 && f.writes == 2); /* no rewrite/lower/repair */
    qb_xfs_close(x); assert(fcntl(retained, F_GETFD) < 0 && errno == EBADF);

    /* Every syscall at the agreed adapter seam can fail, including after each
     * irreversible write. No failure may produce a successful configuration. */
    for (int i = 1; i <= configure_calls; i++) {
        f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a); f.fail_at = i;
        assert(configure(&a, fd, dir) < 0); assert(f.calls == i);
        qb_xfs_close(x);
    }
    for (int i = 0; i < 2; i++) {
        f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a);
        f.ignore_quota = !i; f.ignore_attr = i;
        assert(configure(&a, fd, dir) < 0);
        assert(f.writes == (i ? 2 : 1)); qb_xfs_close(x);
    }
    for (int i = 0; i < 14; i++) {
        f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a);
        switch (i) {
        case 0: f.bad_uuid = 1; break;
        case 1: f.bad_version = 1; break;
        case 2: f.unenforced = 1; break;
        case 3: f.readonly = 1; break;
        case 4: f.not_xfs = 1; break;
        case 5: f.bad_id = 1; break;
        case 6: f.bad_flags = 1; break;
        case 7: f.dq.d_blk_hardlimit = UINT64_MAX; break;
        case 8: f.dq.d_ino_softlimit = 1; break;
        case 9: f.dq.d_rtbcount = 1; break;
        case 10: f.attr.fsx_xflags = FS_XFLAG_RTINHERIT; break;
        case 11: f.dq.d_bcount = 1; break;
        case 12: f.dq.d_icount = 1; break;
        case 13: f.attr.fsx_projid = 500; break;
        default: assert(0);
        }
        assert(configure(&a, fd, dir) < 0 && f.writes == 0); qb_xfs_close(x);
    }
    /* Absent (ENOENT) quota record is blank before the write only. */
    f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a); f.absent = 1;
    assert(a.observe(a.context, fd, dir, 100000, &o) == 0 && !o.bytes_hard && !o.inodes_hard);
    assert(configure(&a, fd, dir) == 0 && f.writes == 2);
    assert(a.observe(a.context, fd, dir, 100000, &o) == 0 && o.bytes_hard == 4194304);
    qb_xfs_close(x);
    f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a); f.absent = 1; f.ignore_quota = 1;
    assert(configure(&a, fd, dir) < 0 && f.writes == 1); /* absent after set: fatal */
    qb_xfs_close(x);
    for (int i = 0; i < 2; i++) { /* quota off / other errors are never blank */
        f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a); f.quota_errno = i ? EIO : ESRCH;
        assert(a.observe(a.context, fd, dir, 100000, &o) < 0);
        assert(configure(&a, fd, dir) < 0 && f.writes == 0); qb_xfs_close(x);
    }
    f = (struct fake){0}; open_fake(fd, &p, &f, &x, &a);
    assert(a.configure(a.context, fd, dir, 99999, 4194304, 100) < 0);
    assert(a.configure(a.context, fd, dir, 100000, 4096, 100) < 0);
    assert(a.configure(a.context, fd, dir, 100000, 4194304, 99) < 0);
    assert(configure(&a, dir, dir) < 0 && f.writes == 0); /* wrong root inode */
    assert(configure(&a, fd, -1) < 0 && f.writes == 0);
    /* Rename/substitute the named target: mutation stays on retained dir FD. */
    assert(renameat(fd, "child", fd, "retained") == 0);
    assert(mkdirat(fd, "child", 0700) == 0);
    assert(configure(&a, fd, dir) == 0 && f.attr_fd == dir);
    assert(unlinkat(fd, "child", AT_REMOVEDIR) == 0);
    qb_xfs_close(x);
    close(dir); assert(unlinkat(fd, "retained", AT_REMOVEDIR) == 0);
    /* The operator's startup descriptor can close after construction. */
    int startup = dup(fd); assert(startup >= 0);
    f = (struct fake){0}; open_fake(startup, &p, &f, &x, &a);
    close(startup);
    uint8_t u[16]; int enforced = 0;
    assert(a.mount(a.context, fd, u, &enforced) == 0 && enforced == 1);
    qb_xfs_close(x);
    integration(fd, p);
    close(fd); assert(rmdir(path) == 0);
    printf("xfs syscall seam: PASS (fault injection at %d configure calls; no real XFS mutation)\n", configure_calls);
    return 0;
}
