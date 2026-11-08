#define _GNU_SOURCE
#include "launcher.h"
#include "exec-status.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/fs.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

const char *srl_error_name(int error) {
    switch (error) {
    case SRL_OK: return "ok";
    case SRL_E_USAGE: return "usage";
    case SRL_E_CREDENTIALS: return "credentials";
    case SRL_E_DESCRIPTORS: return "descriptors";
    case SRL_E_TRUSTED_PATH: return "trusted-path";
    case SRL_E_BROKER_ROOT: return "broker-root";
    case SRL_E_WORKSPACE: return "workspace";
    case SRL_E_DEVICE: return "device";
    case SRL_E_LOCATION: return "location";
    case SRL_E_PARENT: return "parent";
    case SRL_E_PROJECT: return "project";
    case SRL_E_FILES: return "files";
    case SRL_E_SOCKET: return "socket";
    default: return "internal";
    }
}

/* ---- request ---- */

static int is_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }
static int is_digit(char c) { return c >= '0' && c <= '9'; }

/* Canonical decimal: 1..max_len digits, no sign, no leading zero (so no overflow either). */
static int decimal(const char *s, size_t len, size_t max_len, unsigned long long *out) {
    if (len == 0 || len > max_len || s[0] == '0') return -1;
    unsigned long long v = 0;
    for (size_t i = 0; i < len; i++) {
        if (!is_digit(s[i])) return -1;
        v = v * 10 + (unsigned long long)(s[i] - '0');
    }
    *out = v;
    return 0;
}

static int canonical_uuid(const char *s) {
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return 0;
        } else if (!is_hex(s[i]))
            return 0;
    }
    return s[36] == 0;
}

/* snprintf into a fixed array; true on truncation or error. */
#define FMT(dst, ...) (snprintf((dst), sizeof(dst), __VA_ARGS__) >= (int)sizeof(dst))

int srl_parse(const struct srl_config *cfg, int argc, char *const argv[], struct srl_request *req) {
    memset(req, 0, sizeof *req);
    if (argc != 5 || !argv || !argv[1] || !argv[2] || !argv[3] || !argv[4] || argv[5]) return SRL_E_USAGE;
    if (strcmp(argv[1], "v1") != 0) return SRL_E_USAGE;

    /* p<ID>/<uuid>: exactly 'p', six digits, '/', a canonical lowercase UUID */
    const char *w = argv[2];
    if (strnlen(w, 64) != 1 + 6 + 1 + 36 || w[0] != 'p' || w[7] != '/') return SRL_E_USAGE;
    unsigned long long project;
    if (decimal(w + 1, 6, 6, &project) || project < SRL_PROJECT_FIRST || project > SRL_PROJECT_LAST)
        return SRL_E_USAGE;
    if (!canonical_uuid(w + 8)) return SRL_E_USAGE;
    req->project = (unsigned long)project;
    memcpy(req->uuid, w + 8, 36);

    /* launch id: 32 lowercase hex (names the gateway's socket directory) */
    const char *id = argv[3];
    if (strnlen(id, 34) != 32) return SRL_E_USAGE;
    for (size_t i = 0; i < 32; i++)
        if (!is_hex(id[i])) return SRL_E_USAGE;
    memcpy(req->launch_id, id, 32);

    /* tmpfs bytes: page-aligned, bounded */
    unsigned long long bytes;
    if (decimal(argv[4], strnlen(argv[4], 16), 10, &bytes) || bytes < SRL_TMPFS_MIN || bytes > SRL_TMPFS_MAX ||
        bytes % SRL_TMPFS_MIN)
        return SRL_E_USAGE;
    req->tmpfs_bytes = bytes;

    /* Everything else is derived from the fixed configuration. */
    char hex[33];
    size_t h = 0;
    for (size_t i = 0; i < 36; i++)
        if (req->uuid[i] != '-') hex[h++] = req->uuid[i];
    hex[h] = 0;
    if (FMT(req->tmpfs, "%llu", bytes) || FMT(req->workspace_id, "ws_%s", hex) ||
        FMT(req->user_dir, "%s/p%lu", cfg->broker_root, req->project) ||
        FMT(req->mount, "%s/%s", req->user_dir, req->uuid) || FMT(req->files, "%s/files", req->mount) ||
        FMT(req->socket_dir, "%s/%s", cfg->socket_root, req->launch_id) ||
        FMT(req->node_args[0], "file://%s/%s", cfg->app_root, SRL_TSX_LOADER) ||
        FMT(req->node_args[1], "file://%s/%s", cfg->app_root, SRL_REGISTER) ||
        FMT(req->node_args[2], "%s/%s", cfg->app_root, SRL_ENTRY) ||
        FMT(req->app_binds[0], "%s/node_modules", cfg->app_root) ||
        FMT(req->app_binds[1], "%s/server/src", cfg->app_root) ||
        FMT(req->app_binds[2], "%s/server/package.json", cfg->app_root) ||
        FMT(req->app_binds[3], "%s/package.json", cfg->app_root) ||
        FMT(req->app_binds[4], "%s/harness", cfg->app_root))
        return SRL_E_USAGE;
    return SRL_OK;
}

