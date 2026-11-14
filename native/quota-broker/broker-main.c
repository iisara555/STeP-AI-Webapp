/* step-quota-broker: the installable native quota broker service.
 *
 *   step-quota-broker --check      validate policy, directories, mount and state; no mutation
 *   step-quota-broker --bootstrap  ONE-TIME: create the state journal (refuses unless state AND
 *                                  root are empty and the live mount matches the policy)
 *   step-quota-broker --serve      serve the fixed ENSURE protocol on the fixed socket
 *   step-quota-broker --recover-custody
 *                                  validate returned custody only, then REFUSE (not wired)
 *   step-quota-broker --add-user UUID
 *                                  OPERATOR: durably grant a new user pool (journal record, fresh
 *                                  never reused project id, no-overcommit check)
 *   step-quota-broker --raise-user UUID BYTES INODES
 *                                  OPERATOR: raise one allocated user's hard limits (only up;
 *                                  journal record, Q_XSETQLIM, readback, no-overcommit check)
 *
 * The two operator commands are the only ones taking values on the command line (a canonical
 * UUID and canonical decimals, validated before anything is opened). They are never reachable
 * over the gateway socket; they need the exclusive journal lock, so they refuse ("in use")
 * while the service runs: stop it, run the command, start it. On failure, leave the service
 * stopped, inspect the journal outcome, and retry only the same command when appropriate.
 *
 * Production build: fixed absolute paths, euid 0 required, real XFS adapter. No path, ID, limit,
 * principal or option comes from the environment or the command line. The only environment
 * inputs are systemd notification/activation metadata, strictly validated for custody. Fixed
 * root-owned policy and recovery manifest files are the only configuration inputs.
 * --serve never bootstraps (a lost/empty state directory must never
 * silently restart allocation; that needs an owner re-install with a fresh quota census).
 *
 * Testing build (-DQB_BROKER_TESTING): refuses root, takes the five directories as arguments,
 * expects them owned by the invoking user, and uses an in-file FAKE quota adapter. It performs no
 * quota/attribute ioctl or quotactl at all; it exists only to test startup and the socket client.
 */
#define _GNU_SOURCE
#include "core.h"
#include "policy.h"
#include "transport.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>
#ifndef QB_BROKER_TESTING
#include "xfs.h"
#endif

#define POLICY_NAME "policy"
#define SOCKET_NAME "broker.sock"
#ifndef QB_BROKER_TESTING
#define POLICY_DIR "/etc/step-quota-broker"
#define BROKER_DIR "/mnt/step-work/step-ai-broker"
#define SOCKET_DIR "/run/step-quota-broker"
#endif
enum { EXIT_RUNTIME = 1, EXIT_REFUSED = 2 };
enum command { CHECK, BOOTSTRAP, SERVE, ADD_USER, RAISE_USER, RECOVER_CUSTODY };

static void say(const char *what) { fprintf(stderr, "step-quota-broker: %s\n", what); }
static int refuse(const char *what) {
    int saved = errno;
    fprintf(stderr, "step-quota-broker: REFUSED: %s%s%s\n", what, saved ? ": " : "",
            saved ? strerror(saved) : "");
    return EXIT_REFUSED;
}
static int deny(int error) { errno = error; return -1; }

