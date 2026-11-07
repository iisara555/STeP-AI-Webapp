/* Owner-run privileged acceptance for core.c + the REAL xfs.c adapter.
 *
 * Built ONLY with -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 (make acceptance). It must be
 * run as root, from a root-owned copy, against a FRESH disposable XFS mount root
 * mounted with pquota (see acceptance/run-xfs-acceptance.sh). It refuses
 * anything that is not an empty, small XFS mount root. It never runs a shell or
 * another program. Writer checks run in a forked child that drops to the given
 * unprivileged uid/gid (equivalent to setpriv --reuid --regid --clear-groups,
 * plus no_new_privs) and only uses an inherited directory FD.
 *
 * Output: one "PASS <check>: ..." or "FAIL <check>: ..." line per check, "INFO"
 * lines for measurements that are not pass/fail gates, and a final RESULT line.
 * Exit 0 only if every check passed; 1 if any failed; 2 on refused preconditions.
 */
#define _GNU_SOURCE
#include "core.h"
#include "xfs.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <linux/dqblk_xfs.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/quota.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(QB_XFS_PRIVILEGED_ACCEPTANCE) || QB_XFS_PRIVILEGED_ACCEPTANCE != 1
#error "xfs-acceptance must be built with -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 (make acceptance)"
#endif
#ifndef SYS_quotactl_fd
#error "SYS_quotactl_fd is required"
#endif

#define MIB (UINT64_C(1) << 20)
#define BYTES_HARD (16 * MIB)
#define INODES_HARD UINT64_C(64)
#define FIRST_PROJECT 100000u
#define LAST_PROJECT 100003u /* exactly four ids: proves exhaustion, not reuse */
#define MAX_FS_BYTES (UINT64_C(1) << 30)
#define SLACK (2 * MIB)

static const char *const WS[5] = {
    "a0000000-0000-4000-8000-00000000000a", /* A: limits, inheritance, writer */
    "b0000000-0000-4000-8000-00000000000b", /* B: revoked before restart */
    "c0000000-0000-4000-8000-00000000000c", /* C: first allocation after restart */
    "d0000000-0000-4000-8000-00000000000d", /* D: last id in range */
    "e0000000-0000-4000-8000-00000000000e", /* E: range exhausted */
};
#define PEER 4242u /* authenticated transport principal; not a host account */

static int passed, failed;
static const char *mount_path;
static uid_t writer_uid;
static gid_t writer_gid;

static void out(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
    fflush(stdout);
}
static void verdict(int ok, const char *name, const char *fmt, ...) {
    char detail[512]; va_list ap; va_start(ap, fmt);
    vsnprintf(detail, sizeof(detail), fmt, ap); va_end(ap);
    if (ok) passed++; else failed++;
    out("%s %s: %s\n", ok ? "PASS" : "FAIL", name, detail);
}
static void refuse(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fputs("REFUSED: ", stdout); vprintf(fmt, ap); fputc('\n', stdout); va_end(ap);
    fflush(stdout);
    exit(2);
}
static int quotactl_fd(int fd, unsigned int cmd, uint32_t id, void *arg) {
    return (int)syscall(SYS_quotactl_fd, fd, cmd, id, arg);
}
/* Independent readback, NOT through the adapter. */
static int getq(int mnt, uint32_t project, struct fs_disk_quota *q) {
    memset(q, 0, sizeof(*q));
    return quotactl_fd(mnt, QCMD(Q_XGETQUOTA, PRJQUOTA), project, q);
}
static int getattr(int fd, struct fsxattr *a) {
    memset(a, 0, sizeof(*a));
    return ioctl(fd, FS_IOC_FSGETXATTR, a);
}
static void pause_ms(long ms) {
    struct timespec t = {ms / 1000, (ms % 1000) * 1000000L};
    while (nanosleep(&t, &t) < 0 && errno == EINTR) {}
}

/* ---------------------------------------------------------------- writer */
enum op { W_FILL_BYTES = 1, W_WRITE, W_UNLINK, W_FILL_INODES, W_UNLINK_INODES,
          W_CREATE_INODES, W_ESCAPE_USERNS, W_ESCAPE_INIT };
