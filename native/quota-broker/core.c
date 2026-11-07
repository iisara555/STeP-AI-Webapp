#define _GNU_SOURCE
#include "core.h"
#include <errno.h>
#include <string.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <unistd.h>

static int uuid(const char *s) {
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return 0;
        } else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
    }
    return s[36] == '\0';
}
static int deny(int error) { errno = error; return -1; }
int qb_request(const void *frame, size_t length, char workspace[37]) {
    if (!frame || !workspace || length != 46) return deny(EPROTO);
    const char *s = frame;
    if (memcmp(s, "ENSURE/1 ", 9) || s[45] != '\n') return deny(EPROTO);
    char id[37];
    memcpy(id, s + 9, 36);
    id[36] = 0;
    if (!uuid(id)) return deny(EPROTO);
    memcpy(workspace, id, sizeof(id));
    return 0;
}

/* Local ABI journal version 1, never portable/importable state. No automatic
 * migration/repair. Every byte is canonicalized, including structure padding. */
struct manifest { uint64_t version; struct qb_policy policy; };
struct event {
    uint32_t version, kind, project, reserved;
    uint64_t device, inode;
    char workspace[40];
};
struct allocation { uint32_t project; uint64_t device, inode; int revoked; };
struct qb {
    int root, state, journal, poisoned;
    uint64_t mount_id;
    off_t end;
    uint32_t next;
    struct qb_policy policy;
    struct qb_adapter adapter;
    struct allocation allocations[QB_MAX_GRANTS];
    pthread_mutex_t mutex;
};