static int beneath(int parent, const char *name, int flags) {
    struct open_how how = {
        .flags = (uint64_t)(unsigned int)(flags | O_CLOEXEC | O_NOFOLLOW),
        .mode = (flags & O_CREAT) ? 0600 : 0,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}
/* Directory owned by one of the allowed owners and not group/other-writable. */
static int trusted(int fd, uid_t a, uid_t b) {
    struct stat s;
    if (fstat(fd, &s) < 0) return -1;
    if (!S_ISDIR(s.st_mode) || (s.st_uid != a && s.st_uid != b) || (s.st_mode & 022)) return deny(EPERM);
    return 0;
}
/* Walk an absolute path component by component from `base` without following any symlink,
 * requiring every directory on the way (including base) to be trusted(a, b); the final
 * directory must be owned by `final_owner`. Returns an O_RDONLY|O_DIRECTORY descriptor. */
static int open_chain(int base, const char *path, uid_t a, uid_t b, uid_t final_owner) {
    char copy[4096];
    if (!path || path[0] != '/' || strlen(path) >= sizeof(copy)) return deny(EINVAL);
    strcpy(copy, path);
    int fd = fcntl(base, F_DUPFD_CLOEXEC, 3);
    if (fd < 0) return -1;
    if (trusted(fd, a, b) < 0) goto fail;
    char *save = NULL;
    for (char *c = strtok_r(copy, "/", &save); c; c = strtok_r(NULL, "/", &save)) {
        if (!strcmp(c, ".") || !strcmp(c, "..")) { errno = EINVAL; goto fail; }
        int next = openat(fd, c, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int saved = errno; close(fd); errno = saved; fd = next;
        if (fd < 0 || trusted(fd, a, b) < 0) goto fail;
    }
    struct stat s;
    if (fstat(fd, &s) < 0) goto fail;
    if (s.st_uid != final_owner) { errno = EPERM; goto fail; }
    return fd;
fail: {
    int saved = errno; if (fd >= 0) close(fd); errno = saved; return -1;
}}
static int empty(int fd) {
    int copy = beneath(fd, ".", O_RDONLY | O_DIRECTORY);
    if (copy < 0) return -1;
    DIR *d = fdopendir(copy);
    if (!d) { close(copy); return -1; }
    struct dirent *e; int result = 0;
    errno = 0;
    while ((e = readdir(d)))
        if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) { result = -1; errno = ENOTEMPTY; break; }
    if (!e && errno) result = -1;
    int saved = errno; closedir(d); errno = saved;
    return result;
}

/* Recovery custody is a process-entry concern, not a socket request. Bounded
 * systemd activation descriptors occupy 3..3+n-1; no FDNAME grants authority.
 * A separately protected, fixed-path manifest binds each entry to dev/ino/type.
 * This increment has no manifest writer, FDSTORE deposit, lifecycle or bus calls. */
#define CUSTODY_MAX 16
#define CUSTODY_ID 32
struct custody {
    unsigned count;
    char id[CUSTODY_MAX][CUSTODY_ID + 1];
    uint64_t device[CUSTODY_MAX], inode[CUSTODY_MAX];
};
static int custody_number(const char *s, uint64_t *out) {
    if (!s || !*s || (s[0] == '0' && s[1])) return deny(EINVAL);
    uint64_t v = 0;
    for (; *s; s++) {
        if (*s < '0' || *s > '9') return deny(EINVAL);
        unsigned d = (unsigned)(*s - '0');
        if (v > (UINT64_MAX - d) / 10) return deny(EOVERFLOW);
        v = v * 10 + d;
    }
    *out = v;
    return 0;
}
static int custody_id(const char *s) {
    if (strlen(s) != CUSTODY_ID) return 0;
    for (unsigned i = 0; i < CUSTODY_ID; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
    return 1;
}
static int custody_capture(struct custody *c) {
    const char *pid = getenv("LISTEN_PID"), *fds = getenv("LISTEN_FDS"),
               *names = getenv("LISTEN_FDNAMES");
    int ok = 0;
    if (pid || fds || names) {
        uint64_t p = 0, n = 0;
        if (custody_number(pid, &p) < 0 || p != (uint64_t)getpid() ||
            custody_number(fds, &n) < 0 || n > CUSTODY_MAX || !names) goto done;
        size_t len = strnlen(names, CUSTODY_MAX * 37U);
        if (len != (n ? n * 37 - 1 : 0)) goto done;
        for (unsigned i = 0; i < (unsigned)n; i++) {
            const char *s = names + i * 37;
            if (memcmp(s, "qbc-", 4) || (i + 1 < n && s[36] != ':')) goto done;
            memcpy(c->id[i], s + 4, CUSTODY_ID);
            if (!custody_id(c->id[i])) goto done;
            for (unsigned j = 0; j < i; j++)
                if (!strcmp(c->id[i], c->id[j])) goto done;
            /* Check existence before opening anything that might fill a hole. */
            if (fcntl(3 + (int)i, F_SETFD, FD_CLOEXEC) < 0) goto done;
        }
        c->count = (unsigned)n;
    }
    ok = 1;
done:
    if (unsetenv("LISTEN_PID") || unsetenv("LISTEN_FDS") || unsetenv("LISTEN_FDNAMES")) ok = 0;
    /* Preserve only validated names at the bounded activation positions. Invalid
     * activation closes everything, including descriptors outside that range. */
    if (close_range(ok ? 3 + c->count : 3, ~0U, 0) < 0) return -1;
    return ok ? 0 : deny(EINVAL);
}
/* No pathname for a cgroup is accepted or reopened, even after a lost pin.
 * Manifest grammar is deliberately small and versioned:
 * QB-CUSTODY/1\n<32 lowercase hex entry> <decimal dev> <decimal ino> directory\n
 * All manifest entries must have exactly one returned descriptor. */
static int custody_manifest(int pdir, uid_t owner, struct custody *c) {
    int fd = beneath(pdir, "recovery-custody.v1", O_RDONLY | O_NONBLOCK);
    if (fd < 0) return -1;
    struct stat s;
    char bytes[4097];
    ssize_t got = -1;
    int valid = fstat(fd, &s) == 0 && S_ISREG(s.st_mode) && s.st_uid == owner &&
                (s.st_mode & 07777) == 0600 && s.st_nlink == 1 &&
                s.st_size > 0 && s.st_size <= 4096;
    if (valid) got = read(fd, bytes, sizeof(bytes));
    int saved = errno; close(fd); errno = saved;
    if (!valid || got != s.st_size || got <= 0 || got > 4096 ||
        memchr(bytes, 0, (size_t)got)) return deny(EINVAL);
    bytes[got] = 0;
    const char header[] = "QB-CUSTODY/1\n";
    if ((size_t)got < sizeof(header) - 1 || memcmp(bytes, header, sizeof(header) - 1)) return deny(EINVAL);
    char *line = bytes + sizeof(header) - 1;
    unsigned seen = 0, count = 0;
    while (*line) {
        if (++count > CUSTODY_MAX) return deny(EINVAL);
        char *end = strchr(line, '\n');
        if (!end) return deny(EINVAL);
        *end = 0;
        char *dev = strchr(line, ' ');
        if (!dev) return deny(EINVAL);
        *dev++ = 0;
        char *ino = strchr(dev, ' ');
        if (!ino) return deny(EINVAL);
        *ino++ = 0;
        char *type = strchr(ino, ' ');
        if (!type) return deny(EINVAL);
        *type++ = 0;
        uint64_t d, in;
        if (!custody_id(line) || custody_number(dev, &d) < 0 ||
            custody_number(ino, &in) < 0 || !in || strcmp(type, "directory")) return deny(EINVAL);
        unsigned i;
        for (i = 0; i < c->count; i++) if (!strcmp(line, c->id[i])) break;
        if (i == c->count || (seen & (1U << i))) return deny(EINVAL);
        seen |= 1U << i;
        c->device[i] = d; c->inode[i] = in;
        line = end + 1;
    }
    return count == c->count && count ? 0 : deny(ENODATA);
}
static int custody_bind(uid_t owner, const struct custody *c) {
    for (unsigned i = 0; i < c->count; i++) {
        struct stat s;
        int flags = fcntl(3 + (int)i, F_GETFL);
        if (flags < 0 || (flags & O_PATH) || (flags & O_ACCMODE) != O_RDONLY ||
            fstat(3 + (int)i, &s) < 0 || !S_ISDIR(s.st_mode) ||
            s.st_uid != owner || (s.st_mode & 022) ||
            (uint64_t)s.st_dev != c->device[i] || (uint64_t)s.st_ino != c->inode[i]) return deny(ESTALE);
    }
    return 0;
}

#ifdef QB_BROKER_TESTING
__attribute__((used)) static const char custody_test_marker[] = "QB_CUSTODY_TEST_SEAM";
/* FAKE quota adapter: per-directory "attributes" and per-project "quota" are small files in a
 * separate test-only directory, so a restarted fake broker observes what it configured. */
struct fake { int dir; uint8_t uuid[16]; };
static ssize_t fake_read(int dir, const char *name, char *buffer, size_t size) {
    int fd = beneath(dir, name, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buffer, size - 1);
    int saved = errno; close(fd); errno = saved;
    if (n >= 0) buffer[n] = 0;
    return n;
}
static int fake_write(int dir, const char *name, const char *text) {
    int fd = beneath(dir, name, O_WRONLY | O_CREAT | O_TRUNC);
    if (fd < 0) return -1;
    size_t n = strlen(text);
    int ok = write(fd, text, n) == (ssize_t)n && fsync(fd) == 0 ? 0 : -1;
    int saved = errno; close(fd); errno = saved;
    return ok;
}
static int nibble(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
static int fake_mount(void *v, int fd, uint8_t uuid[16], int *enforced) {
    struct fake *f = v;
    struct stat s;
    if (fstat(fd, &s) < 0 || !S_ISDIR(s.st_mode)) return deny(EBADF);
    memcpy(uuid, f->uuid, 16);
    char text[64];
    if (fake_read(f->dir, "mount-uuid", text, sizeof(text)) >= 32) { /* test override */
        for (size_t i = 0, j = 0; text[i] && j < 16; i++) {
            if (text[i] == '-') continue;
            int hi = nibble(text[i]), lo = nibble(text[i + 1]);
            if (hi < 0 || lo < 0) return deny(EINVAL);
            uuid[j++] = (uint8_t)(hi << 4 | lo); i++;
        }
    }
    *enforced = faccessat(f->dir, "not-enforced", F_OK, AT_SYMLINK_NOFOLLOW) == 0 ? 0 : 1;
    return 0;
}
static int fake_observe(void *v, int root, int dir, uint32_t project, struct qb_observation *out) {
    struct fake *f = v; (void)root;
    memset(out, 0, sizeof(*out));
    struct stat s;
    if (fstat(dir, &s) < 0) return -1;
    char name[64], text[64];
    snprintf(name, sizeof(name), "d%llu", (unsigned long long)s.st_ino);
    ssize_t got = fake_read(f->dir, name, text, sizeof(text));
    if (got < 0 && errno == ENOENT) {
        /* XFS PROJINHERIT model: a directory made inside a project directory inherits it. */
        struct stat parent;
        if (fstatat(dir, "..", &parent, 0) < 0) return -1;
        snprintf(name, sizeof(name), "d%llu", (unsigned long long)parent.st_ino);
        got = fake_read(f->dir, name, text, sizeof(text));
    }
    if (got > 0) {
        out->project = (uint32_t)strtoul(text, NULL, 10); out->inherit = 1;
    } else if (errno != ENOENT) return -1;
    snprintf(name, sizeof(name), "q%u", project);
    if (fake_read(f->dir, name, text, sizeof(text)) > 0) {
        unsigned long long bytes = 0, inodes = 0;
        if (sscanf(text, "%llu %llu", &bytes, &inodes) != 2) return deny(EUCLEAN);
        out->bytes_hard = bytes; out->inodes_hard = inodes;
    } else if (errno != ENOENT) return -1;
    snprintf(name, sizeof(name), "u%u", project); /* test-written usage: "<bytes> <inodes>" */
    if (fake_read(f->dir, name, text, sizeof(text)) > 0) {
        unsigned long long bytes = 0, inodes = 0;
        if (sscanf(text, "%llu %llu", &bytes, &inodes) != 2) return deny(EUCLEAN);
        out->bytes_used = bytes; out->inodes_used = inodes;
    } else if (errno != ENOENT) return -1;
    return 0;
}
static int fake_configure(void *v, int root, int dir, uint32_t project, uint64_t bytes, uint64_t inodes) {
    struct fake *f = v;
    struct qb_observation o;
    if (fake_observe(v, root, dir, project, &o) < 0) return -1;
    if (o.project || o.inherit || o.bytes_hard || o.inodes_hard) return deny(EEXIST);
    if (faccessat(f->dir, "fail-configure", F_OK, AT_SYMLINK_NOFOLLOW) == 0) return deny(EIO);
    struct stat s;
    if (fstat(dir, &s) < 0) return -1;
    char name[64], text[64];
    snprintf(name, sizeof(name), "q%u", project);
    snprintf(text, sizeof(text), "%llu %llu\n", (unsigned long long)bytes, (unsigned long long)inodes);
    if (fake_write(f->dir, name, text) < 0) return -1;
    snprintf(name, sizeof(name), "d%llu", (unsigned long long)s.st_ino);
    snprintf(text, sizeof(text), "%u\n", project);
    return fake_write(f->dir, name, text);
}
static int fake_raise(void *v, int root, int dir, uint32_t project, uint64_t bytes, uint64_t inodes) {
    struct fake *f = v;
    struct qb_observation o;
    if (fake_observe(v, root, dir, project, &o) < 0) return -1;
    if (o.project != project || !o.inherit || !o.bytes_hard || !o.inodes_hard ||
        o.bytes_hard > bytes || o.inodes_hard > inodes) return deny(EINVAL);
    if (faccessat(f->dir, "fail-raise", F_OK, AT_SYMLINK_NOFOLLOW) == 0) return deny(EIO);
    char name[64], text[64];
    snprintf(name, sizeof(name), "q%u", project);
    snprintf(text, sizeof(text), "%llu %llu\n", (unsigned long long)bytes, (unsigned long long)inodes);
    return fake_write(f->dir, name, text);
}
/* Test-only free space for the no-overcommit check: fake/available ("<bytes>\n") replaces
 * f_bavail * f_frsize of every fstatvfs (linked with --wrap=fstatvfs); absent = real. */
static int fake_space_dir = -1;
int __real_fstatvfs(int fd, struct statvfs *v);
int __wrap_fstatvfs(int fd, struct statvfs *v);
int __wrap_fstatvfs(int fd, struct statvfs *v) {
    int rc = __real_fstatvfs(fd, v);
    char text[32];
    if (rc == 0 && fake_space_dir >= 0 && fake_read(fake_space_dir, "available", text, sizeof(text)) > 0) {
        v->f_frsize = 4096; v->f_bavail = strtoull(text, NULL, 10) / 4096;
        /* A complete synthetic filesystem, not impossible available > total geometry. */
        v->f_bfree = v->f_bavail; v->f_blocks = v->f_bavail;
    }
    return rc;
}
#endif

/* systemd Type=notify readiness without libsystemd. */
static void notify_ready(void) {
    const char *path = getenv("NOTIFY_SOCKET");
    if (!path || !path[0]) return;
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    size_t n = strlen(path);
    if (n >= sizeof(a.sun_path) || (path[0] != '/' && path[0] != '@')) return;
    memcpy(a.sun_path, path, n);
    if (a.sun_path[0] == '@') a.sun_path[0] = 0;
    int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return;
    (void)sendto(fd, "READY=1", 7, MSG_NOSIGNAL, (struct sockaddr *)&a,
                 (socklen_t)(offsetof(struct sockaddr_un, sun_path) + n));
    close(fd);
}

/* Fixed socket in a fresh, empty, euid-owned 0700 directory (systemd RuntimeDirectory). The
 * socket is made root:gateway_gid 0660 and listening BEFORE the directory is opened to the
 * gateway group (root:gateway_gid 0710); nobody else can traverse to it. SO_PEERCRED in the
 * transport additionally requires the exact gateway uid before any read. */
static int listen_socket(int dir, gid_t group) {
    struct stat s;
    if (fstat(dir, &s) < 0) return -1;
    if (!S_ISDIR(s.st_mode) || s.st_uid != geteuid() || (s.st_mode & 07777) != 0700) return deny(EPERM);
    if (empty(dir) < 0) return -1; /* never unlink/rebind: a leftover socket means refuse */
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    memcpy(a.sun_path, SOCKET_NAME, sizeof(SOCKET_NAME));
    /* Relative bind inside the pinned directory: no long or re-resolved path. */
    if (fchdir(dir) < 0 || bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0 || chdir("/") < 0 ||
        fchownat(dir, SOCKET_NAME, geteuid(), group, AT_SYMLINK_NOFOLLOW) < 0 ||
        fchmodat(dir, SOCKET_NAME, 0660, 0) < 0 || fstatat(dir, SOCKET_NAME, &s, AT_SYMLINK_NOFOLLOW) < 0)
        goto fail;
    if (!S_ISSOCK(s.st_mode) || s.st_uid != geteuid() || s.st_gid != group || (s.st_mode & 07777) != 0660) {
        errno = EPERM; goto fail;
    }
    if (listen(fd, QB_TRANSPORT_CLIENTS) < 0 || fchown(dir, geteuid(), group) < 0 ||
        fchmod(dir, 0710) < 0 || fstat(dir, &s) < 0) goto fail;
    if (s.st_gid != group || (s.st_mode & 07777) != 0710) { errno = EPERM; goto fail; }
    return fd;
fail: {
    int saved = errno; close(fd); errno = saved; return -1;
}}

/* Operator values: canonical lowercase UUID; canonical decimal (no sign/leading zero). */
static int canonical_uuid(const char *s) {
    if (!s || strlen(s) != 36) return 0;
    for (size_t i = 0; i < 36; i++) {
        int dash = i == 8 || i == 13 || i == 18 || i == 23;
        if (dash ? s[i] != '-' : !((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
    }
    return 1;
}
static int decimal(const char *s, uint64_t *out) {
    size_t n = s ? strlen(s) : 0;
    if (!n || n > 19 || (s[0] == '0' && n > 1)) return -1;
    uint64_t v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return -1;
        v = v * 10 + (uint64_t)(s[i] - '0');
    }
    *out = v;
    return 0;
}
static void print_capacity(const struct qb_capacity *c) {
    fprintf(stderr, "step-quota-broker: capacity: %u users promise %llu B + reserve %llu B, %llu B free\n",
            c->users, (unsigned long long)c->committed, (unsigned long long)c->reserve,
            (unsigned long long)c->available);
}
static int usage(void) {
#ifdef QB_BROKER_TESTING
    say("usage (TESTING build): step-quota-broker-fake --check|--bootstrap|--serve|--add-user UUID|"
        "--raise-user UUID BYTES INODES --trust-root DIR --policy-dir DIR --broker-dir DIR "
        "--socket-dir DIR --fake-dir DIR");
#else
    say("usage: step-quota-broker --check|--bootstrap|--serve|--recover-custody | --add-user UUID | "
        "--raise-user UUID BYTES INODES");
#endif
    return EXIT_REFUSED;
}

int main(int argc, char **argv) {
    struct custody custody = {0};
    if (custody_capture(&custody) < 0) return refuse("custody activation UNKNOWN");
    umask(077);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return refuse("no_new_privs");
    /* Entry cleanup already closed every non-custody inherited descriptor. */
    if (argc < 2) return usage();
    enum command command;
    if (!strcmp(argv[1], "--check")) command = CHECK;
    else if (!strcmp(argv[1], "--bootstrap")) command = BOOTSTRAP;
    else if (!strcmp(argv[1], "--serve")) command = SERVE;
    else if (!strcmp(argv[1], "--recover-custody")) command = RECOVER_CUSTODY;
    else if (!strcmp(argv[1], "--add-user")) command = ADD_USER;
    else if (!strcmp(argv[1], "--raise-user")) command = RAISE_USER;
    else return usage();
    const int values = command == ADD_USER ? 1 : command == RAISE_USER ? 3 : 0;
    if (argc < 2 + values) return usage();
    const char *user = values ? argv[2] : NULL;
    uint64_t raise_bytes = 0, raise_inodes = 0;
    if (user && !canonical_uuid(user)) { errno = EINVAL; return refuse("user must be a canonical lowercase UUID"); }
    if (command == RAISE_USER && (decimal(argv[3], &raise_bytes) < 0 || decimal(argv[4], &raise_inodes) < 0)) {
        errno = EINVAL; return refuse("BYTES and INODES must be canonical decimal numbers");
    }
    errno = 0;
#ifdef QB_BROKER_TESTING
    const char *trust_root = NULL, *policy_dir = NULL, *broker_dir = NULL, *socket_dir = NULL,
               *fake_dir = NULL;
    if (argc != 12 + values) return usage();
    for (int i = 2 + values; i < argc; i += 2) {
        const char **slot = !strcmp(argv[i], "--trust-root") ? &trust_root
                          : !strcmp(argv[i], "--policy-dir") ? &policy_dir
                          : !strcmp(argv[i], "--broker-dir") ? &broker_dir
                          : !strcmp(argv[i], "--socket-dir") ? &socket_dir
                          : !strcmp(argv[i], "--fake-dir") ? &fake_dir : NULL;
        if (!slot || *slot) return usage();
        *slot = argv[i + 1];
    }
    if (geteuid() == 0) return refuse("the TESTING build never runs as root");
    const uid_t owner = geteuid();
    int base = open(trust_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (base < 0) return refuse("trust root");
    /* paths below are relative to the trust root, written absolute ("/policy") */
#else
    if (argc != 2 + values) return usage();
    if (geteuid() != 0) return refuse("must run as root (installed system service)");
    const uid_t owner = 0;
    const char *policy_dir = POLICY_DIR, *broker_dir = BROKER_DIR, *socket_dir = SOCKET_DIR;
    int base = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (base < 0) return refuse("/");
#endif
    if (command != RECOVER_CUSTODY && custody.count) {
        errno = EOPNOTSUPP;
        return refuse("quota-only command refuses recovery custody");
    }
    /* 1. Policy: every ancestor root/owner-owned and not group/other-writable. */
    int pdir = open_chain(base, policy_dir, 0, owner, owner);
    if (pdir < 0) return refuse("policy directory (must be owner-owned, ancestors not group/other-writable)");
    if (command == RECOVER_CUSTODY) {
        if (custody_manifest(pdir, owner, &custody) < 0) return refuse("custody manifest UNKNOWN");
        if (custody_bind(owner, &custody) < 0) return refuse("custody identity UNKNOWN");
        close(pdir); close(base);
#ifdef QB_BROKER_TESTING
        /* Observation/barrier only in the fake executable: exercise the actual
         * main's accepted descriptors across death/reexec. No readiness, proof,
         * lifetime authority, reconciliation, reset or release is implied. */
        for (unsigned i = 0; i < custody.count; i++)
            printf("CUSTODY UNKNOWN %s %llu %llu\n", custody.id[i],
                   (unsigned long long)custody.device[i], (unsigned long long)custody.inode[i]);
        fflush(stdout);
        char byte;
        ssize_t ignored = read(STDIN_FILENO, &byte, 1);
        (void)ignored;
#endif
        for (unsigned i = 0; i < custody.count; i++) close(3 + (int)i);
        errno = EOPNOTSUPP;
        return refuse("recovery unavailable: manifest provisioning, FDSTORE barrier, reconciler and lifetime fence not composed");
    }
    struct qb_service_policy policy;
    unsigned int line = 0;
    errno = 0;
    if (qb_policy_load(pdir, POLICY_NAME, owner, &policy, &line) < 0) {
        if (errno == EPROTONOSUPPORT)
            return refuse("policy file is version 1 (user= lines); this broker reads version 2: users are "
                          "operator journal grants (--add-user). See docs/native-quota-broker-service.md, "
                          "Policy migration");
        char what[96];
        snprintf(what, sizeof(what), "policy file %s/%s (line %u)", policy_dir, POLICY_NAME, line);
        return refuse(what);
    }
    close(pdir);
#ifndef QB_BROKER_TESTING
    if (policy.gateway_uid == 0 || policy.workload_uid == 0) { errno = EINVAL; return refuse("policy principals"); }
#endif
    /* 2. Broker directory: its ancestors may be owned by root or the gateway (e.g. the XFS mount
     * root /mnt/step-work); the gateway can then rename it away (denial of service, caught by the
     * policy's root device/inode) but cannot create a root-owned substitute. */
    int bdir = open_chain(base, broker_dir, 0, (uid_t)policy.gateway_uid, owner);
    if (bdir < 0) return refuse("broker directory (must be owner-owned, not group/other-writable)");
    int root = beneath(bdir, "root", O_RDONLY | O_DIRECTORY);
    if (root < 0) return refuse("broker root directory");
    int state = beneath(bdir, "state", O_RDONLY | O_DIRECTORY);
    if (state < 0) return refuse("broker state directory");
    close(bdir);
    struct stat rs;
    if (fstat(root, &rs) < 0) return refuse("broker root");
    if ((uint64_t)rs.st_dev != policy.core.root_device || (uint64_t)rs.st_ino != policy.core.root_inode) {
        errno = ESTALE; return refuse("broker root is not the policy's root_device/root_inode");
    }
    if ((rs.st_mode & 07777) != 0710 || rs.st_uid != owner || rs.st_gid != policy.gateway_gid) {
        errno = EPERM; return refuse("broker root must be owner:gateway_gid mode 0710");
    }
    /* 3. Adapter: the live mount must match the policy (UUID, project accounting+enforcement). */
    struct qb_adapter adapter;
#ifdef QB_BROKER_TESTING
    struct fake fake = {.dir = -1};
    memcpy(fake.uuid, policy.core.mount_uuid, 16);
    int fbase = open_chain(base, fake_dir, 0, owner, owner);
    if (fbase < 0) return refuse("fake directory");
    fake.dir = fbase; fake_space_dir = fbase;
    adapter = (struct qb_adapter){&fake, fake_mount, fake_observe, fake_configure, fake_raise};
    uint8_t live[16]; int enforced = 0;
    if (fake_mount(&fake, root, live, &enforced) < 0) return refuse("fake mount");
    if (memcmp(live, policy.core.mount_uuid, 16)) { errno = EXDEV; return refuse("mount UUID differs from policy"); }
    if (!enforced) { errno = EDQUOT; return refuse("project quota not enforced"); }
#else
    struct qb_xfs *xfs = NULL;
    if (qb_xfs_open(root, &policy.core, &xfs, &adapter) < 0)
        return refuse("XFS adapter (mount UUID, writable XFS, project accounting+enforcement)");
#endif
    struct qb *broker = NULL;
    int status = 0;
    if (command == BOOTSTRAP) {
        if (empty(root) < 0) return refuse("bootstrap: broker root is not empty");
        if (empty(state) < 0) return refuse("bootstrap: state directory is not empty");
        if (qb_bootstrap(state, &policy.core) < 0) return refuse("bootstrap");
        if (qb_open(root, state, &policy.core, &adapter, &broker) < 0) return refuse("open after bootstrap");
        say("bootstrapped: empty journal bound to this policy");
    } else {
        if (qb_open(root, state, &policy.core, &adapter, &broker) < 0)
            return refuse("open broker state (not bootstrapped, policy changed, in use or damaged)");
        if (command == CHECK) say("check passed: policy, directories, mount and state are consistent");
    }
    if (command == ADD_USER) {
        struct qb_capacity c; uint32_t project = 0;
        if (qb_grant_add(broker, user, &project, &c) < 0) {
            int e = errno;
            if (e == EFBIG) print_capacity(&c);
            errno = e;
            status = refuse(e == EEXIST ? "add-user: already a user (a user is never granted twice)"
                          : e == EFBIG ? "add-user: overcommit (promised + reserve would exceed free space)"
                          : e == ENOSPC ? "add-user: project id range or user limit exhausted"
                          : "add-user");
            goto out;
        }
        fprintf(stderr, "step-quota-broker: added user %s: project %u, pool %llu B / %llu inodes "
                "(directory created at its first workspace)\n", user, project,
                (unsigned long long)policy.core.bytes_hard, (unsigned long long)policy.core.inodes_hard);
        print_capacity(&c);
    } else if (command == RAISE_USER) {
        struct qb_capacity c;
        if (qb_raise(broker, user, raise_bytes, raise_inodes, &c) < 0) {
            int e = errno;
            if (e == EFBIG) print_capacity(&c);
            errno = e;
            status = refuse(e == EINVAL ? "raise-user: limits may only increase (and stay within policy bounds)"
                          : e == ENOENT ? "raise-user: the user's pool is not allocated yet"
                          : e == EACCES ? "raise-user: unknown or revoked user"
                          : e == EFBIG ? "raise-user: overcommit (promised + reserve would exceed free space)"
                          : "raise-user (if the record was written, repeat the same command to apply it)");
            goto out;
        }
        fprintf(stderr, "step-quota-broker: raised user %s to %llu B / %llu inodes (recorded, set, read back)\n",
                user, (unsigned long long)raise_bytes, (unsigned long long)raise_inodes);
        if (c.users) print_capacity(&c);
    }
    if (command == SERVE) {
        int sdir = open_chain(base, socket_dir, 0, owner, owner);
        if (sdir < 0) { status = refuse("socket directory"); goto out; }
        int listener = listen_socket(sdir, (gid_t)policy.gateway_gid);
        if (listener < 0) { status = refuse("socket"); goto out; }
        sigset_t set;
        sigemptyset(&set); sigaddset(&set, SIGTERM); sigaddset(&set, SIGINT); sigaddset(&set, SIGHUP);
        if (sigprocmask(SIG_BLOCK, &set, NULL) < 0) { status = refuse("signals"); goto out; }
        signal(SIGPIPE, SIG_IGN);
        int stop = signalfd(-1, &set, SFD_NONBLOCK | SFD_CLOEXEC);
        if (stop < 0) { status = refuse("signalfd"); goto out; }
        notify_ready();
        printf("READY %s/%s\n", socket_dir, SOCKET_NAME);
        fflush(stdout);
        /* Serves until SIGTERM/SIGINT/SIGHUP; returns only after closing every client. */
        if (qb_transport_run(broker, listener, stop, (uid_t)policy.gateway_uid) < 0) {
            say("transport ended with an error");
            status = EXIT_RUNTIME;
        } else say("stopped");
        close(stop); close(listener); close(sdir);
    }
out:
    qb_close(broker); /* core before adapter */
#ifdef QB_BROKER_TESTING
    close(fake.dir);
#else
    qb_xfs_close(xfs);
#endif
    close(root); close(state); close(base);
    return status;
}
