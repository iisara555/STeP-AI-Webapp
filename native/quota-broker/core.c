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

/* Local ABI journal version 2, never portable/importable state. No automatic
 * migration/repair. Every byte is canonicalized, including structure padding.
 * Event kinds (one fixed-size record each):
 *   1 RESERVE    project = id about to get its directory; device = inode = 0
 *   2 DIRECTORY  project; device/inode of the created p<ID>
 *   3 REVOKE     project = device = inode = 0
 *   4 GRANT      operator-added user; project = its fresh id (next in range); device = inode = 0
 *   5 RAISE      project; device = new bytes_hard, inode = new inodes_hard (both >= previous) */
#define QB_MANIFEST_VERSION 2
#define QB_MAX_EVENTS ((uint64_t)QB_MAX_GRANTS * 4 + QB_MAX_RAISES)
struct manifest { uint64_t version; struct qb_policy policy; };
struct event {
    uint32_t version, kind, project, reserved;
    uint64_t device, inode;
    char workspace[40];
};
struct allocation {
    uint32_t project, granted; /* granted: id reserved by a GRANT event (0 for policy users) */
    uint64_t device, inode;
    uint64_t bytes_hard, inodes_hard; /* current (journal) limits of this user's pool */
    int revoked;
};
struct qb {
    int root, state, journal, poisoned;
    uint64_t mount_id;
    off_t end;
    uint32_t next, raises;
    struct qb_policy policy; /* grants[] = policy users, then journal (GRANT) users */
    struct qb_adapter adapter;
    struct allocation allocations[QB_MAX_GRANTS];
    pthread_mutex_t mutex;
};