static int nonzero(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i]) return 1;
    return 0;
}
static int policy_copy(struct qb_policy *out, const struct qb_policy *p) {
    if (!p || !nonzero(p->epoch, 16) || !nonzero(p->mount_uuid, 16) ||
        !p->root_inode || !p->root_device ||
        p->bytes_hard < 4096 || p->bytes_hard > UINT64_C(1099511627776) ||
        p->bytes_hard % 4096 || !p->inodes_hard || p->inodes_hard > 10000000 ||
        p->first_project < 100000 || p->last_project > 199999 ||
        p->first_project > p->last_project || !p->grant_count || p->grant_count > QB_MAX_GRANTS)
        return deny(EINVAL);
    memset(out, 0, sizeof(*out));
    memcpy(out->epoch, p->epoch, 16);
    memcpy(out->mount_uuid, p->mount_uuid, 16);
    out->root_device = p->root_device; out->root_inode = p->root_inode;
    out->bytes_hard = p->bytes_hard; out->inodes_hard = p->inodes_hard;
    out->first_project = p->first_project; out->last_project = p->last_project;
    out->grant_count = p->grant_count;
    for (uint32_t i = 0; i < p->grant_count; i++) {
        if (!uuid(p->grants[i].workspace)) return deny(EINVAL);
        for (uint32_t j = 0; j < i; j++)
            if (!strcmp(p->grants[i].workspace, p->grants[j].workspace)) return deny(EINVAL);
        out->grants[i].peer_uid = p->grants[i].peer_uid;
        memcpy(out->grants[i].workspace, p->grants[i].workspace, 37);
    }
    return 0;
}
static int beneath(int parent, const char *name, int flags, mode_t mode) {
    struct open_how how = {
        .flags = (uint64_t)(unsigned int)(flags | O_CLOEXEC | O_NOFOLLOW),
        .mode = mode,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                   RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}
static int identity(int fd, struct stat *s, uint64_t *mount_id) {
    struct statx x;
    if (fstat(fd, s) < 0 || statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
                                 STATX_INO | STATX_MNT_ID, &x) < 0) return -1;
    if (!(x.stx_mask & STATX_MNT_ID) || !(x.stx_mask & STATX_INO) ||
        x.stx_ino != s->st_ino || !s->st_nlink) return deny(ESTALE);
    *mount_id = x.stx_mnt_id;
    return 0;
}
static int protected_fd(int fd, int directory) {
    struct stat s;
    if (fstat(fd, &s) < 0) return -1;
    if ((directory ? !S_ISDIR(s.st_mode) : !S_ISREG(s.st_mode)) ||
        s.st_uid != geteuid() || (s.st_mode & 07777) != (directory ? 0700 : 0600) ||
        (!directory && s.st_nlink != 1)) return deny(EPERM);
    return 0;
}
static int empty_dir(int fd) {
    int copy = beneath(fd, ".", O_RDONLY | O_DIRECTORY, 0);
    if (copy < 0) return -1;
    DIR *d = fdopendir(copy);
    if (!d) { close(copy); return -1; }
    struct dirent *e;
    int result = 0;
    errno = 0;
    while ((e = readdir(d))) {
        if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) { result = -1; errno = ENOTEMPTY; break; }
    }
    if (!e && errno) result = -1;
    int saved = errno;
    closedir(d); errno = saved;
    return result;
}
static int write_full(int fd, const void *buffer, size_t size, off_t offset) {
    const unsigned char *p = buffer;
    while (size) {
        ssize_t n = pwrite(fd, p, size, offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return deny(EIO);
        p += n; size -= (size_t)n; offset += n;
    }
    return 0;
}
static int read_full(int fd, void *buffer, size_t size, off_t offset) {
    unsigned char *p = buffer;
    while (size) {
        ssize_t n = pread(fd, p, size, offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return deny(EIO);
        p += n; size -= (size_t)n; offset += n;
    }
    return 0;
}
int qb_bootstrap(int state_fd, const struct qb_policy *policy) {
    struct manifest m;
    memset(&m, 0, sizeof(m)); m.version = 1;
    if (policy_copy(&m.policy, policy) < 0 || protected_fd(state_fd, 1) < 0 || empty_dir(state_fd) < 0)
        return -1;
    int fd = beneath(state_fd, "manifest", O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return -1;
    int ok = write_full(fd, &m, sizeof(m), 0);
    if (!ok) ok = fsync(fd);
    int saved = errno; close(fd); errno = saved;
    if (ok < 0) return -1; /* partial bootstrap is never auto-cleaned/reused */
    fd = beneath(state_fd, "journal", O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return -1;
    ok = fsync(fd); saved = errno; close(fd); errno = saved;
    if (ok < 0) return -1;
    return fsync(state_fd);
}
static int grant_index(struct qb *b, const char *workspace) {
    for (uint32_t i = 0; i < b->policy.grant_count; i++)
        if (!strcmp(workspace, b->policy.grants[i].workspace)) return (int)i;
    return deny(EACCES);
}
static int mount_check(struct qb *b) {
    struct stat s;
    /* A retry cannot use cached allocations after live state loss. Poison the
     * whole authority, not just the operation whose append noticed damage. */
    if (b->poisoned || protected_fd(b->journal, 0) < 0 || fstat(b->journal, &s) < 0 || s.st_size != b->end) {
        b->poisoned = 1;
        return deny(EIO);
    }
    struct statvfs v;
    uint64_t mount_id;
    if (protected_fd(b->root, 1) < 0 || protected_fd(b->state, 1) < 0 ||
        identity(b->root, &s, &mount_id) < 0 || fstatvfs(b->root, &v) < 0) return -1;
    if ((uint64_t)s.st_dev != b->policy.root_device || (uint64_t)s.st_ino != b->policy.root_inode ||
        mount_id != b->mount_id || (v.f_flag & ST_RDONLY)) return deny(ESTALE);
    uint8_t observed[16] = {0}; int enforced = 0;
    if (b->adapter.mount(b->adapter.context, b->root, observed, &enforced) < 0) return -1;
    if (memcmp(observed, b->policy.mount_uuid, 16) || enforced != 1) return deny(EXDEV);
    return 0;
}
static int replay(struct qb *b) {
    struct stat s;
    if (fstat(b->journal, &s) < 0) return -1;
    if (s.st_size < 0 || (uint64_t)s.st_size > QB_MAX_GRANTS * 3 * sizeof(struct event) ||
        s.st_size % (off_t)sizeof(struct event)) return deny(EILSEQ);
    b->next = b->policy.first_project;
    for (off_t off = 0; off < s.st_size; off += (off_t)sizeof(struct event)) {
        struct event e, canonical;
        if (read_full(b->journal, &e, sizeof(e), off) < 0 || !uuid(e.workspace)) return deny(EILSEQ);
        memset(&canonical, 0, sizeof(canonical));
        canonical.version = 1; canonical.kind = e.kind; canonical.project = e.project;
        canonical.device = e.device; canonical.inode = e.inode;
        memcpy(canonical.workspace, e.workspace, 37);
        if (memcmp(&canonical, &e, sizeof(e))) return deny(EILSEQ);
        int index = grant_index(b, e.workspace);
        if (index < 0) return deny(EILSEQ);
        struct allocation *a = &b->allocations[index];
        if (e.kind == 1) {
            if (a->project || a->revoked || e.project != b->next ||
                e.project > b->policy.last_project || e.device || e.inode) return deny(EILSEQ);
            a->project = b->next++;
        } else if (e.kind == 2) {
            if (!a->project || a->project != e.project || a->inode || a->revoked ||
                !e.inode || e.device != b->policy.root_device) return deny(EILSEQ);
            a->device = e.device; a->inode = e.inode;
        } else if (e.kind == 3) {
            if (a->revoked || e.project || e.device || e.inode) return deny(EILSEQ);
            a->revoked = 1;
        } else return deny(EILSEQ);
    }
    b->end = s.st_size;
    return 0;
}
int qb_open(int root_fd, int state_fd, const struct qb_policy *policy,
            const struct qb_adapter *adapter, struct qb **out) {
    if (!out) return deny(EINVAL);
    *out = NULL;
    struct manifest expected, actual;
    memset(&expected, 0, sizeof(expected)); expected.version = 1;
    if (policy_copy(&expected.policy, policy) < 0 || !adapter || !adapter->mount ||
        !adapter->observe || !adapter->configure) return deny(EINVAL);
    if (protected_fd(root_fd, 1) < 0 || protected_fd(state_fd, 1) < 0) return -1;
    struct qb *b = calloc(1, sizeof(*b));
    if (!b) return -1;
    b->root = b->state = b->journal = -1;
    int pe = pthread_mutex_init(&b->mutex, NULL);
    if (pe) { free(b); return deny(pe); }
    b->policy = expected.policy; b->adapter = *adapter;
    b->root = fcntl(root_fd, F_DUPFD_CLOEXEC, 3);
    b->state = fcntl(state_fd, F_DUPFD_CLOEXEC, 3);
    int fd = -1;
    struct stat s;
    if (b->root < 0 || b->state < 0 || identity(b->root, &s, &b->mount_id) < 0) goto fail;
    fd = beneath(b->state, "manifest", O_RDONLY, 0);
    if (fd < 0 || protected_fd(fd, 0) < 0 || fstat(fd, &s) < 0 ||
        s.st_size != (off_t)sizeof(actual) || read_full(fd, &actual, sizeof(actual), 0) < 0) goto fail;
    if (memcmp(&actual, &expected, sizeof(actual))) { errno = EILSEQ; goto fail; }
    close(fd); fd = -1;
    b->journal = beneath(b->state, "journal", O_RDWR, 0);
    if (b->journal < 0 || protected_fd(b->journal, 0) < 0 ||
        flock(b->journal, LOCK_EX | LOCK_NB) < 0 || fsync(b->journal) < 0 || fsync(b->state) < 0 ||
        replay(b) < 0 || mount_check(b) < 0) goto fail;
    *out = b;
    return 0;
fail: {
    int saved = errno;
    if (fd >= 0) close(fd);
    qb_close(b); errno = saved;
    return -1;
}}
void qb_close(struct qb *b) {
    if (!b) return;
    if (b->journal >= 0) close(b->journal);
    if (b->state >= 0) close(b->state);
    if (b->root >= 0) close(b->root);
    pthread_mutex_destroy(&b->mutex);
    free(b);
}
static int append(struct qb *b, uint32_t kind, int index, uint32_t project,
                  uint64_t device, uint64_t inode) {
    struct event e;
    memset(&e, 0, sizeof(e)); e.version = 1; e.kind = kind;
    e.project = project; e.device = device; e.inode = inode;
    memcpy(e.workspace, b->policy.grants[index].workspace, 37);
    struct stat s;
    if (b->poisoned || protected_fd(b->journal, 0) < 0 || fstat(b->journal, &s) < 0 ||
        s.st_size != b->end || write_full(b->journal, &e, sizeof(e), b->end) < 0 ||
        fsync(b->journal) < 0) {
        b->poisoned = 1;
        return deny(EIO); /* no mutation after uncertain durable reservation */
    }
    b->end += (off_t)sizeof(e);
    return 0;
}
static int observed(struct qb *b, int fd, uint32_t project, int fresh) {
    struct qb_observation o;
    memset(&o, 0, sizeof(o));
    if (b->adapter.observe(b->adapter.context, b->root, fd, project, &o) < 0) return -1;
    if (fresh) {
        if (o.project || o.inherit || o.bytes_hard || o.inodes_hard) return deny(EEXIST);
    } else if (o.project != project || o.inherit != 1 || o.bytes_hard != b->policy.bytes_hard ||
               o.inodes_hard != b->policy.inodes_hard) return deny(EDQUOT);
    return 0;
}
static int ensure_locked(struct qb *b, int index, struct qb_receipt *out) {
    struct allocation *a = &b->allocations[index];
    if (b->poisoned) return deny(EIO);
    if (a->revoked) return deny(EACCES);
    if (mount_check(b) < 0) return -1;
    int fresh = !a->project;
    if (fresh) {
        if (b->next > b->policy.last_project) return deny(ENOSPC);
        if (append(b, 1, index, b->next, 0, 0) < 0) return -1;
        a->project = b->next++;
    } else if (!a->inode) return deny(EOWNERDEAD); /* interrupted creation is never adopted */
    char name[16];
    int n = snprintf(name, sizeof(name), "p%u", a->project);
    if (n < 0 || (size_t)n >= sizeof(name)) return deny(EOVERFLOW);
    if (fresh && (mkdirat(b->root, name, 0700) < 0 || fsync(b->root) < 0)) return -1;
    int fd = beneath(b->root, name, O_RDONLY | O_DIRECTORY, 0);
    if (fd < 0) return -1;
    int result = -1;
    struct stat s; uint64_t mount_id;
    if (protected_fd(fd, 1) < 0 || identity(fd, &s, &mount_id) < 0) goto done;
    if (mount_id != b->mount_id || (uint64_t)s.st_dev != b->policy.root_device) {
        errno = EXDEV; goto done;
    }
    if (fresh) {
        if (empty_dir(fd) < 0 || fsync(fd) < 0 ||
            append(b, 2, index, a->project, (uint64_t)s.st_dev, (uint64_t)s.st_ino) < 0) goto done;
        a->device = (uint64_t)s.st_dev; a->inode = (uint64_t)s.st_ino;
        if (observed(b, fd, a->project, 1) < 0 || mount_check(b) < 0 ||
            b->adapter.configure(b->adapter.context, b->root, fd, a->project,
                                 b->policy.bytes_hard, b->policy.inodes_hard) < 0 || fsync(fd) < 0) goto done;
    } else if (a->device != (uint64_t)s.st_dev || a->inode != (uint64_t)s.st_ino) {
        errno = ESTALE; goto done;
    }
    if (observed(b, fd, a->project, 0) < 0 || mount_check(b) < 0) goto done;
    /* Detect accidental protected-parent substitution during an adapter call.
     * This check is NOT a launch fence; a launcher must consume the retained FD
     * while holding the same authority, never turn the receipt into a pathname. */
    int named = beneath(b->root, name, O_RDONLY | O_DIRECTORY, 0);
    if (named < 0) goto done;
    struct stat current; uint64_t current_mount;
    int same = identity(named, &current, &current_mount);
    int saved_errno = errno; close(named); errno = saved_errno;
    if (same < 0) goto done;
    if ((uint64_t)current.st_dev != a->device || (uint64_t)current.st_ino != a->inode ||
        current_mount != b->mount_id) { errno = ESTALE; goto done; }
    out->directory_fd = fd; out->project = a->project;
    out->device = a->device; out->inode = a->inode;
    out->bytes_hard = b->policy.bytes_hard; out->inodes_hard = b->policy.inodes_hard;
    result = 0;
done:
    if (result < 0) { int saved = errno; close(fd); errno = saved; }
    return result;
}
int qb_ensure(struct qb *b, uid_t peer, const void *frame, size_t length, struct qb_receipt *out) {
    if (!out) return deny(EINVAL);
    memset(out, 0, sizeof(*out)); out->directory_fd = -1;
    char workspace[37];
    if (!b || qb_request(frame, length, workspace) < 0) return deny(EPROTO);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, workspace);
    int result = -1;
    if (index >= 0) {
        if ((uint64_t)peer == b->policy.grants[index].peer_uid) result = ensure_locked(b, index, out);
        else errno = EACCES;
    }
    int saved = errno;
    pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}
int qb_revoke(struct qb *b, const char workspace[37]) {
    if (!b || !workspace || !uuid(workspace)) return deny(EINVAL);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, workspace);
    int result = -1;
    if (index >= 0) {
        struct allocation *a = &b->allocations[index];
        /* A cached deny is only acknowledged while its durable authority is
         * healthy. mount_check also permanently poisons detected journal loss. */
        if (mount_check(b) < 0) result = -1;
        else if (a->revoked) result = 0;
        else if (append(b, 3, index, 0, 0, 0) == 0) { a->revoked = 1; result = 0; }
    }
    int saved = errno;
    pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}