struct wres {
    int identity_ok, error, error2, error3;
    uint64_t count, value;
    char detail[160];
};
static int drop_to_writer(struct wres *r) {
    if (setgroups(0, NULL) < 0 || setresgid(writer_gid, writer_gid, writer_gid) < 0 ||
        setresuid(writer_uid, writer_uid, writer_uid) < 0 ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
    uid_t ru, eu, su; gid_t rg, eg, sg;
    struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct d[2];
    memset(d, 0, sizeof(d));
    if (getresuid(&ru, &eu, &su) < 0 || getresgid(&rg, &eg, &sg) < 0 ||
        syscall(SYS_capget, &h, d) < 0) return -1;
    int groups = getgroups(0, NULL);
    r->identity_ok = ru == writer_uid && eu == writer_uid && su == writer_uid &&
                     rg == writer_gid && eg == writer_gid && sg == writer_gid && groups == 0 &&
                     !d[0].effective && !d[1].effective && !d[0].permitted && !d[1].permitted;
    if (!r->identity_ok) { errno = EPERM; return -1; }
    return 0;
}
static void writer_body(int dir, enum op op, uint64_t arg, struct wres *r) {
    static char buf[1 << 20];
    memset(buf, 0x5a, sizeof(buf));
    char name[32];
    switch (op) {
    case W_FILL_BYTES: case W_WRITE: {
        int fd = openat(dir, op == W_FILL_BYTES ? "big" : "again",
                        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0) { r->error = errno; return; }
        uint64_t limit = op == W_FILL_BYTES ? UINT64_MAX : arg;
        while (r->count < limit) {
            size_t want = sizeof(buf);
            if (limit - r->count < want) want = (size_t)(limit - r->count);
            ssize_t n = write(fd, buf, want);
            if (n < 0 && errno == EINTR) continue;
            if (n < 0) { r->error = errno; break; }
            if (n == 0) { r->error = EIO; break; }
            r->count += (uint64_t)n;
            if (op == W_FILL_BYTES && r->count > BYTES_HARD + 64 * MIB) break; /* not enforced */
        }
        if (fsync(fd) < 0) r->error2 = errno;
        close(fd);
        return;
    }
    case W_UNLINK:
        if (unlinkat(dir, arg == 1 ? "big" : "again", 0) < 0) r->error = errno;
        if (syncfs(dir) < 0 && !r->error) r->error = errno;
        return;
    case W_FILL_INODES: case W_CREATE_INODES:
        for (uint64_t i = 0; i < arg; i++) {
            snprintf(name, sizeof(name), "%s%llu", op == W_FILL_INODES ? "i" : "j",
                     (unsigned long long)i);
            int fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
            if (fd < 0) { r->error = errno; return; }
            close(fd); r->count++;
        }
        return;
    case W_UNLINK_INODES:
        for (uint64_t i = 0; i < arg; i++) {
            snprintf(name, sizeof(name), "i%llu", (unsigned long long)i);
            if (unlinkat(dir, name, 0) < 0 && errno != ENOENT) { r->error = errno; return; }
        }
        for (uint64_t i = 0; i < 64; i++) {
            snprintf(name, sizeof(name), "j%llu", (unsigned long long)i);
            if (unlinkat(dir, name, 0) < 0 && errno != ENOENT) { r->error = errno; return; }
        }
        if (syncfs(dir) < 0) r->error = errno;
        return;
    case W_ESCAPE_USERNS: case W_ESCAPE_INIT: {
        int fd = openat(dir, op == W_ESCAPE_USERNS ? "esc-userns" : "esc-init",
                        O_RDONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0) { r->error = errno; snprintf(r->detail, sizeof(r->detail), "create"); return; }
        if (op == W_ESCAPE_USERNS && unshare(CLONE_NEWUSER) < 0) {
            r->error = errno; snprintf(r->detail, sizeof(r->detail), "unshare(CLONE_NEWUSER)");
            close(fd); return;
        }
        struct fsxattr a;
        /* 1: reassign own file to project 0 (escapes the hard limits). */
        if (getattr(fd, &a) < 0) { r->error = errno; close(fd); return; }
        a.fsx_projid = 0; a.fsx_nextents = 0; memset(a.fsx_pad, 0, sizeof(a.fsx_pad));
        r->error = ioctl(fd, FS_IOC_FSSETXATTR, &a) < 0 ? errno : 0;
        /* 2: clear inheritance on own writer directory. */
        struct fsxattr d;
        if (getattr(dir, &d) < 0) { r->error2 = errno; } else {
            d.fsx_xflags &= ~(unsigned int)FS_XFLAG_PROJINHERIT;
            d.fsx_nextents = 0; memset(d.fsx_pad, 0, sizeof(d.fsx_pad));
            r->error2 = ioctl(dir, FS_IOC_FSSETXATTR, &d) < 0 ? errno : 0;
        }
        /* 3: mark own empty file realtime (realtime blocks are not covered
         * by the ordinary block hard limit). */
        if (getattr(fd, &a) < 0) { r->error3 = errno; } else {
            a.fsx_xflags |= FS_XFLAG_REALTIME;
            a.fsx_nextents = 0; memset(a.fsx_pad, 0, sizeof(a.fsx_pad));
            r->error3 = ioctl(fd, FS_IOC_FSSETXATTR, &a) < 0 ? errno : 0;
        }
        close(fd);
        return;
    }
    }
}
/* Fork, drop to the writer identity, operate ONLY relative to dir_fd. */
static int as_writer(int dir_fd, enum op op, uint64_t arg, struct wres *r) {
    memset(r, 0, sizeof(*r));
    int p[2];
    if (pipe2(p, O_CLOEXEC) < 0) return -1;
    fflush(stdout);
    pid_t parent = getpid();
    pid_t pid = fork();
    if (pid < 0) { close(p[0]); close(p[1]); return -1; }
    if (pid == 0) {
        struct wres w; memset(&w, 0, sizeof(w));
        /* Keep only stdio, the target directory and the result pipe. */
        int keep_dir = fcntl(dir_fd, F_DUPFD_CLOEXEC, 100), keep_pipe = fcntl(p[1], F_DUPFD_CLOEXEC, 101);
        if (keep_dir != 100 || keep_pipe != 101) _exit(3);
        close_range(3, 99, 0); close_range(102, ~0U, 0);
        if (drop_to_writer(&w) < 0) {
            w.error = errno ? errno : EPERM;
            snprintf(w.detail, sizeof(w.detail), "privilege drop/identity check failed");
        } else {
            /* Set after the credential change (which clears it): die with the
             * harness so a stopped run never leaves a writer holding the mount. */
            if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || getppid() != parent) _exit(3);
            writer_body(keep_dir, op, arg, &w);
        }
        ssize_t n = write(keep_pipe, &w, sizeof(w));
        _exit(n == (ssize_t)sizeof(w) ? 0 : 3);
    }
    close(p[1]);
    ssize_t n;
    do n = read(p[0], r, sizeof(*r)); while (n < 0 && errno == EINTR);
    close(p[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (n != (ssize_t)sizeof(*r) || !WIFEXITED(status) || WEXITSTATUS(status)) { errno = EIO; return -1; }
    return r->identity_ok ? 0 : -1;
}
static int quota_errno(int e) { return e == EDQUOT || e == ENOSPC; }

/* ---------------------------------------------------------------- broker */
struct env {
    int mnt, broker_root, state;
    struct qb_policy policy;
    struct qb_xfs *xfs;
    struct qb *broker;
    struct qb_adapter adapter;
};
static int open_dir(int parent, const char *name) {
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}
static int broker_start(struct env *e) {
    e->xfs = NULL; e->broker = NULL;
    if (qb_xfs_open(e->broker_root, &e->policy, &e->xfs, &e->adapter) < 0) return -1;
    if (qb_open(e->broker_root, e->state, &e->policy, &e->adapter, &e->broker) < 0) {
        int saved = errno; qb_xfs_close(e->xfs); e->xfs = NULL; errno = saved; return -1;
    }
    return 0;
}
static void broker_stop(struct env *e) {
    qb_close(e->broker); e->broker = NULL; /* broker BEFORE adapter */
    qb_xfs_close(e->xfs); e->xfs = NULL;
}
static int ensure(struct env *e, int ws, struct qb_receipt *r) {
    char frame[47];
    snprintf(frame, sizeof(frame), "ENSURE/1 %s\n", WS[ws]);
    return qb_ensure(e->broker, PEER, frame, 46, r);
}
/* Wait for deferred inode inactivation to release usage after unlink. */
static int wait_usage(int mnt, uint32_t project, uint64_t max_bytes, uint64_t max_inodes,
                      struct fs_disk_quota *q) {
    for (int i = 0; i < 300; i++) {
        if (syncfs(mnt) < 0 || getq(mnt, project, q) < 0) return -1;
        if (q->d_bcount * 512 <= max_bytes && q->d_icount <= max_inodes) return 0;
        pause_ms(100);
    }
    errno = ETIMEDOUT; return -1;
}

/* ---------------------------------------------------------------- checks */
static int project_of(int dirfd, const char *name, uint32_t *project, int *inherit) {
    int fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    struct fsxattr a; int rc = getattr(fd, &a);
    int saved = errno; close(fd); errno = saved;
    if (rc < 0) return -1;
    *project = a.fsx_projid; *inherit = !!(a.fsx_xflags & FS_XFLAG_PROJINHERIT);
    return 0;
}

static void check_allocation(struct env *e, struct qb_receipt *ra) {
    const char *n = "allocation_and_limit_readback";
    struct qb_receipt again; memset(&again, 0, sizeof(again)); again.directory_fd = -1;
    if (ensure(e, 0, ra) < 0) { verdict(0, n, "qb_ensure(A): %s", strerror(errno)); return; }
    struct fs_disk_quota q; struct fsxattr a;
    int qrc = getq(e->mnt, ra->project, &q), qerr = errno;
    int arc = getattr(ra->directory_fd, &a), aerr = errno;
    int erc = ensure(e, 0, &again);
    int ok = ra->project == FIRST_PROJECT && ra->bytes_hard == BYTES_HARD &&
             ra->inodes_hard == INODES_HARD && !qrc && !arc &&
             q.d_version == FS_DQUOT_VERSION && q.d_flags == FS_PROJ_QUOTA && q.d_id == ra->project &&
             (uint64_t)q.d_blk_hardlimit * 512 == BYTES_HARD && q.d_ino_hardlimit == INODES_HARD &&
             !q.d_blk_softlimit && !q.d_ino_softlimit && !q.d_rtb_hardlimit &&
             a.fsx_projid == ra->project && (a.fsx_xflags & FS_XFLAG_PROJINHERIT) &&
             !erc && again.project == ra->project && again.inode == ra->inode;
    verdict(ok, n, "project=%u receipt=%llu B/%llu inodes; quotactl_fd readback%s blk_hard=%llu*512 "
            "ino_hard=%llu soft=%llu/%llu; dir projid=%u inherit=%d%s; re-ensure %s project=%u",
            ra->project, (unsigned long long)ra->bytes_hard, (unsigned long long)ra->inodes_hard,
            qrc ? strerror(qerr) : "", (unsigned long long)q.d_blk_hardlimit,
            (unsigned long long)q.d_ino_hardlimit, (unsigned long long)q.d_blk_softlimit,
            (unsigned long long)q.d_ino_softlimit, a.fsx_projid, !!(a.fsx_xflags & FS_XFLAG_PROJINHERIT),
            arc ? strerror(aerr) : "", erc ? strerror(errno) : "ok", again.project);
    if (again.directory_fd >= 0) close(again.directory_fd);
}
static void check_inherit(const struct qb_receipt *ra, int wdir) {
    const char *n = "new_files_and_dirs_inherit_project";
    int d = ra->directory_fd, ok = 1;
    char detail[400] = ""; size_t used = 0;
    if (mkdirat(d, "sub", 0700) < 0 && errno != EEXIST) ok = 0;
    int sub = open_dir(d, "sub");
    if (sub < 0 || mkdirat(sub, "deeper", 0700) < 0) ok = 0;
    int deeper = sub >= 0 ? open_dir(sub, "deeper") : -1;
    int f1 = openat(d, "file", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    int f2 = deeper >= 0 ? openat(deeper, "file", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600) : -1;
    if (f1 < 0 || f2 < 0) ok = 0;
    if (f1 >= 0) close(f1);
    if (f2 >= 0) close(f2);
    struct wres w; /* a file created by the unprivileged writer too */
    int wrc = as_writer(wdir, W_CREATE_INODES, 1, &w);
    if (wrc < 0 || w.error) ok = 0;
    struct { int dir; const char *name; int want_inherit; } items[] = {
        {d, "sub", 1}, {sub, "deeper", 1}, {d, "file", 0}, {deeper, "file", 0},
        {d, "w", 1}, {wdir, "j0", 0},
    };
    for (size_t i = 0; i < sizeof(items) / sizeof(items[0]); i++) {
        uint32_t p = 0; int inh = 0;
        int rc = items[i].dir >= 0 ? project_of(items[i].dir, items[i].name, &p, &inh) : -1;
        if (rc < 0 || p != ra->project || (items[i].want_inherit && !inh)) ok = 0;
        int k = snprintf(detail + used, sizeof(detail) - used, "%s%s=%u%s", i ? " " : "",
                         i == 3 ? "deeper/file" : i == 5 ? "w/j0(writer)" : items[i].name, p,
                         inh ? "+inherit" : "");
        if (k > 0 && (size_t)k < sizeof(detail) - used) used += (size_t)k;
    }
    /* Cleanup the root-made inheritance probes so later counts are exact. */
    if (deeper >= 0) { unlinkat(deeper, "file", 0); close(deeper); }
    if (sub >= 0) { unlinkat(sub, "deeper", AT_REMOVEDIR); close(sub); }
    unlinkat(d, "sub", AT_REMOVEDIR); unlinkat(d, "file", 0); unlinkat(wdir, "j0", 0);
    verdict(ok, n, "expected project %u: %s", ra->project, detail);
}
static void check_bytes(struct env *e, const struct qb_receipt *ra, int wdir) {
    const char *n = "writer_stops_at_byte_hard_limit";
    struct wres w; struct fs_disk_quota q; struct statfs fs;
    int rc = as_writer(wdir, W_FILL_BYTES, 0, &w);
    int qrc = syncfs(e->mnt) < 0 ? -1 : getq(e->mnt, ra->project, &q);
    int frc = fstatfs(e->mnt, &fs);
    uint64_t usage = qrc ? 0 : (uint64_t)q.d_bcount * 512;
    uint64_t free_bytes = frc ? 0 : (uint64_t)fs.f_bavail * (uint64_t)fs.f_bsize;
    uint32_t p = 0; int inh = 0;
    int prc = project_of(wdir, "big", &p, &inh);
    int ok = !rc && quota_errno(w.error) && w.count <= BYTES_HARD && w.count + SLACK >= BYTES_HARD &&
             !qrc && usage <= BYTES_HARD && usage + SLACK >= BYTES_HARD && !frc &&
             free_bytes > 4 * BYTES_HARD && !prc && p == ra->project;
    verdict(ok, n, "writer uid=%u gid=%u (no groups/caps)=%s wrote %llu B then errno=%s (%d), fsync=%s; "
            "project %u usage=%llu B <= hard %llu B; filesystem still has %llu B free; file projid=%u",
            (unsigned)writer_uid, (unsigned)writer_gid, w.identity_ok ? "yes" : "NO",
            (unsigned long long)w.count, strerrorname_np(w.error) ? strerrorname_np(w.error) : "none",
            w.error, w.error2 ? strerror(w.error2) : "ok", ra->project, (unsigned long long)usage,
            (unsigned long long)BYTES_HARD, (unsigned long long)free_bytes, p);
}
static void check_inodes(struct env *e, const struct qb_receipt *ra, int wdir, uint64_t settled) {
    const char *n = "writer_stops_at_inode_hard_limit";
    struct fs_disk_quota before, after; struct wres w;
    /* Wait out deferred inactivation of the earlier (deleted) files. */
    if (wait_usage(e->mnt, ra->project, MIB, settled, &before) < 0) {
        verdict(0, n, "baseline quota: %s", strerror(errno)); return;
    }
    uint64_t expected = INODES_HARD > before.d_icount ? INODES_HARD - before.d_icount : 0;
    int rc = as_writer(wdir, W_FILL_INODES, INODES_HARD + 32, &w);
    int qrc = getq(e->mnt, ra->project, &after);
    int ok = !rc && expected > 0 && quota_errno(w.error) && w.count == expected &&
             !qrc && after.d_icount == INODES_HARD;
    verdict(ok, n, "baseline icount=%llu, writer created %llu empty files (expected %llu) then errno=%s; "
            "icount now %llu, hard %llu",
            (unsigned long long)before.d_icount, (unsigned long long)w.count,
            (unsigned long long)expected, strerrorname_np(w.error) ? strerrorname_np(w.error) : "none",
            (unsigned long long)after.d_icount, (unsigned long long)INODES_HARD);
}
/* Run BEFORE the inode check: a directory growing past short form needs blocks. */
static void check_space_reuse(struct env *e, const struct qb_receipt *ra, int wdir, uint64_t settled) {
    const char *n = "space_usable_again_after_deletion";
    struct wres w1, w2, c; struct fs_disk_quota q;
    int r1 = as_writer(wdir, W_UNLINK, 1, &w1);
    int wr = wait_usage(e->mnt, ra->project, MIB, settled, &q), werr = errno;
    uint64_t usage = (uint64_t)q.d_bcount * 512;
    int r2 = as_writer(wdir, W_WRITE, BYTES_HARD / 2, &w2);
    int ok = !r1 && !w1.error && !wr && !r2 && !w2.error && !w2.error2 && w2.count == BYTES_HARD / 2;
    as_writer(wdir, W_UNLINK, 2, &c);
    if (c.error) ok = 0;
    int wr2 = wait_usage(e->mnt, ra->project, MIB, settled, &q);
    verdict(ok && !wr2, n, "writer unlinked the full file (%s); usage fell to %llu B (wait %s); writer then "
            "wrote %llu of %llu B (%s, fsync %s); cleanup %s",
            w1.error ? strerror(w1.error) : "ok", (unsigned long long)usage, wr ? strerror(werr) : "ok",
            (unsigned long long)w2.count, (unsigned long long)(BYTES_HARD / 2),
            w2.error ? strerror(w2.error) : "ok", w2.error2 ? strerror(w2.error2) : "ok",
            c.error || wr2 ? "FAILED" : "ok");
}
static void check_inode_reuse(struct env *e, const struct qb_receipt *ra, int wdir, uint64_t settled) {
    const char *n = "inodes_usable_again_after_deletion";
    struct wres w1, w2, c; struct fs_disk_quota q;
    int r1 = as_writer(wdir, W_UNLINK_INODES, INODES_HARD + 32, &w1);
    int wr = wait_usage(e->mnt, ra->project, BYTES_HARD, settled, &q), werr = errno;
    uint64_t icount = q.d_icount;
    int r2 = as_writer(wdir, W_CREATE_INODES, 8, &w2);
    int ok = !r1 && !w1.error && !wr && !r2 && !w2.error && w2.count == 8;
    as_writer(wdir, W_UNLINK_INODES, 0, &c);
    if (c.error) ok = 0;
    verdict(ok, n, "writer unlinked the files (%s); icount fell to %llu (wait %s); writer then created %llu of 8 (%s)",
            w1.error ? strerror(w1.error) : "ok", (unsigned long long)icount, wr ? strerror(werr) : "ok",
            (unsigned long long)w2.count, w2.error ? strerror(w2.error) : "ok");
}
static void check_escapes(const struct qb_receipt *ra, int wdir) {
    struct wres u, i; uint32_t p1 = 0, p2 = 0, pd = 0; int inh1 = 0, inh2 = 0, inhd = 0;
    int ru = as_writer(wdir, W_ESCAPE_USERNS, 0, &u);
    int a = project_of(wdir, "esc-userns", &p1, &inh1);
    int b = project_of(ra->directory_fd, "w", &pd, &inhd);
    int ok = !ru && u.error && u.error2 && u.error3 && !a && p1 == ra->project &&
             !b && pd == ra->project && inhd;
    verdict(ok, "workload_userns_cannot_reassign_or_clear_inherit",
            "writer in a new user namespace (bwrap --unshare-user model)%s%s: set projid 0 -> %s, "
            "clear PROJINHERIT on w -> %s, set REALTIME on file -> %s; file projid=%u, w projid=%u inherit=%d",
            u.detail[0] ? " step " : "", u.detail, u.error ? strerror(u.error) : "ALLOWED",
            u.error2 ? strerror(u.error2) : "ALLOWED", u.error3 ? strerror(u.error3) : "ALLOWED",
            p1, pd, inhd);
    /* Measurement, not a gate: the launcher must never run workloads in the
     * initial user namespace if the kernel lets a file owner reassign projects. */
    int ri = as_writer(wdir, W_ESCAPE_INIT, 0, &i);
    project_of(wdir, "esc-init", &p2, &inh2);
    b = project_of(ra->directory_fd, "w", &pd, &inhd);
    out("INFO init_userns_owner_reassignment: writer WITHOUT a user namespace%s: set projid 0 -> %s, "
        "clear PROJINHERIT -> %s, set REALTIME -> %s; file projid now %u; w projid=%u inherit=%d%s\n",
        ri ? " (writer failed)" : "", i.error ? strerror(i.error) : "ALLOWED",
        i.error2 ? strerror(i.error2) : "ALLOWED", i.error3 ? strerror(i.error3) : "ALLOWED",
        p2, pd, inhd,
        (!i.error || !i.error2) ? " => launcher MUST keep workloads in a user namespace" : "");
    /* Restore inheritance as root if the measurement cleared it; remove probes. */
    struct fsxattr d;
    int w = open_dir(ra->directory_fd, "w");
    if (w >= 0 && getattr(w, &d) == 0) {
        d.fsx_projid = ra->project; d.fsx_xflags |= FS_XFLAG_PROJINHERIT;
        d.fsx_nextents = 0; memset(d.fsx_pad, 0, sizeof(d.fsx_pad));
        ioctl(w, FS_IOC_FSSETXATTR, &d);
    }
    if (w >= 0) close(w);
    unlinkat(wdir, "esc-userns", 0); unlinkat(wdir, "esc-init", 0);
}
static void check_wrong_uuid(struct env *e) {
    const char *n = "wrong_filesystem_uuid_refused";
    struct qb_policy bad = e->policy; bad.mount_uuid[0] ^= 0x5a;
    struct qb_xfs *x = NULL; struct qb_adapter a;
    int rc = qb_xfs_open(e->broker_root, &bad, &x, &a), err = errno;
    if (!rc) qb_xfs_close(x);
    /* Core with a correct adapter but a policy naming another UUID. */
    struct qb *b = NULL; int crc = -1, cerr = 0;
    struct qb_xfs *x2 = NULL; struct qb_adapter a2;
    broker_stop(e); /* journal lock is exclusive per open */
    if (qb_xfs_open(e->broker_root, &e->policy, &x2, &a2) == 0) {
        crc = qb_open(e->broker_root, e->state, &bad, &a2, &b); cerr = errno;
        if (!crc) qb_close(b);
        qb_xfs_close(x2);
    }
    int restart = broker_start(e);
    verdict(rc < 0 && err == EXDEV && crc < 0 && !restart, n,
            "adapter open with flipped UUID -> %s; core open with mismatching policy -> %s; restart %s",
            rc < 0 ? strerrorname_np(err) : "ACCEPTED", crc < 0 ? strerrorname_np(cerr) : "ACCEPTED",
            restart ? strerror(errno) : "ok");
}
static void check_restart(struct env *e, struct qb_receipt *ra) {
    struct qb_receipt rb, rx; memset(&rx, 0, sizeof(rx)); rx.directory_fd = -1;
    int arc = ensure(e, 1, &rb);
    uint32_t b_project = arc ? 0 : rb.project;
    if (!arc) close(rb.directory_fd);
    int rv = qb_revoke(e->broker, WS[1]);
    int before = ensure(e, 1, &rx), before_err = errno;
    broker_stop(e);
    close(e->broker_root); close(e->state);
    /* Restart: reacquire everything from the filesystem, nothing from memory. */
    e->broker_root = open_dir(e->mnt, "broker");
    e->state = open_dir(e->mnt, "state");
    int st = e->broker_root < 0 || e->state < 0 ? -1 : broker_start(e), st_err = errno;
    int after = -1, after_err = 0, again = -1;
    if (!st) { after = ensure(e, 1, &rx); after_err = errno; again = qb_revoke(e->broker, WS[1]); }
    struct fs_disk_quota q; int qrc = b_project ? getq(e->mnt, b_project, &q) : -1;
    verdict(!arc && b_project == FIRST_PROJECT + 1 && !rv && before < 0 && before_err == EACCES && !st &&
            after < 0 && after_err == EACCES && !again && !qrc &&
            (uint64_t)q.d_blk_hardlimit * 512 == BYTES_HARD && q.d_ino_hardlimit == INODES_HARD,
            "revocation_survives_broker_restart",
            "B allocated project %u, revoked (%s); ensure before restart -> %s; restart %s; ensure after "
            "restart -> %s; re-revoke %s; B quota kept blk_hard=%llu*512 ino_hard=%llu",
            b_project, rv ? strerror(errno) : "ok", before < 0 ? strerrorname_np(before_err) : "ALLOWED",
            st ? strerror(st_err) : "ok", after < 0 ? strerrorname_np(after_err) : "ALLOWED",
            again ? "failed" : "ok", qrc ? 0ULL : (unsigned long long)q.d_blk_hardlimit,
            qrc ? 0ULL : (unsigned long long)q.d_ino_hardlimit);
    if (!after) close(rx.directory_fd);
    if (st) return;
    /* Receipt for A after restart: same directory and project. */
    struct qb_receipt a2;
    if (ensure(e, 0, &a2) == 0) {
        if (a2.project != ra->project || a2.inode != ra->inode) ra->project = 0;
        close(a2.directory_fd);
    } else ra->project = 0;
}
static void check_no_reuse(struct env *e, uint32_t a_project) {
    struct qb_receipt rc, rd, re; uint32_t pc = 0, pd = 0;
    int c = ensure(e, 2, &rc);
    if (!c) { pc = rc.project; close(rc.directory_fd); }
    broker_stop(e);
    int st = broker_start(e);
    int d = st ? -1 : ensure(e, 3, &rd);
    if (!d) { pd = rd.project; close(rd.directory_fd); }
    int x = st ? 0 : ensure(e, 4, &re), xerr = errno;
    if (!x && !st) close(re.directory_fd);
    verdict(a_project == FIRST_PROJECT && !c && pc == FIRST_PROJECT + 2 && !st && !d &&
            pd == FIRST_PROJECT + 3 && x < 0 && xerr == ENOSPC, "project_ids_never_reused",
            "A kept %u after restart; C (after B's revocation) -> %u; restart; D -> %u; E with range "
            "%u-%u exhausted -> %s",
            a_project, pc, pd, FIRST_PROJECT, LAST_PROJECT,
            x < 0 ? strerrorname_np(xerr) : "ALLOCATED");
}

/* Mount checks run in a forked child in a PRIVATE mount namespace so nothing
 * is mounted or detached in the owner's namespace. */
static int ns_child(struct env *e, int mode) {
    if (unshare(CLONE_NEWNS) < 0) return 10;
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) return 11;
    int mnt = open(mount_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (mnt < 0) return 12;
    struct env c = *e; c.mnt = mnt;
    c.broker_root = open_dir(mnt, "broker"); c.state = open_dir(mnt, "state");
    if (c.broker_root < 0 || c.state < 0 || broker_start(&c) < 0) return 13;
    char target[4096];
    snprintf(target, sizeof(target), "%s/broker/p%u", mount_path, FIRST_PROJECT);
    char other[4096];
    snprintf(other, sizeof(other), "%s/other", mount_path);
    struct qb_receipt r;
    if (ensure(&c, 0, &r) < 0) return 14; /* healthy before the mount */
    close(r.directory_fd);
    if (mode == 0 && mount("tmpfs", target, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=1m,mode=0700") < 0) return 15;
    if (mode == 1 && mount(other, target, NULL, MS_BIND, NULL) < 0) return 15;
    if (mode == 2 && umount2(mount_path, MNT_DETACH) < 0) return 15;
    int rc = ensure(&c, 0, &r), err = errno;
    if (!rc) { close(r.directory_fd); return 20; }
    out("       %s -> refused with %s\n", mode == 0 ? "tmpfs over broker/p<A>" :
        mode == 1 ? "same-device bind of /other over broker/p<A>" : "lazy detach of the XFS mount",
        strerrorname_np(err) ? strerrorname_np(err) : "?");
    return (mode == 2 ? err == ESTALE : err == EXDEV) ? 0 : 21;
}
static int run_ns_child(struct env *e, int mode) {
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0) _exit(9);
        _exit(ns_child(e, mode));
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return WIFEXITED(status) ? WEXITSTATUS(status) : 99;
}
static void check_mounts(struct env *e) {
    broker_stop(e); /* children open their own broker instance */
    int t = run_ns_child(e, 0), b = run_ns_child(e, 1);
    verdict(!t && !b, "nested_and_bind_mount_refused",
            "child status tmpfs=%d bind=%d (0=refused with EXDEV, 20=ACCEPTED, other=setup error)", t, b);
    int l = run_ns_child(e, 2);
    verdict(!l, "lazily_detached_mount_refused", "child status %d (0=refused with ESTALE, 20=ACCEPTED)", l);
}

/* ---------------------------------------------------------------- setup */
static void preflight(int mnt, const char *path) {
    struct statx x; struct statfs fs; struct stat s;
    if (statx(mnt, "", AT_EMPTY_PATH, STATX_BASIC_STATS | STATX_MNT_ID, &x) < 0 || fstatfs(mnt, &fs) < 0 ||
        fstat(mnt, &s) < 0)
        refuse("cannot inspect %s: %s", path, strerror(errno));
    if (!(x.stx_attributes_mask & STATX_ATTR_MOUNT_ROOT) || !(x.stx_attributes & STATX_ATTR_MOUNT_ROOT))
        refuse("%s is not a mount root", path);
    if (fs.f_type != XFS_SUPER_MAGIC) refuse("%s is not XFS", path);
    if ((uint64_t)fs.f_blocks * (uint64_t)fs.f_bsize > MAX_FS_BYTES)
        refuse("%s is larger than 1 GiB; only a disposable test image is accepted", path);
    int copy = openat(mnt, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    DIR *d = copy < 0 ? NULL : fdopendir(copy);
    if (!d) refuse("cannot list %s", path);
    struct dirent *ent; int entries = 0;
    while ((ent = readdir(d))) if (strcmp(ent->d_name, ".") && strcmp(ent->d_name, "..")) entries++;
    closedir(d);
    if (entries) refuse("%s is not a freshly made, empty filesystem", path);
    struct fs_quota_statv q = {.qs_version = FS_QSTATV_VERSION1};
    if (quotactl_fd(mnt, QCMD(Q_XGETQSTATV, PRJQUOTA), 0, &q) < 0)
        refuse("Q_XGETQSTATV on %s: %s (mounted with -o pquota?)", path, strerror(errno));
    if ((q.qs_flags & (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD)) != (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD))
        refuse("project quota accounting+enforcement not on for %s (flags 0x%x)", path, q.qs_flags);
    out("INFO filesystem: %llu MiB XFS, mount id %llu, project quota accounting+enforcement on\n",
        (unsigned long long)((uint64_t)fs.f_blocks * (uint64_t)fs.f_bsize / MIB),
        (unsigned long long)x.stx_mnt_id);
}
static unsigned long parse_id(const char *s) {
    char *end; errno = 0;
    unsigned long v = strtoul(s, &end, 10);
    if (errno || end == s || *end || v == 0 || v > 0x7fffffffUL) refuse("bad id %s", s);
    return v;
}
int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc != 7 || strcmp(argv[1], "--mount") || strcmp(argv[3], "--writer-uid") ||
        strcmp(argv[5], "--writer-gid")) {
        fprintf(stderr, "usage: %s --mount /ABS/XFS-MOUNT --writer-uid UID --writer-gid GID\n", argv[0]);
        return 2;
    }
    if (geteuid() != 0 || getuid() != 0) refuse("must run as root via the owner-run wrapper");
    mount_path = argv[2];
    writer_uid = (uid_t)parse_id(argv[4]); writer_gid = (gid_t)parse_id(argv[6]);
    if (mount_path[0] != '/' || strlen(mount_path) > 3000) refuse("mount path must be absolute");
    umask(077);
    signal(SIGPIPE, SIG_IGN);
    struct env e; memset(&e, 0, sizeof(e));
    e.mnt = open(mount_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (e.mnt < 0) refuse("open %s: %s", mount_path, strerror(errno));
    char real[4096];
    if (!realpath(mount_path, real) || strcmp(real, mount_path)) refuse("mount path must be canonical");
    preflight(e.mnt, mount_path);

    struct fsuuid2 u = {0};
    if (ioctl(e.mnt, FS_IOC_GETFSUUID, &u) < 0 || u.len != 16) refuse("FS_IOC_GETFSUUID: %s", strerror(errno));
    if (mkdirat(e.mnt, "broker", 0700) < 0 || mkdirat(e.mnt, "state", 0700) < 0 ||
        mkdirat(e.mnt, "other", 0700) < 0) refuse("setup mkdir: %s", strerror(errno));
    e.broker_root = open_dir(e.mnt, "broker"); e.state = open_dir(e.mnt, "state");
    struct stat rs;
    if (e.broker_root < 0 || e.state < 0 || fchmod(e.broker_root, 0700) < 0 || fchmod(e.state, 0700) < 0 ||
        fstat(e.broker_root, &rs) < 0) refuse("setup: %s", strerror(errno));
    struct qb_policy *p = &e.policy;
    if (getrandom(p->epoch, sizeof(p->epoch), 0) != (ssize_t)sizeof(p->epoch)) refuse("getrandom");
    p->epoch[0] |= 1;
    memcpy(p->mount_uuid, u.uuid, 16);
    p->root_device = (uint64_t)rs.st_dev; p->root_inode = (uint64_t)rs.st_ino;
    p->bytes_hard = BYTES_HARD; p->inodes_hard = INODES_HARD;
    p->first_project = FIRST_PROJECT; p->last_project = LAST_PROJECT; p->grant_count = 5;
    for (int i = 0; i < 5; i++) {
        p->grants[i].peer_uid = PEER;
        memcpy(p->grants[i].workspace, WS[i], 37);
    }
    if (qb_bootstrap(e.state, p) < 0) refuse("qb_bootstrap: %s", strerror(errno));
    if (broker_start(&e) < 0) refuse("broker start (real adapter): %s", strerror(errno));
    out("INFO broker: real core + xfs adapter open; policy %llu B / %llu inodes, projects %u-%u, writer %u:%u\n",
        (unsigned long long)BYTES_HARD, (unsigned long long)INODES_HARD, FIRST_PROJECT, LAST_PROJECT,
        (unsigned)writer_uid, (unsigned)writer_gid);

    struct qb_receipt ra; memset(&ra, 0, sizeof(ra)); ra.directory_fd = -1;
    check_allocation(&e, &ra);
    if (ra.directory_fd < 0) {
        verdict(0, "remaining_checks", "skipped: no receipt for workspace A");
    } else {
        int wdir = -1;
        if (mkdirat(ra.directory_fd, "w", 0700) == 0) {
            wdir = open_dir(ra.directory_fd, "w");
            if (wdir >= 0 && fchown(wdir, writer_uid, writer_gid) < 0) { close(wdir); wdir = -1; }
        }
        if (wdir < 0) verdict(0, "writer_directory", "%s", strerror(errno));
        else {
            check_inherit(&ra, wdir);
            struct fs_disk_quota base;
            /* Settled usage: only p<A> and w (2 inodes, short-form dirs). */
            int brc = wait_usage(e.mnt, ra.project, MIB, 2, &base);
            if (brc) out("INFO baseline did not settle: %s (icount=%llu)\n", strerror(errno),
                         (unsigned long long)base.d_icount);
            uint64_t settled = base.d_icount;
            check_bytes(&e, &ra, wdir);
            check_space_reuse(&e, &ra, wdir, settled);
            check_inodes(&e, &ra, wdir, settled);
            check_inode_reuse(&e, &ra, wdir, settled);
            check_escapes(&ra, wdir);
            close(wdir);
        }
        check_wrong_uuid(&e);
        check_restart(&e, &ra);
        if (e.broker) check_no_reuse(&e, ra.project);
        else verdict(0, "project_ids_never_reused", "skipped: broker did not restart");
        close(ra.directory_fd);
        check_mounts(&e);
    }
    broker_stop(&e);
    close(e.broker_root); close(e.state); close(e.mnt);
    out("RESULT: %s (%d passed, %d failed)\n", failed || !passed ? "FAIL" : "PASS", passed, failed);
    return failed || !passed ? 1 : 0;
}