static int nonzero(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i]) return 1;
    return 0;
}
static int limits_ok(uint64_t bytes, uint64_t inodes) {
    return bytes >= 4096 && bytes <= UINT64_C(1099511627776) && !(bytes % 4096) &&
           inodes && inodes <= 10000000;
}
static int policy_copy(struct qb_policy *out, const struct qb_policy *p) {
    if (!p || !nonzero(p->epoch, 16) || !nonzero(p->mount_uuid, 16) ||
        !p->root_inode || !p->root_device || !limits_ok(p->bytes_hard, p->inodes_hard) ||
        p->first_project < 100000 || p->last_project > 199999 ||
        p->first_project > p->last_project || p->grant_count > QB_MAX_GRANTS ||
        p->reserved || p->reserved2 || p->reserve_bytes > QB_MAX_RESERVE_BYTES ||
        (p->layout != QB_LAYOUT_PRIVATE && p->layout != QB_LAYOUT_SHARED) ||
        (p->layout == QB_LAYOUT_PRIVATE && (p->access_gid || p->content_uid)) ||
        (p->layout == QB_LAYOUT_SHARED && (!p->access_gid || !p->content_uid ||
                                           p->access_gid == UINT32_MAX || p->content_uid == UINT32_MAX)))
        return deny(EINVAL);
    memset(out, 0, sizeof(*out));
    memcpy(out->epoch, p->epoch, 16);
    memcpy(out->mount_uuid, p->mount_uuid, 16);
    out->root_device = p->root_device; out->root_inode = p->root_inode;
    out->bytes_hard = p->bytes_hard; out->inodes_hard = p->inodes_hard;
    out->first_project = p->first_project; out->last_project = p->last_project;
    out->grant_count = p->grant_count;
    out->layout = p->layout; out->access_gid = p->access_gid; out->content_uid = p->content_uid;
    out->added_peer_uid = p->added_peer_uid; out->reserve_bytes = p->reserve_bytes;
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
/* Layout-aware protection of the root and of a provisioned p<ID>. */
static int protected_root(const struct qb_policy *p, int fd) {
    if (p->layout == QB_LAYOUT_PRIVATE) return protected_fd(fd, 1);
    struct stat s;
    if (fstat(fd, &s) < 0) return -1;
    if (!S_ISDIR(s.st_mode) || s.st_uid != geteuid() || (uint64_t)s.st_gid != p->access_gid ||
        (s.st_mode & 07777) != 0710) return deny(EPERM);
    return 0;
}
/* Exact owner/group/mode of a handed-over directory. */
static int exact(int fd, uint64_t uid, uint64_t gid, mode_t mode) {
    struct stat s;
    if (fstat(fd, &s) < 0) return -1;
    if (!S_ISDIR(s.st_mode) || (uint64_t)s.st_uid != uid || (uint64_t)s.st_gid != gid ||
        (s.st_mode & 07777) != mode) return deny(EPERM);
    return 0;
}
/* Shared layout: the user project directory stays broker-owned, readable by the access group. */
static int user_dir_ok(const struct qb_policy *p, int fd) {
    return exact(fd, (uint64_t)geteuid(), p->access_gid, 0750);
}
/* Shared layout: a workspace directory (and its two children) belongs to the workload. */
static int workspace_dir_ok(const struct qb_policy *p, int fd) {
    return exact(fd, p->content_uid, p->access_gid, 02750);
}
static int project_dir(const struct qb_policy *p, int fd, int fresh) {
    return p->layout == QB_LAYOUT_PRIVATE || fresh ? protected_fd(fd, 1) : user_dir_ok(p, fd);
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
    memset(&m, 0, sizeof(m)); m.version = QB_MANIFEST_VERSION;
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
/* Journal user (GRANT): appended to the in-memory user set with its reserved id. */
static void add_grant(struct qb *b, const char *user, uint32_t project) {
    uint32_t i = b->policy.grant_count++;
    memset(&b->policy.grants[i], 0, sizeof(b->policy.grants[i]));
    b->policy.grants[i].peer_uid = b->policy.added_peer_uid;
    memcpy(b->policy.grants[i].workspace, user, 37);
    struct allocation *a = &b->allocations[i];
    memset(a, 0, sizeof(*a));
    a->granted = project;
    a->bytes_hard = b->policy.bytes_hard; a->inodes_hard = b->policy.inodes_hard;
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
    if (protected_root(&b->policy, b->root) < 0 || protected_fd(b->state, 1) < 0 ||
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
    if (s.st_size < 0 || (uint64_t)s.st_size > QB_MAX_EVENTS * sizeof(struct event) ||
        s.st_size % (off_t)sizeof(struct event)) return deny(EILSEQ);
    b->next = b->policy.first_project;
    for (uint32_t i = 0; i < b->policy.grant_count; i++) {
        b->allocations[i].bytes_hard = b->policy.bytes_hard;
        b->allocations[i].inodes_hard = b->policy.inodes_hard;
    }
    for (off_t off = 0; off < s.st_size; off += (off_t)sizeof(struct event)) {
        struct event e, canonical;
        if (read_full(b->journal, &e, sizeof(e), off) < 0 || !uuid(e.workspace)) return deny(EILSEQ);
        memset(&canonical, 0, sizeof(canonical));
        canonical.version = 1; canonical.kind = e.kind; canonical.project = e.project;
        canonical.device = e.device; canonical.inode = e.inode;
        memcpy(canonical.workspace, e.workspace, 37);
        if (memcmp(&canonical, &e, sizeof(e))) return deny(EILSEQ);
        if (e.kind == 4) { /* GRANT: a new user, never one already known, with the next id */
            if (grant_index(b, e.workspace) >= 0 || !b->policy.added_peer_uid ||
                b->policy.grant_count >= QB_MAX_GRANTS || e.project != b->next ||
                e.project > b->policy.last_project || e.device || e.inode) return deny(EILSEQ);
            add_grant(b, e.workspace, b->next++);
            continue;
        }
        int index = grant_index(b, e.workspace);
        if (index < 0) return deny(EILSEQ);
        struct allocation *a = &b->allocations[index];
        if (e.kind == 1) {
            if (a->project || a->revoked || e.device || e.inode) return deny(EILSEQ);
            if (a->granted) {
                if (e.project != a->granted) return deny(EILSEQ);
            } else {
                if (e.project != b->next || e.project > b->policy.last_project) return deny(EILSEQ);
                b->next++;
            }
            a->project = e.project;
        } else if (e.kind == 2) {
            if (!a->project || a->project != e.project || a->inode || a->revoked ||
                !e.inode || e.device != b->policy.root_device) return deny(EILSEQ);
            a->device = e.device; a->inode = e.inode;
        } else if (e.kind == 3) {
            if (a->revoked || e.project || e.device || e.inode) return deny(EILSEQ);
            a->revoked = 1;
        } else if (e.kind == 5) { /* RAISE: only an allocated, unrevoked pool, only upwards */
            if (!a->inode || a->revoked || e.project != a->project || !limits_ok(e.device, e.inode) ||
                e.device < a->bytes_hard || e.inode < a->inodes_hard ||
                (e.device == a->bytes_hard && e.inode == a->inodes_hard) ||
                b->raises >= QB_MAX_RAISES) return deny(EILSEQ);
            a->bytes_hard = e.device; a->inodes_hard = e.inode; b->raises++;
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
    memset(&expected, 0, sizeof(expected)); expected.version = QB_MANIFEST_VERSION;
    if (policy_copy(&expected.policy, policy) < 0 || !adapter || !adapter->mount ||
        !adapter->observe || !adapter->configure) return deny(EINVAL);
    if (protected_root(&expected.policy, root_fd) < 0 || protected_fd(state_fd, 1) < 0) return -1;
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
static int append_for(struct qb *b, uint32_t kind, const char *user, uint32_t project,
                      uint64_t device, uint64_t inode) {
    struct event e;
    memset(&e, 0, sizeof(e)); e.version = 1; e.kind = kind;
    e.project = project; e.device = device; e.inode = inode;
    memcpy(e.workspace, user, 37);
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
static int append(struct qb *b, uint32_t kind, int index, uint32_t project,
                  uint64_t device, uint64_t inode) {
    return append_for(b, kind, b->policy.grants[index].workspace, project, device, inode);
}
/* fresh: must be blank. Otherwise must carry exactly this user's project, inheritance and
 * CURRENT (journal) limits; a raise recorded but not yet applied is denied (EDQUOT). */
static int observed(struct qb *b, int fd, const struct allocation *a, uint32_t project, int fresh) {
    struct qb_observation o;
    memset(&o, 0, sizeof(o));
    if (b->adapter.observe(b->adapter.context, b->root, fd, project, &o) < 0) return -1;
    if (fresh) {
        if (o.project || o.inherit || o.bytes_hard || o.inodes_hard) return deny(EEXIST);
    } else if (o.project != project || o.inherit != 1 || o.bytes_hard != a->bytes_hard ||
               o.inodes_hard != a->inodes_hard) return deny(EDQUOT);
    return 0;
}
/* Shared layout only, fresh provisioning only: p<ID> is still broker-owned 0700 and
 * already carries project+inheritance. Group first, then mode, then read back. A
 * failure part-way leaves a directory that project_dir() denies for ever. */
static int hand_over_user(struct qb *b, int fd) {
    if (fsync(fd) < 0 || fchown(fd, geteuid(), (gid_t)b->policy.access_gid) < 0 ||
        fchmod(fd, 0750) < 0 || fsync(fd) < 0 || user_dir_ok(&b->policy, fd) < 0) return -1;
    return 0;
}
/* A fresh workspace directory (broker-owned 0700, empty, inside the user's project):
 * children first, then owner/group (CAP_CHOWN), then mode 02750 (the broker is no longer
 * owner/in the group: CAP_FOWNER+CAP_FSETID), then read back. */
static int hand_over_workspace(struct qb *b, int fd) {
    static const char *const children[] = {"files", "snapshots"};
    for (size_t i = 0; i < sizeof(children) / sizeof(children[0]); i++) {
        if (mkdirat(fd, children[i], 0700) < 0) return -1;
        int child = beneath(fd, children[i], O_RDONLY | O_DIRECTORY, 0);
        if (child < 0) return -1;
        int ok = fchown(child, (uid_t)b->policy.content_uid, (gid_t)b->policy.access_gid);
        if (!ok) ok = fchmod(child, 02750);
        if (!ok) ok = fsync(child);
        if (!ok) ok = workspace_dir_ok(&b->policy, child);
        int saved = errno; close(child); errno = saved;
        if (ok < 0) return -1;
    }
    if (fsync(fd) < 0 || fchown(fd, (uid_t)b->policy.content_uid, (gid_t)b->policy.access_gid) < 0 ||
        fchmod(fd, 02750) < 0 || fsync(fd) < 0 || workspace_dir_ok(&b->policy, fd) < 0) return -1;
    return 0;
}
static int ensure_locked(struct qb *b, int index, struct qb_receipt *out) {
    struct allocation *a = &b->allocations[index];
    if (b->poisoned) return deny(EIO);
    if (a->revoked) return deny(EACCES);
    if (mount_check(b) < 0) return -1;
    int fresh = !a->project;
    if (fresh && a->granted) { /* operator-added user: its id was reserved by the GRANT */
        if (append(b, 1, index, a->granted, 0, 0) < 0) return -1;
        a->project = a->granted;
    } else if (fresh) {
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
    if (project_dir(&b->policy, fd, fresh) < 0 || identity(fd, &s, &mount_id) < 0) goto done;
    if (mount_id != b->mount_id || (uint64_t)s.st_dev != b->policy.root_device) {
        errno = EXDEV; goto done;
    }
    if (fresh) {
        if (empty_dir(fd) < 0 || fsync(fd) < 0 ||
            append(b, 2, index, a->project, (uint64_t)s.st_dev, (uint64_t)s.st_ino) < 0) goto done;
        a->device = (uint64_t)s.st_dev; a->inode = (uint64_t)s.st_ino;
        if (observed(b, fd, a, a->project, 1) < 0 || mount_check(b) < 0 ||
            b->adapter.configure(b->adapter.context, b->root, fd, a->project,
                                 b->policy.bytes_hard, b->policy.inodes_hard) < 0 || fsync(fd) < 0) goto done;
        if (b->policy.layout == QB_LAYOUT_SHARED && hand_over_user(b, fd) < 0) goto done;
    } else if (a->device != (uint64_t)s.st_dev || a->inode != (uint64_t)s.st_ino) {
        errno = ESTALE; goto done;
    }
    if (observed(b, fd, a, a->project, 0) < 0 || mount_check(b) < 0) goto done;
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
    out->bytes_hard = a->bytes_hard; out->inodes_hard = a->inodes_hard;
    memcpy(out->mount_uuid, b->policy.mount_uuid, 16);
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

/* ---- per-user pool: workspace directories and usage (QB_LAYOUT_SHARED) ---- */
static int frame_uuid(const char *s, size_t at, char out[37]) {
    memcpy(out, s + at, 36); out[36] = 0;
    return uuid(out) ? 0 : -1;
}
static int same_name(struct qb *b, int parent, const char *name, uint64_t inode) {
    int named = beneath(parent, name, O_RDONLY | O_DIRECTORY, 0);
    if (named < 0) return -1;
    struct stat s; uint64_t mount_id;
    int ok = identity(named, &s, &mount_id);
    int saved = errno; close(named); errno = saved;
    if (ok < 0) return -1;
    if ((uint64_t)s.st_ino != inode || (uint64_t)s.st_dev != b->policy.root_device ||
        mount_id != b->mount_id) return deny(ESTALE);
    return 0;
}
static int workspace_locked(struct qb *b, int index, const char *workspace, int create, struct qb_workspace_receipt *out) {
    /* Launch never allocates, adopts or repairs a prepared directory. */
    if (!create && !b->allocations[index].project) return deny(ENOENT);
    struct qb_receipt user;
    memset(&user, 0, sizeof(user)); user.directory_fd = -1;
    if (ensure_locked(b, index, &user) < 0) return -1;
    int result = -1, fd = beneath(user.directory_fd, workspace, O_RDONLY | O_DIRECTORY, 0);
    int fresh = 0;
    if (create && fd < 0 && errno == ENOENT) {
        /* Nobody but the broker can write p<ID> (broker-owned 0750): no creation race. */
        if (mkdirat(user.directory_fd, workspace, 0700) < 0 || fsync(user.directory_fd) < 0) goto done;
        fd = beneath(user.directory_fd, workspace, O_RDONLY | O_DIRECTORY, 0);
        fresh = 1;
    }
    if (fd < 0) goto done;
    struct stat s; uint64_t mount_id;
    if ((fresh ? protected_fd(fd, 1) : workspace_dir_ok(&b->policy, fd)) < 0 ||
        identity(fd, &s, &mount_id) < 0) goto done;
    if (mount_id != b->mount_id || (uint64_t)s.st_dev != b->policy.root_device) { errno = EXDEV; goto done; }
    if (fresh && (empty_dir(fd) < 0 || hand_over_workspace(b, fd) < 0)) goto done;
    /* The workspace must carry the user's project + inheritance (XFS PROJINHERIT). */
    char pool_name[16];
    int n = snprintf(pool_name, sizeof(pool_name), "p%u", user.project);
    if (n < 0 || (size_t)n >= sizeof(pool_name)) { errno = EOVERFLOW; goto done; }
    if (observed(b, fd, &b->allocations[index], user.project, 0) < 0 || mount_check(b) < 0 ||
        same_name(b, b->root, pool_name, user.inode) < 0 ||
        same_name(b, user.directory_fd, workspace, (uint64_t)s.st_ino) < 0) goto done;
    out->directory_fd = fd; out->project = user.project; out->device = user.device;
    out->user_inode = user.inode; out->inode = (uint64_t)s.st_ino;
    out->bytes_hard = user.bytes_hard; out->inodes_hard = user.inodes_hard;
    memcpy(out->mount_uuid, user.mount_uuid, 16);
    result = 0;
done: {
    int saved = errno;
    if (result < 0 && fd >= 0) close(fd);
    if (user.directory_fd >= 0) close(user.directory_fd);
    errno = saved;
    return result;
}}
int qb_workspace(struct qb *b, uid_t peer, const void *frame, size_t length, struct qb_workspace_receipt *out) {
    if (!out) return deny(EINVAL);
    memset(out, 0, sizeof(*out)); out->directory_fd = -1;
    const char *s = frame;
    char user[37], workspace[37];
    if (!b || !s || length != 86 || memcmp(s, "WORKSPACE/1 ", 12) || s[48] != ' ' || s[85] != '\n' ||
        frame_uuid(s, 12, user) < 0 || frame_uuid(s, 49, workspace) < 0) return deny(EPROTO);
    if (b->policy.layout != QB_LAYOUT_SHARED) return deny(ENOTSUP);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, user), result = -1;
    if (index >= 0) {
        if ((uint64_t)peer == b->policy.grants[index].peer_uid) result = workspace_locked(b, index, workspace, 1, out);
        else errno = EACCES;
    }
    int saved = errno; pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}
int qb_launch_workspace(struct qb *b, uid_t peer, const char *user, const char *workspace,
                        const struct qb_launch_identity *expected,
                        const struct qb_spawn_adapter *adapter) {
    if (!b || !user || !workspace || !uuid(user) || !uuid(workspace) || !expected)
        return deny(EINVAL);
    if (!adapter || !adapter->spawn) return deny(ENOTSUP); /* no default launcher */
    if (b->policy.layout != QB_LAYOUT_SHARED) return deny(ENOTSUP);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, user), result = -1;
    struct qb_workspace_receipt r;
    memset(&r, 0, sizeof(r)); r.directory_fd = -1;
    if (index >= 0) {
        if ((uint64_t)peer != b->policy.grants[index].peer_uid) errno = EACCES;
        else if (workspace_locked(b, index, workspace, 0, &r) == 0) {
            if (r.device != expected->device || r.user_inode != expected->user_inode ||
                r.inode != expected->inode) errno = ESTALE;
            else result = adapter->spawn(adapter->context, &r);
        }
    }
    /* The actual synchronous spawn, error handling and FD release all precede
     * unlock. An acknowledged revoke therefore cannot precede a later callback. */
    int saved = errno;
    if (r.directory_fd >= 0) close(r.directory_fd);
    pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}

/* Open an allocated user's p<ID> and require it is the recorded directory (identity, mount,
 * owner/mode). Never creates. */
static int open_pool(struct qb *b, const struct allocation *a) {
    char name[16];
    int n = snprintf(name, sizeof(name), "p%u", a->project);
    if (n < 0 || (size_t)n >= sizeof(name)) return deny(EOVERFLOW);
    int fd = beneath(b->root, name, O_RDONLY | O_DIRECTORY, 0);
    if (fd < 0) return -1;
    struct stat s; uint64_t mount_id;
    if (project_dir(&b->policy, fd, 0) < 0 || identity(fd, &s, &mount_id) < 0) goto fail;
    if ((uint64_t)s.st_ino != a->inode || (uint64_t)s.st_dev != a->device || mount_id != b->mount_id) {
        errno = ESTALE; goto fail;
    }
    return fd;
fail: {
    int saved = errno; close(fd); errno = saved;
    return -1;
}}
static int usage_locked(struct qb *b, int index, struct qb_usage *out) {
    struct allocation *a = &b->allocations[index];
    if (b->poisoned) return deny(EIO);
    if (a->revoked) return deny(EACCES);
    if (!a->project) return deny(ENOENT); /* never allocates */
    if (!a->inode) return deny(EOWNERDEAD);
    if (mount_check(b) < 0) return -1;
    int fd = open_pool(b, a);
    if (fd < 0) return -1;
    int result = -1;
    struct qb_observation o; memset(&o, 0, sizeof(o));
    if (b->adapter.observe(b->adapter.context, b->root, fd, a->project, &o) < 0) goto done;
    if (o.project != a->project || o.inherit != 1 || o.bytes_hard != a->bytes_hard ||
        o.inodes_hard != a->inodes_hard) { errno = EDQUOT; goto done; }
    out->project = a->project;
    out->bytes_used = o.bytes_used; out->inodes_used = o.inodes_used;
    out->bytes_hard = o.bytes_hard; out->inodes_hard = o.inodes_hard;
    result = 0;
done: {
    int saved = errno; close(fd); errno = saved;
    return result;
}}
int qb_usage(struct qb *b, uid_t peer, const void *frame, size_t length, struct qb_usage *out) {
    if (!out) return deny(EINVAL);
    memset(out, 0, sizeof(*out));
    const char *s = frame;
    char user[37];
    if (!b || !s || length != 45 || memcmp(s, "USAGE/1 ", 8) || s[44] != '\n' || frame_uuid(s, 8, user) < 0)
        return deny(EPROTO);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, user), result = -1;
    if (index >= 0) {
        if ((uint64_t)peer == b->policy.grants[index].peer_uid) result = usage_locked(b, index, out);
        else errno = EACCES;
    }
    int saved = errno; pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}

/* ---- operator-only pool operations ---- */
/* Reservation ledger: charge FULL hard limits of ALL grants, including revoked and
 * unallocated grants. Usage is report-only: it must NEVER buy admission headroom.
 * The root-owned reserve and filesystem total define the reservation ceiling; a second,
 * deliberately stricter free-space veto charges all current occupancy again (including
 * user data). Thus no subtraction of asynchronous quota usage from statvfs is needed.
 * This can refuse safe grants, but concurrent deletion cannot count freed space twice.
 * Unknown future external writes/metadata still require operator reserve and monitoring;
 * no read sequence is an atomic snapshot or a fence against external disk consumers. */
static int capacity(struct qb *b, int changed, uint64_t changed_bytes, int adding, struct qb_capacity *out) {
    struct qb_capacity c; memset(&c, 0, sizeof(c));
    for (uint32_t i = 0; i < b->policy.grant_count; i++) {
        const struct allocation *a = &b->allocations[i];
        uint64_t hard = (int)i == changed ? changed_bytes : a->bytes_hard;
        c.users++;
        if (a->inode) {
            int fd = open_pool(b, a);
            if (fd < 0) return -1;
            struct qb_observation o; memset(&o, 0, sizeof(o));
            int rc = b->adapter.observe(b->adapter.context, b->root, fd, a->project, &o);
            int saved = errno; close(fd); errno = saved;
            if (rc < 0) return -1;
            if (o.project != a->project || o.inherit != 1 || !o.bytes_hard || !o.inodes_hard ||
                o.bytes_hard > a->bytes_hard ||
                o.inodes_hard > a->inodes_hard) return deny(EDQUOT);
        }
        if (hard > UINT64_MAX - c.committed) return deny(EOVERFLOW);
        c.committed += hard;
    }
    if (adding) {
        if (b->policy.bytes_hard > UINT64_MAX - c.committed) return deny(EOVERFLOW);
        c.users++; c.committed += b->policy.bytes_hard;
    }
    struct statvfs v;
    if (fstatvfs(b->root, &v) < 0) return -1;
    /* Reserved filesystem blocks are NOT user capacity (use bavail, never bfree).
     * Invalid geometry or multiplication overflow fails closed, never saturates. */
    if (!v.f_frsize || v.f_bfree > v.f_blocks || v.f_bavail > v.f_bfree) return deny(EIO);
    if (v.f_blocks > UINT64_MAX / v.f_frsize) return deny(EOVERFLOW);
    uint64_t total = (uint64_t)v.f_blocks * v.f_frsize;
    c.available = (uint64_t)v.f_bavail * v.f_frsize;
    c.reserve = b->policy.reserve_bytes;
    if (out) *out = c;
    if (c.reserve > total || c.committed > total - c.reserve ||
        c.committed > c.available || c.available - c.committed < c.reserve) return deny(EFBIG);
    return 0;
}
static int grant_locked(struct qb *b, const char *user, uint32_t *project, struct qb_capacity *cap) {
    if (b->poisoned) return deny(EIO);
    if (!b->policy.added_peer_uid) return deny(EPERM);
    if (grant_index(b, user) >= 0) return deny(EEXIST);
    if (b->policy.grant_count >= QB_MAX_GRANTS || b->next > b->policy.last_project) return deny(ENOSPC);
    if (mount_check(b) < 0 || capacity(b, -1, 0, 1, cap) < 0) return -1;
    if (append_for(b, 4, user, b->next, 0, 0) < 0) return -1;
    if (project) *project = b->next;
    add_grant(b, user, b->next++);
    return 0;
}
int qb_grant_add(struct qb *b, const char *user, uint32_t *project, struct qb_capacity *cap) {
    if (project) *project = 0;
    if (cap) memset(cap, 0, sizeof(*cap));
    if (!b || !user || !uuid(user)) return deny(EINVAL);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int result = grant_locked(b, user, project, cap);
    int saved = errno; pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}
static int raise_locked(struct qb *b, int index, uint64_t bytes, uint64_t inodes, struct qb_capacity *cap) {
    struct allocation *a = &b->allocations[index];
    if (b->poisoned) return deny(EIO);
    if (a->revoked) return deny(EACCES);
    if (!a->project) return deny(ENOENT);
    if (!a->inode) return deny(EOWNERDEAD);
    if (!b->adapter.raise) return deny(ENOTSUP);
    if (bytes < a->bytes_hard || inodes < a->inodes_hard) return deny(EINVAL); /* never lower */
    int record = bytes != a->bytes_hard || inodes != a->inodes_hard;
    if (record && b->raises >= QB_MAX_RAISES) return deny(ENOSPC);
    if (mount_check(b) < 0) return -1;
    int fd = open_pool(b, a);
    if (fd < 0) return -1;
    int result = -1;
    struct qb_observation o; memset(&o, 0, sizeof(o));
    if (b->adapter.observe(b->adapter.context, b->root, fd, a->project, &o) < 0) goto done;
    /* The kernel may lag the journal (an unapplied raise), never lead it. */
    if (o.project != a->project || o.inherit != 1 || !o.bytes_hard || !o.inodes_hard ||
        o.bytes_hard > a->bytes_hard || o.inodes_hard > a->inodes_hard) { errno = EDQUOT; goto done; }
    if (!record && o.bytes_hard == bytes && o.inodes_hard == inodes) { result = 0; goto done; }
    if (record) {
        if (capacity(b, index, bytes, 0, cap) < 0 ||
            append(b, 5, index, a->project, bytes, inodes) < 0) goto done;
        a->bytes_hard = bytes; a->inodes_hard = inodes; b->raises++;
    }
    if (mount_check(b) < 0 ||
        b->adapter.raise(b->adapter.context, b->root, fd, a->project, bytes, inodes) < 0 ||
        observed(b, fd, a, a->project, 0) < 0 || mount_check(b) < 0) goto done;
    result = 0;
done: {
    int saved = errno; close(fd); errno = saved;
    return result;
}}
int qb_raise(struct qb *b, const char *user, uint64_t bytes, uint64_t inodes, struct qb_capacity *cap) {
    if (cap) memset(cap, 0, sizeof(*cap));
    if (!b || !user || !uuid(user) || !limits_ok(bytes, inodes)) return deny(EINVAL);
    int error = pthread_mutex_lock(&b->mutex);
    if (error) return deny(error);
    int index = grant_index(b, user), result = -1;
    if (index >= 0) result = raise_locked(b, index, bytes, inodes, cap);
    int saved = errno; pthread_mutex_unlock(&b->mutex); errno = saved;
    return result;
}