/* The one and only sandbox shape. Mirrors stepRunnerSandboxArgs() in
 * server/src/workspace/step-runner-driver.ts, except that the socket directory comes from fd 3
 * (server/test/step-runner-launcher.test.ts compares the two). */
int srl_build_argv(const struct srl_config *cfg, const struct srl_request *req, char *out[SRL_MAX_ARGS]) {
    int n = 0;
#define A(s)                                                                                       \
    do {                                                                                           \
        if (n >= SRL_MAX_ARGS - 1) return -1;                                                      \
        out[n++] = (char *)(s);                                                                    \
    } while (0)
#define RO(p)                                                                                      \
    do {                                                                                           \
        A("--ro-bind");                                                                            \
        A(p);                                                                                      \
        A(p);                                                                                      \
    } while (0)
#define ENV(k, v)                                                                                  \
    do {                                                                                           \
        A("--setenv");                                                                             \
        A(k);                                                                                      \
        A(v);                                                                                      \
    } while (0)
    A(cfg->bwrap);
    A("--clearenv");
    ENV("PATH", "/usr/local/bin:/usr/bin:/bin");
    ENV("LANG", "C.UTF-8");
    ENV("NODE_ENV", "production");
    ENV("STEP_WORKSPACE_ID", req->workspace_id);
    ENV("STEP_WORKSPACE_DIR", req->mount);
    ENV("STEP_SYNTHETIC_PROVIDER", "1");
    ENV("STEP_RUNTIME_TRANSPORT", "unix");
    A("--unshare-all");
    A("--unshare-user");
    A("--disable-userns");
    A("--die-with-parent");
    A("--new-session");
    A("--cap-drop");
    A("ALL");
    A("--proc");
    A("/proc");
    A("--dev");
    A("/dev");
    A("--size");
    A(req->tmpfs);
    A("--tmpfs");
    A("/tmp");
    RO("/usr");
    RO("/lib");
    RO("/lib64");
    RO("/bin");
    RO(cfg->node_dir);
    for (int i = 0; i < 5; i++) RO(req->app_binds[i]);
    A("--bind-fd");
    A("1");
    A(req->mount);
    A("--chdir");
    A(req->files);
    A("--ro-bind-fd");
    A("3");
    A(SRL_SANDBOX_SOCKET_DIR);
    A("--");
    A(cfg->node);
    A("--import");
    A(req->node_args[0]);
    A("--import");
    A(req->node_args[1]);
    A(req->node_args[2]);
#undef ENV
#undef RO
#undef A
    out[n] = NULL;
    return n;
}

int srl_project_ok(const struct srl_request *req, unsigned int projid, unsigned int xflags) {
    return projid == req->project && (xflags & FS_XFLAG_PROJINHERIT) != 0;
}

/* ---- process ---- */

int srl_check_credentials(const struct srl_config *cfg) {
    uid_t r, e, s;
    gid_t rg, eg, sg;
    if (getresuid(&r, &e, &s) || getresgid(&rg, &eg, &sg)) return SRL_E_CREDENTIALS;
    if (cfg->runner_uid == 0 || r != cfg->runner_uid || e != cfg->runner_uid || s != cfg->runner_uid)
        return SRL_E_CREDENTIALS;
    if (rg != cfg->runner_gid || eg != cfg->runner_gid || sg != cfg->runner_gid) return SRL_E_CREDENTIALS;
    if (cfg->check_groups) {
        gid_t groups[64];
        int count = getgroups(64, groups);
        if (count < 0) return SRL_E_CREDENTIALS;
        for (int i = 0; i < count; i++)
            if (groups[i] != cfg->runner_gid) return SRL_E_CREDENTIALS;
    }
    return SRL_OK;
}

/* Owned by root (or the testing stand-in), not group/other-writable, no setuid/setgid file. */
static int trusted_stat(const struct srl_config *cfg, const struct stat *st) {
    return (st->st_uid == 0 || st->st_uid == cfg->root_uid) && !(st->st_mode & (S_IWGRP | S_IWOTH)) &&
           !(S_ISREG(st->st_mode) && (st->st_mode & (S_ISUID | S_ISGID)));
}

/* The path and every ancestor up to "/" must be trusted; lstat, so no symlink anywhere. */
static int trusted_chain(const struct srl_config *cfg, const char *path, int want_dir) {
    char p[PATH_MAX];
    struct stat st;
    if (path[0] != '/' || FMT(p, "%s", path)) return 0;
    if (lstat(p, &st) || !trusted_stat(cfg, &st) || (want_dir ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)))
        return 0;
    const char *floor = cfg->trusted_floor ? cfg->trusted_floor : "/";
    while (strcmp(p, "/") != 0 && strcmp(p, floor) != 0) {
        char *slash = strrchr(p, '/');
        if (!slash) return 0;
        if (slash == p)
            p[1] = 0;
        else
            *slash = 0;
        if (lstat(p, &st) || !S_ISDIR(st.st_mode) || !trusted_stat(cfg, &st)) return 0;
    }
    return 1;
}

int srl_check_trusted_paths(const struct srl_config *cfg) {
    if (!trusted_chain(cfg, cfg->bwrap, 0) || !trusted_chain(cfg, cfg->node, 0) ||
        !trusted_chain(cfg, cfg->node_dir, 1) || !trusted_chain(cfg, cfg->app_root, 1))
        return SRL_E_TRUSTED_PATH;
    /* Each bind source is resolved on the host by bwrap, not inside its new root. Checking
     * only app_root lets a staged symlink expose another host directory read-only. */
    static const struct { const char *part; int directory; } binds[] = {
        {"node_modules", 1}, {"server/src", 1}, {"server/package.json", 0},
        {"package.json", 0}, {"harness", 1},
    };
    for (size_t i = 0; i < sizeof binds / sizeof *binds; i++) {
        char path[PATH_MAX];
        if (FMT(path, "%s/%s", cfg->app_root, binds[i].part) || !trusted_chain(cfg, path, binds[i].directory))
            return SRL_E_TRUSTED_PATH;
    }
    return SRL_OK;
}

static int fd_path_is(int fd, const char *want) {
    char link[64], got[PATH_MAX];
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, got, sizeof got);
    if (n <= 0 || (size_t)n >= sizeof got) return 0;
    got[n] = 0;
    return strcmp(got, want) == 0;
}

int srl_check_workspace_fd(const struct srl_config *cfg, const struct srl_request *req, int fd) {
    /* The broker tree: trusted top directory, root:gateway 0710 root/ on the same filesystem. */
    struct stat top, root;
    if (lstat(cfg->broker_dir, &top) || !S_ISDIR(top.st_mode) || !trusted_stat(cfg, &top))
        return SRL_E_BROKER_ROOT;
    if (lstat(cfg->broker_root, &root) || !S_ISDIR(root.st_mode) || root.st_uid != cfg->root_uid ||
        root.st_gid != cfg->gateway_gid || (root.st_mode & 07777) != 0710 || root.st_dev != top.st_dev)
        return SRL_E_BROKER_ROOT;

    /* The descriptor itself: an O_RDONLY directory, runner:gateway 02750 (the broker's shape). */
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || (flags & O_PATH) || (flags & O_ACCMODE) != O_RDONLY) return SRL_E_WORKSPACE;
    struct stat ws;
    if (fstat(fd, &ws) || !S_ISDIR(ws.st_mode) || ws.st_uid != cfg->runner_uid || ws.st_gid != cfg->gateway_gid ||
        (ws.st_mode & 07777) != 02750)
        return SRL_E_WORKSPACE;
    if (ws.st_dev != root.st_dev) return SRL_E_DEVICE;

    /* Its location, as the kernel reports it for this descriptor. Only root can rename inside root/
     * (0710, root-owned) and p<ID> (0750, root-owned), so it cannot move after this check. */
    if (!fd_path_is(fd, req->mount)) return SRL_E_LOCATION;

    /* Its parent: the user's pool directory p<ID>, root:gateway 0750, same filesystem. */
    int parent = openat(fd, "..", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (parent < 0) return SRL_E_PARENT;
    struct stat ps;
    int ok = !fstat(parent, &ps) && S_ISDIR(ps.st_mode) && ps.st_uid == cfg->root_uid &&
             ps.st_gid == cfg->gateway_gid && (ps.st_mode & 07777) == 0750 && ps.st_dev == root.st_dev &&
             fd_path_is(parent, req->user_dir);
    close(parent);
    if (!ok) return SRL_E_PARENT;

    /* The quota boundary itself, read from the descriptor: XFS project <ID> with inheritance. */
    if (cfg->check_projid) {
        struct fsxattr fa;
        memset(&fa, 0, sizeof fa);
        if (ioctl(fd, FS_IOC_FSGETXATTR, &fa) != 0 || !srl_project_ok(req, fa.fsx_projid, fa.fsx_xflags))
            return SRL_E_PROJECT;
    }

    /* files/ (the sandbox's working directory) must be a real runner-owned directory. */
    struct stat fs;
    if (fstatat(fd, "files", &fs, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(fs.st_mode) || fs.st_uid != cfg->runner_uid ||
        fs.st_dev != ws.st_dev)
        return SRL_E_FILES;
    return SRL_OK;
}

int srl_open_socket_dir(const struct srl_config *cfg, const struct srl_request *req) {
    /* The socket root's parent is trusted, so the gateway cannot swap the socket root itself. */
    char parent[PATH_MAX];
    if (FMT(parent, "%s", cfg->socket_root)) return SRL_E_SOCKET;
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) return SRL_E_SOCKET;
    *slash = 0;
    if (!trusted_chain(cfg, parent, 1)) return SRL_E_SOCKET;

    int rootfd = open(cfg->socket_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (rootfd < 0) return SRL_E_SOCKET;
    struct stat rs, ds;
    if (fstat(rootfd, &rs) || !S_ISDIR(rs.st_mode) || rs.st_uid != cfg->gateway_uid ||
        (rs.st_mode & 07777) != 0711) {
        close(rootfd);
        return SRL_E_SOCKET;
    }
    int dir = openat(rootfd, req->launch_id, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(rootfd);
    if (dir < 0) return SRL_E_SOCKET;
    if (fstat(dir, &ds) || !S_ISDIR(ds.st_mode) || ds.st_uid != cfg->gateway_uid || (ds.st_mode & 07777) != 0711 ||
        ds.st_dev != rs.st_dev || !fd_path_is(dir, req->socket_dir)) {
        close(dir);
        return SRL_E_SOCKET;
    }
    if (dir != SRL_SOCKET_FD) {
        int moved = dup2(dir, SRL_SOCKET_FD); /* the copy has no FD_CLOEXEC */
        close(dir);
        if (moved != SRL_SOCKET_FD) return SRL_E_SOCKET;
    } else if (fcntl(dir, F_SETFD, 0) != 0) {
        close(dir);
        return SRL_E_SOCKET;
    }
    return SRL_OK;
}

static void reset_signals(void) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    for (int sig = 1; sig < NSIG; sig++)
        if (sig != SIGKILL && sig != SIGSTOP) signal(sig, SIG_DFL);
}

static int launch_inner(const struct srl_config *cfg, int argc, char *const argv[], int service,
                        unsigned int *exec_error) {
    /* Legacy sudo entry still discards every inherited fd >= 3. Service entry
     * preserves ONLY the prevalidated fixed status socket, marked CLOEXEC. */
    for (int fd = 0; fd <= 2; fd++)
        if (fcntl(fd, F_GETFD) < 0) return SRL_E_DESCRIPTORS;
    if (service) {
        close(3);
        if (close_range(5, ~0U, 0) != 0) return SRL_E_DESCRIPTORS;
    } else if (close_range(3, ~0U, 0) != 0) return SRL_E_DESCRIPTORS;
    int rc;
    struct srl_request req;
    if ((rc = srl_parse(cfg, argc, argv, &req)) != SRL_OK) return rc;
    if ((rc = srl_check_credentials(cfg)) != SRL_OK) return rc;
    if ((rc = srl_check_trusted_paths(cfg)) != SRL_OK) return rc;
    if ((rc = srl_check_workspace_fd(cfg, &req, 1)) != SRL_OK) return rc;
    if ((rc = srl_open_socket_dir(cfg, &req)) != SRL_OK) return rc;
    char *args[SRL_MAX_ARGS];
    if (srl_build_argv(cfg, &req, args) < 0) return SRL_E_INTERNAL;
    /* fd 0 (the runtime's key) is never read here; bwrap consumes fds 1 and 3. */
    if (fcntl(0, F_SETFD, 0) || fcntl(1, F_SETFD, 0) || fcntl(2, F_SETFD, 0)) return SRL_E_DESCRIPTORS;
    reset_signals();
    char *const no_env[] = {NULL};
    if (service && srl_status_send(SRL_STATUS_VALIDATED, 0, 0)) return SRL_E_DESCRIPTORS;
    execve(cfg->bwrap, args, no_env);
    if (exec_error) *exec_error = (unsigned int)errno;
    return SRL_E_INTERNAL;
}

int srl_launch(const struct srl_config *cfg, int argc, char *const argv[]) {
    return launch_inner(cfg, argc, argv, 0, NULL);
}

int srl_launch_service(const struct srl_config *cfg, int argc, char *const argv[]) {
    /* Production cfg.root_uid is zero. SO_PEERCRED is captured when the trusted
     * service creates this socketpair, before forking and dropping privileges.
     * No argv/env selector can enable this path in the legacy executable. */
    if (srl_status_prepare(cfg->root_uid)) return SRL_E_DESCRIPTORS;
    if (srl_status_send(SRL_STATUS_ENTERED, 0, 0)) return SRL_E_DESCRIPTORS;
    unsigned int exec_error = 0;
    int rc = launch_inner(cfg, argc, argv, 1, &exec_error);
    (void)srl_status_send(SRL_STATUS_FAILED, (unsigned int)rc, exec_error);
    close(SRL_STATUS_FD);
    return rc;
}
