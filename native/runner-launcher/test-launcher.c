/* Unprivileged tests of the protected launcher: request validation, the fixed bwrap vector,
 * descriptor/location checks on a scratch copy of the production layout, and (with the TESTING
 * main and a fake bwrap) the exec contract: env cleared, stdin untouched, extra fds closed.
 *   usage: test-launcher ./launch-testing ./fake-bwrap ./launch-service-testing */
#define _GNU_SOURCE
#include "launcher.h"
#include "exec-status.h"
#include <arpa/inet.h>
#include <signal.h>
#include "testing-config.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures, checks;
#define CHECK(cond, ...)                                                                           \
    do {                                                                                           \
        checks++;                                                                                  \
        if (!(cond)) {                                                                             \
            failures++;                                                                            \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__);                                   \
            fprintf(stderr, __VA_ARGS__);                                                          \
            fputc('\n', stderr);                                                                   \
        }                                                                                          \
    } while (0)

#define UUID "0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1f"
#define UUID2 "11111111-2222-4333-8444-555555555555"
#define LAUNCH_ID "00112233445566778899aabbccddeeff"

static char prefix[PATH_MAX];
static struct srl_config cfg;
static struct srl_testing_paths paths;

static void path_of(char out[PATH_MAX], const char *rel) {
    int n = snprintf(out, PATH_MAX, "%s%s", prefix, rel);
    if (n <= 0 || n >= PATH_MAX) abort();
}
static void mkdir_mode(const char *rel, mode_t mode) {
    char p[PATH_MAX];
    path_of(p, rel);
    if (mkdir(p, 0700) != 0 && errno != EEXIST) {
        perror(p);
        exit(1);
    }
    if (chmod(p, mode) != 0) {
        perror(p);
        exit(1);
    }
}
static void chmod_rel(const char *rel, mode_t mode) {
    char p[PATH_MAX];
    path_of(p, rel);
    if (chmod(p, mode) != 0) abort();
}
static int open_rel(const char *rel, int flags) {
    char p[PATH_MAX];
    path_of(p, rel);
    return open(p, flags);
}
static void copy_file(const char *from, const char *rel) {
    char to[PATH_MAX], buf[65536];
    path_of(to, rel);
    int in = open(from, O_RDONLY | O_CLOEXEC);
    int out = open(to, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0755);
    if (in < 0 || out < 0) abort();
    ssize_t n;
    while ((n = read(in, buf, sizeof buf)) > 0)
        if (write(out, buf, (size_t)n) != n) abort();
    close(in);
    close(out);
}

#define WS "/mnt/step-work/step-ai-broker/root/p100000/" UUID
static void build_tree(const char *fake_bwrap) {
    static const char *dirs755[] = {"/usr", "/usr/bin", "/mnt", "/mnt/step-work", "/mnt/step-work/step-ai-broker",
                                    "/var", "/var/lib", "/var/lib/step-runner-launch", "/opt", "/opt/step",
                                    "/opt/step/app", "/opt/step/node", "/opt/step/node/bin", "/elsewhere",
                                    "/elsewhere/p100000"};
    for (size_t i = 0; i < sizeof dirs755 / sizeof *dirs755; i++) mkdir_mode(dirs755[i], 0755);
    mkdir_mode("/mnt/step-work/step-ai-broker/root", 0710);
    mkdir_mode("/mnt/step-work/step-ai-broker/root/p100000", 0750);
    mkdir_mode("/mnt/step-work/step-ai-broker/root/p100001", 0750);
    mkdir_mode(WS, 02750);
    mkdir_mode(WS "/files", 02750);
    mkdir_mode(WS "/snapshots", 02750);
    mkdir_mode("/mnt/step-work/step-ai-broker/root/p100000/" UUID2, 02750);
    mkdir_mode("/elsewhere/p100000/" UUID, 02750);
    mkdir_mode("/elsewhere/p100000/" UUID "/files", 02750);
    mkdir_mode("/var/lib/step-runner-launch/sockets", 0711);
    mkdir_mode("/var/lib/step-runner-launch/sockets/" LAUNCH_ID, 0711);
    copy_file(fake_bwrap, "/usr/bin/bwrap");
    copy_file(fake_bwrap, "/opt/step/node/bin/node");
    mkdir_mode("/opt/step/app/node_modules", 0755);
    mkdir_mode("/opt/step/app/server", 0755);
    mkdir_mode("/opt/step/app/server/src", 0755);
    mkdir_mode("/opt/step/app/harness", 0755);
    copy_file(fake_bwrap, "/opt/step/app/server/package.json");
    copy_file(fake_bwrap, "/opt/step/app/package.json");
}

static int parse(struct srl_request *req, const char *a1, const char *a2, const char *a3, const char *a4) {
    char *argv[] = {(char *)"launch", (char *)a1, (char *)a2, (char *)a3, (char *)a4, NULL};
    return srl_parse(&cfg, 5, argv, req);
}

static void test_parse(void) {
    struct srl_request r;
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "16777216") == SRL_OK, "valid request");
    char want[PATH_MAX];
    path_of(want, WS);
    CHECK(strcmp(r.mount, want) == 0, "mount %s", r.mount);
    path_of(want, WS "/files");
    CHECK(strcmp(r.files, want) == 0, "files %s", r.files);
    path_of(want, "/var/lib/step-runner-launch/sockets/" LAUNCH_ID);
    CHECK(strcmp(r.socket_dir, want) == 0, "socket %s", r.socket_dir);
    CHECK(strcmp(r.workspace_id, "ws_0f8e7d6c5b4a439281706a5b4c3d2e1f") == 0, "workspace id %s", r.workspace_id);
    CHECK(r.project == 100000 && r.tmpfs_bytes == 16777216ULL, "numbers");
    CHECK(parse(&r, "v1", "p199999/" UUID, LAUNCH_ID, "65536") == SRL_OK, "upper project, min tmpfs");
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "1073741824") == SRL_OK, "max tmpfs");

    static const char *bad[][4] = {
        {"v2", "p100000/" UUID, LAUNCH_ID, "65536"},
        {"V1", "p100000/" UUID, LAUNCH_ID, "65536"},
        {"v1 ", "p100000/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p99999/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p200000/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p0100000/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p100000" UUID, LAUNCH_ID, "65536"},
        {"v1", "p100000//" UUID, LAUNCH_ID, "65536"},
        {"v1", "/p100000/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p100000/" UUID "/", LAUNCH_ID, "65536"},
        {"v1", "p100000/" UUID "/files", LAUNCH_ID, "65536"},
        {"v1", "p100000/../p100001/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p100000/0F8E7D6C-5B4A-4392-8170-6A5B4C3D2E1F", LAUNCH_ID, "65536"},
        {"v1", "p100000/0f8e7d6c5b4a439281706a5b4c3d2e1f", LAUNCH_ID, "65536"},
        {"v1", "p100000/0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1", LAUNCH_ID, "65536"},
        {"v1", "p100000/0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1g", LAUNCH_ID, "65536"},
        {"v1", "p+100000/" UUID, LAUNCH_ID, "65536"},
        {"v1", "p100000/" UUID, "00112233445566778899aabbccddeef", "65536"},
        {"v1", "p100000/" UUID, "00112233445566778899aabbccddeeff0", "65536"},
        {"v1", "p100000/" UUID, "00112233445566778899AABBCCDDEEFF", "65536"},
        {"v1", "p100000/" UUID, "../../../../../../../../../../tmp", "65536"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "0"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "65535"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "65537"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "1073807360"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "065536"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "+65536"},
        {"v1", "p100000/" UUID, LAUNCH_ID, " 65536"},
        {"v1", "p100000/" UUID, LAUNCH_ID, "65536 "},
        {"v1", "p100000/" UUID, LAUNCH_ID, "18446744073709617152"},
        {"v1", "p100000/" UUID, LAUNCH_ID, ""},
        {"v1", "", LAUNCH_ID, "65536"},
    };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++)
        CHECK(parse(&r, bad[i][0], bad[i][1], bad[i][2], bad[i][3]) == SRL_E_USAGE, "refused #%zu (%s %s %s %s)", i,
              bad[i][0], bad[i][1], bad[i][2], bad[i][3]);

    char *few[] = {(char *)"launch", (char *)"v1", (char *)"p100000/" UUID, (char *)LAUNCH_ID, NULL};
    CHECK(srl_parse(&cfg, 4, few, &r) == SRL_E_USAGE, "missing argument");
    char *many[] = {(char *)"launch", (char *)"v1", (char *)"p100000/" UUID, (char *)LAUNCH_ID, (char *)"65536",
                    (char *)"--bind", NULL};
    CHECK(srl_parse(&cfg, 6, many, &r) == SRL_E_USAGE, "extra argument");
    char *none[] = {(char *)"launch", NULL};
    CHECK(srl_parse(&cfg, 1, none, &r) == SRL_E_USAGE, "no request");
    CHECK(srl_parse(&cfg, 0, none + 1, &r) == SRL_E_USAGE, "empty argv");
}

static int index_of(char *const v[], int n, const char *s, int from) {
    for (int i = from; i < n; i++)
        if (strcmp(v[i], s) == 0) return i;
    return -1;
}

static void test_argv(void) {
    struct srl_request r;
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "16777216") == SRL_OK, "parse");
    char *v[SRL_MAX_ARGS];
    int n = srl_build_argv(&cfg, &r, v);
    CHECK(n > 0 && n < SRL_MAX_ARGS && v[n] == NULL, "count %d", n);
    if (n <= 0) return;
    CHECK(strcmp(v[0], paths.bwrap) == 0, "argv0");
    int sep = index_of(v, n, "--", 1);
    CHECK(sep > 0 && index_of(v, n, "--", sep + 1) < 0, "exactly one --");
    /* The mandatory boundary flags, all before the program. */
    static const char *mandatory[] = {"--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent",
                                      "--clearenv", "--new-session"};
    for (size_t i = 0; i < sizeof mandatory / sizeof *mandatory; i++) {
        int at = index_of(v, n, mandatory[i], 1);
        CHECK(at > 0 && at < sep, "%s present before --", mandatory[i]);
    }
    CHECK(index_of(v, n, "--clearenv", 1) == 1, "--clearenv first, before any --setenv");
    int cap = index_of(v, n, "--cap-drop", 1);
    CHECK(cap > 0 && cap < sep && strcmp(v[cap + 1], "ALL") == 0, "--cap-drop ALL");
    static const char *forbidden[] = {"--share-user", "--userns", "--userns2", "--cap-add", "--uid", "--gid",
                                      "--bind", "--dev-bind", "--bind-try", "--share-net", "--remount-ro",
                                      "--exec-label", "--file-label", "--seccomp", "--add-seccomp-fd", "--sync-fd",
                                      "--info-fd", "--json-status-fd", "--userns-block-fd", "--block-fd",
                                      "--as-pid-1", "--chmod", "--symlink", "--overlay", "--perms"};
    for (size_t i = 0; i < sizeof forbidden / sizeof *forbidden; i++)
        CHECK(index_of(v, sep, forbidden[i], 1) < 0, "%s absent", forbidden[i]);
    /* The only writable mount is fd 1 at the requested mount point; the socket comes from fd 3. */
    int bfd = index_of(v, n, "--bind-fd", 1);
    CHECK(bfd > 0 && strcmp(v[bfd + 1], "1") == 0 && strcmp(v[bfd + 2], r.mount) == 0, "--bind-fd 1 <mount>");
    CHECK(index_of(v, n, "--bind-fd", bfd + 1) < 0, "one --bind-fd");
    int sfd = index_of(v, n, "--ro-bind-fd", 1);
    CHECK(sfd > 0 && strcmp(v[sfd + 1], "3") == 0 && strcmp(v[sfd + 2], SRL_SANDBOX_SOCKET_DIR) == 0,
          "--ro-bind-fd 3 /run/step-runtime");
    int chd = index_of(v, n, "--chdir", 1);
    CHECK(chd > 0 && strcmp(v[chd + 1], r.files) == 0, "--chdir files");
    int sz = index_of(v, n, "--size", 1);
    CHECK(sz > 0 && strcmp(v[sz + 1], "16777216") == 0 && strcmp(v[sz + 2], "--tmpfs") == 0 &&
              strcmp(v[sz + 3], "/tmp") == 0,
          "--size N --tmpfs /tmp");
    /* Every --ro-bind is a fixed path bound onto itself. */
    int ro = 0;
    for (int i = 1; i < sep; i++)
        if (strcmp(v[i], "--ro-bind") == 0) {
            ro++;
            CHECK(strcmp(v[i + 1], v[i + 2]) == 0, "ro-bind %s onto itself", v[i + 1]);
        }
    CHECK(ro == 10, "ten fixed read-only binds (%d)", ro);
    /* Environment: exactly the fixed set. */
    int envs = 0;
    for (int i = 1; i < sep; i++)
        if (strcmp(v[i], "--setenv") == 0) envs++;
    CHECK(envs == 7, "seven --setenv (%d)", envs);
    int wid = index_of(v, n, "STEP_WORKSPACE_ID", 1);
    CHECK(wid > 0 && strcmp(v[wid + 1], r.workspace_id) == 0, "workspace id env");
    int tr = index_of(v, n, "STEP_RUNTIME_TRANSPORT", 1);
    CHECK(tr > 0 && strcmp(v[tr + 1], "unix") == 0, "authenticated unix transport");
    /* Program: the fixed node and runtime entry. */
    CHECK(sep + 7 == n, "node + 5 fixed arguments after --");
    CHECK(strcmp(v[sep + 1], paths.node) == 0, "node path");
    CHECK(strcmp(v[sep + 2], "--import") == 0 && strcmp(v[sep + 4], "--import") == 0, "imports");
    CHECK(strncmp(v[sep + 3], "file://", 7) == 0 && strstr(v[sep + 3], SRL_TSX_LOADER), "tsx url %s", v[sep + 3]);
    CHECK(strcmp(v[sep + 6], paths.app_root) > 0 && strstr(v[sep + 6], SRL_ENTRY) != NULL, "entry %s", v[sep + 6]);
    /* Tokens straight from argv appear only inside derived, validated paths. */
    for (int i = 0; i < n; i++) CHECK(strcmp(v[i], LAUNCH_ID) != 0 && strcmp(v[i], UUID) != 0, "raw token at %d", i);
}

static void test_project(void) {
    struct srl_request r;
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "65536") == SRL_OK, "parse");
    CHECK(srl_project_ok(&r, 100000, 0x200), "project + PROJINHERIT");
    CHECK(!srl_project_ok(&r, 100000, 0), "PROJINHERIT cleared");
    CHECK(!srl_project_ok(&r, 0, 0x200), "project 0");
    CHECK(!srl_project_ok(&r, 100001, 0x200), "another user's project");
}

static int check_fd_rel(const char *request_path, const char *open_path, int flags) {
    struct srl_request r;
    if (parse(&r, "v1", request_path, LAUNCH_ID, "65536") != SRL_OK) return -1;
    int fd = open_path ? open_rel(open_path, flags) : open("/proc", O_RDONLY | O_DIRECTORY);
    if (fd < 0) return -2;
    int rc = srl_check_workspace_fd(&cfg, &r, fd);
    close(fd);
    return rc;
}

static void test_workspace_fd(void) {
    const int D = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_OK, "genuine workspace accepted");
    CHECK(check_fd_rel("p100000/" UUID2, WS, D) == SRL_E_LOCATION, "fd is another workspace than requested");
    CHECK(check_fd_rel("p100001/" UUID, WS, D) == SRL_E_LOCATION, "fd is in another pool than requested");
    CHECK(check_fd_rel("p100000/" UUID, WS "/files", D) == SRL_E_LOCATION, "files/ of a workspace refused");
    CHECK(check_fd_rel("p100000/" UUID, "/elsewhere/p100000/" UUID, D) == SRL_E_LOCATION,
          "same-shaped directory outside the broker root refused");
    CHECK(check_fd_rel("p100000/" UUID, NULL, 0) == SRL_E_WORKSPACE, "foreign directory (/proc) refused");
    CHECK(check_fd_rel("p100000/" UUID, WS, O_PATH | O_DIRECTORY | O_CLOEXEC) == SRL_E_WORKSPACE, "O_PATH refused");
    /* Not a directory. */
    {
        struct srl_request r;
        parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "65536");
        int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
        CHECK(srl_check_workspace_fd(&cfg, &r, fd) == SRL_E_WORKSPACE, "non-directory refused");
        close(fd);
        CHECK(srl_check_workspace_fd(&cfg, &r, 99) == SRL_E_WORKSPACE, "closed descriptor refused");
    }
    /* Right owner/mode/shape, but another filesystem (tmpfs). */
    {
        struct srl_request r;
        parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "65536");
        char shm[] = "/dev/shm/srl-device.XXXXXX";
        if (mkdtemp(shm)) {
            chmod(shm, 02750);
            int fd = open(shm, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
            CHECK(srl_check_workspace_fd(&cfg, &r, fd) == SRL_E_DEVICE, "directory on another filesystem refused");
            close(fd);
            rmdir(shm);
        } else
            CHECK(0, "mkdtemp in /dev/shm");
    }
    /* Exact modes. */
    chmod_rel(WS, 0750);
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_WORKSPACE, "workspace without setgid refused");
    chmod_rel(WS, 02770);
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_WORKSPACE, "group-writable workspace refused");
    chmod_rel(WS, 02750);
    chmod_rel("/mnt/step-work/step-ai-broker/root/p100000", 0755);
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_PARENT, "p<ID> with wrong mode refused");
    chmod_rel("/mnt/step-work/step-ai-broker/root/p100000", 0750);
    chmod_rel("/mnt/step-work/step-ai-broker/root", 0750);
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_BROKER_ROOT, "broker root with wrong mode refused");
    chmod_rel("/mnt/step-work/step-ai-broker/root", 0710);
    chmod_rel("/mnt/step-work/step-ai-broker", 0775);
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_BROKER_ROOT, "group-writable broker dir refused");
    chmod_rel("/mnt/step-work/step-ai-broker", 0755);
    /* files/ must be a real directory. */
    char files[PATH_MAX], moved[PATH_MAX];
    path_of(files, WS "/files");
    path_of(moved, WS "/files.real");
    CHECK(rename(files, moved) == 0 && symlink("files.real", files) == 0, "replace files/ by a symlink");
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_E_FILES, "files/ symlink refused");
    CHECK(unlink(files) == 0 && rename(moved, files) == 0, "restore files/");
    CHECK(check_fd_rel("p100000/" UUID, WS, D) == SRL_OK, "accepted again after restore");
}

static void test_socket_dir(void) {
    struct srl_request r;
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "65536") == SRL_OK, "parse");
    int saved = fcntl(SRL_SOCKET_FD, F_GETFD) >= 0 ? dup(SRL_SOCKET_FD) : -1;
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_OK, "socket dir accepted");
    int flags = fcntl(SRL_SOCKET_FD, F_GETFD);
    CHECK(flags >= 0 && !(flags & FD_CLOEXEC), "left open as fd 3 without CLOEXEC");
    char link[64], got[PATH_MAX];
    snprintf(link, sizeof link, "/proc/self/fd/%d", SRL_SOCKET_FD);
    ssize_t len = readlink(link, got, sizeof got - 1);
    CHECK(len > 0 && (got[len] = 0, strcmp(got, r.socket_dir) == 0), "fd 3 is the socket dir");
    close(SRL_SOCKET_FD);

    CHECK(parse(&r, "v1", "p100000/" UUID, "ffffffffffffffffffffffffffffffff", "65536") == SRL_OK, "parse");
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_E_SOCKET, "missing socket dir refused");
    char target[PATH_MAX], link2[PATH_MAX];
    path_of(target, "/var/lib/step-runner-launch/sockets/" LAUNCH_ID);
    path_of(link2, "/var/lib/step-runner-launch/sockets/ffffffffffffffffffffffffffffffff");
    CHECK(symlink(target, link2) == 0, "symlink");
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_E_SOCKET, "symlinked socket dir refused");
    unlink(link2);
    CHECK(parse(&r, "v1", "p100000/" UUID, LAUNCH_ID, "65536") == SRL_OK, "parse");
    chmod_rel("/var/lib/step-runner-launch/sockets/" LAUNCH_ID, 0755);
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_E_SOCKET, "socket dir with wrong mode refused");
    chmod_rel("/var/lib/step-runner-launch/sockets/" LAUNCH_ID, 0711);
    chmod_rel("/var/lib/step-runner-launch/sockets", 0731);
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_E_SOCKET, "group-writable socket root refused");
    chmod_rel("/var/lib/step-runner-launch/sockets", 0711);
    chmod_rel("/var/lib/step-runner-launch", 0777);
    CHECK(srl_open_socket_dir(&cfg, &r) == SRL_E_SOCKET, "writable socket root parent refused");
    chmod_rel("/var/lib/step-runner-launch", 0755);
    if (saved >= 0) {
        dup2(saved, SRL_SOCKET_FD);
        close(saved);
    }
}

static void test_trusted(void) {
    CHECK(srl_check_trusted_paths(&cfg) == SRL_OK, "trusted layout accepted");
    chmod_rel("/opt/step/app", 0775);
    CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "group-writable app root refused");
    chmod_rel("/opt/step/app", 0755);
    chmod_rel("/opt/step/node/bin/node", 0777);
    CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "writable node refused");
    chmod_rel("/opt/step/node/bin/node", 0755);
    chmod_rel("/opt", 0777);
    CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "writable ancestor refused");
    chmod_rel("/opt", 0755);
    chmod_rel("/usr/bin/bwrap", 04755);
    CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "setuid bwrap refused");
    chmod_rel("/usr/bin/bwrap", 0755);
    CHECK(srl_check_trusted_paths(&cfg) == SRL_OK, "accepted after restore");
    /* bwrap resolves read-only bind SOURCES on the host before isolation. A symlink here
     * would expose arbitrary host directories even though the app root itself is trusted. */
    static const char *binds[] = {"/opt/step/app/node_modules", "/opt/step/app/server/src",
                                  "/opt/step/app/harness", "/opt/step/app/server/package.json",
                                  "/opt/step/app/package.json"};
    for (size_t i = 0; i < sizeof binds / sizeof *binds; i++) {
        char original[PATH_MAX], moved[PATH_MAX], target[PATH_MAX];
        path_of(original, binds[i]);
        if (snprintf(moved, sizeof moved, "%s.real", original) >= (int)sizeof moved) abort();
        path_of(target, "/elsewhere");
        CHECK(rename(original, moved) == 0 && symlink(target, original) == 0, "substitute bind %s", binds[i]);
        CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "symlink bind source refused: %s", binds[i]);
        CHECK(unlink(original) == 0 && rename(moved, original) == 0, "restore bind %s", binds[i]);
        chmod_rel(binds[i], 0777);
        CHECK(srl_check_trusted_paths(&cfg) == SRL_E_TRUSTED_PATH, "writable bind source refused: %s", binds[i]);
        chmod_rel(binds[i], 0755);
    }
    CHECK(srl_check_trusted_paths(&cfg) == SRL_OK, "trusted bind sources restored");
}

/* ---- exec contract through the TESTING main and a fake bwrap ---- */
struct run {
    int status;
    char out[65536];
};
static const char nonce[] = "{\"path\":\"/run/step-runtime/rt.sock\",\"key\":\"\x01\x7f\xc3\xa9 nonce\"}\n";

static void run_launcher(const char *launcher, struct run *res, const char *ws_rel, char *const args[]) {
    int in[2], err[2];
    if (pipe(in) || pipe(err)) abort();
    if (write(in[1], nonce, sizeof nonce - 1) != (ssize_t)(sizeof nonce - 1)) abort();
    close(in[1]);
    pid_t pid = fork();
    if (pid < 0) abort();
    if (pid == 0) {
        int ws = ws_rel ? open_rel(ws_rel, O_RDONLY | O_DIRECTORY) : open("/dev/null", O_WRONLY);
        int extra = open("/dev/null", O_RDONLY); /* must not reach bwrap */
        if (ws < 0 || extra < 0) _exit(120);
        if (dup2(extra, 7) < 0 || dup2(in[0], 0) < 0 || dup2(ws, 1) < 0 || dup2(err[1], 2) < 0) _exit(121);
        char root_env[PATH_MAX + 16];
        snprintf(root_env, sizeof root_env, "SRL_TEST_ROOT=%s", prefix);
        char *env[] = {root_env, (char *)"NODE_OPTIONS=--require=/tmp/evil.js", (char *)"BASH_ENV=/tmp/evil",
                       (char *)"STEP_WORKSPACE_DIR=/", NULL};
        char *argv[8] = {(char *)launcher};
        for (int i = 0; args[i] && i < 6; i++) argv[i + 1] = args[i];
        execve(launcher, argv, env);
        _exit(122);
    }
    close(in[0]);
    close(err[1]);
    size_t used = 0;
    ssize_t n;
    while ((n = read(err[0], res->out + used, sizeof res->out - 1 - used)) > 0) used += (size_t)n;
    res->out[used] = 0;
    close(err[0]);
    if (waitpid(pid, &res->status, 0) != pid) abort();
}

static void test_service(const char *launcher, int mode) {
    int pair[2], diagnostics[2], bootstrap[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) ||
        pipe2(diagnostics, O_CLOEXEC) || pipe2(bootstrap, O_CLOEXEC)) abort();
    if (write(bootstrap[1], nonce, sizeof nonce - 1) != sizeof nonce - 1) abort();
    close(bootstrap[1]);
    pid_t pid = fork();
    if (pid < 0) abort();
    if (pid == 0) {
        int ws = open_rel(WS, O_RDONLY | O_DIRECTORY);
        int input = bootstrap[0];
        if (ws < 0 || input < 0 || dup2(ws, 1) < 0 || dup2(input, 0) < 0 ||
            dup2(pair[1], 4) < 0 || dup2(diagnostics[1], 2) < 0 || fcntl(4, F_SETFD, 0)) _exit(120);
        close(pair[0]);
        if (mode == 1) close(4); /* absent/closed fixed status FD */
        if (mode == 2) { int f = open("/dev/null", O_WRONLY); if (f < 0 || dup2(f, 4) < 0) _exit(120); }
        if (mode == 3) { int s[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, s) || dup2(s[1], 4) < 0) _exit(120); }
        if (mode == 8) { int f[2]; if (pipe(f) || dup2(f[1], 4) < 0) _exit(120); }
        if (mode == 9) { int s = socket(AF_UNIX, SOCK_SEQPACKET, 0); if (s < 0 || dup2(s, 4) < 0) _exit(120); }
        if (mode == 10) close(0);
        char root_env[PATH_MAX + 16];
        snprintf(root_env, sizeof root_env, "SRL_TEST_ROOT=%s", prefix);
        char *env[] = {root_env, NULL};
        char *args[] = {(char *)launcher, (char *)"v1", (char *)"p100000/" UUID,
                        (char *)LAUNCH_ID, (char *)"65536", NULL};
        if (mode == 4) args[4] = (char *)"65537";
        if (mode == 6) _exit(123); /* death before launcher exec/ENTERED */
        execve(mode == 7 ? "/nonexistent/srl-fixed-test-launcher" : launcher, args, env);
        (void)srl_status_send(SRL_STATUS_LAUNCH_EXEC_FAILED, 0, (unsigned int)errno);
        _exit(122);
    }
    close(pair[1]);
    close(diagnostics[1]);
    close(bootstrap[0]);
    struct srl_exec_status observation = {0};
    struct pollfd p = {.fd = pair[0], .events = POLLIN};
    CHECK(poll(&p, 1, 2000) > 0, "service status bounded wait");
    if (mode == 1 || mode == 2 || mode == 3 || mode == 6 || mode == 8 || mode == 9) {
        CHECK(srl_status_receive(pair[0], &observation) == 0 && observation.stage == 0,
              "no ack is UNKNOWN, not launcher/bwrap exec (%d)", mode);
    } else if (mode == 7) {
        CHECK(srl_status_receive(pair[0], &observation) == 1 &&
              observation.stage == SRL_STATUS_LAUNCH_EXEC_FAILED && observation.exec_errno == ENOENT,
              "launcher exec failed, distinct from bwrap exec failure");
    } else {
        CHECK(srl_status_receive(pair[0], &observation) == 1 && observation.stage == SRL_STATUS_ENTERED,
              "launcher entered ack before validation");
        CHECK(poll(&p, 1, 2000) > 0, "second status wait");
        CHECK(srl_status_receive(pair[0], &observation) == 1 &&
              observation.stage == (mode == 4 || mode == 10 ? SRL_STATUS_FAILED : SRL_STATUS_VALIDATED),
              "validation/failure ack survives cleanup (%d)", mode);
        if (mode == 4) CHECK(observation.error == SRL_E_USAGE && !observation.exec_errno,
                             "explicit validation refusal");
        if (mode == 10) CHECK(observation.error == SRL_E_DESCRIPTORS, "closed stdin validation failure");
        if (mode == 5) {
            CHECK(poll(&p, 1, 2000) > 0, "exec failure wait");
            CHECK(srl_status_receive(pair[0], &observation) == 1 &&
                  observation.stage == SRL_STATUS_FAILED && observation.error == SRL_E_INTERNAL &&
                  observation.exec_errno == EACCES, "explicit bwrap exec errno");
        }
        CHECK(poll(&p, 1, 2000) > 0 && srl_status_receive(pair[0], &observation) == 0,
              "ambiguous terminal after final frame");
        CHECK(mode != 0 || (observation.stage == SRL_STATUS_VALIDATED && observation.ambiguous_terminal),
              "bwrap exec candidate, NOT runtime-ready");
    }
    close(pair[0]);
    int status;
    if (waitpid(pid, &status, 0) != pid) abort();
    char output[16000];
    size_t used = 0;
    ssize_t n;
    while ((n = read(diagnostics[0], output + used, sizeof output - 1 - used)) > 0) used += (size_t)n;
    output[used] = 0;
    close(diagnostics[0]);
    if (mode == 0) CHECK(strstr(output, "extra_fds=0\n") && strstr(output, "envc=0\n"),
                         "service status FD never reaches fake bwrap; env empty");
    else CHECK(!strstr(output, "envc="), "refusal never executes bwrap");
    if (mode == 0) {
        char hex[sizeof nonce * 2 + 16] = "stdin=";
        for (size_t i = 0; i < sizeof nonce - 1; i++)
            snprintf(hex + strlen(hex), 3, "%02x", (unsigned char)nonce[i]);
        strcat(hex, "\n");
        CHECK(strstr(output, hex), "service preserves separate runtime nonce bootstrap unread");
    }
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == (mode == 0 ? 0 : mode == 6 ? 123 : mode == 7 ? 122 : 2),
          "service child exit (%d): %d", mode, status);
}

static void test_exec(const char *launcher) {
    struct run res;
    char *ok[] = {(char *)"v1", (char *)"p100000/" UUID, (char *)LAUNCH_ID, (char *)"16777216", NULL};
    run_launcher(launcher, &res, WS, ok);
    CHECK(WIFEXITED(res.status) && WEXITSTATUS(res.status) == 0, "fake bwrap ran (status %d): %s", res.status,
          res.out);
    CHECK(strstr(res.out, "envc=0\n") != NULL, "environment is empty at bwrap: %s", res.out);
    char want[PATH_MAX * 2];
    snprintf(want, sizeof want, "fd1=%s%s\n", prefix, WS);
    CHECK(strstr(res.out, want) != NULL, "fd 1 is the workspace");
    snprintf(want, sizeof want, "fd3=%s/var/lib/step-runner-launch/sockets/%s\n", prefix, LAUNCH_ID);
    CHECK(strstr(res.out, want) != NULL, "fd 3 is the socket dir");
    CHECK(strstr(res.out, "extra_fds=0\n") != NULL, "no other descriptor reaches bwrap");
    /* stdin unchanged: the fake reports it hex-encoded. */
    char hex[sizeof nonce * 2 + 16] = "stdin=";
    for (size_t i = 0; i < sizeof nonce - 1; i++)
        snprintf(hex + strlen(hex), 3, "%02x", (unsigned char)nonce[i]);
    strcat(hex, "\n");
    CHECK(strstr(res.out, hex) != NULL, "stdin passed through byte for byte");
    CHECK(strstr(res.out, "arg=--unshare-user\n") && strstr(res.out, "arg=--disable-userns\n"), "userns flags");
    CHECK(strstr(res.out, "evil") == NULL && strstr(res.out, "NODE_OPTIONS") == NULL, "caller env not passed");

    char *bad[] = {(char *)"v1", (char *)"p100000/" UUID, (char *)LAUNCH_ID, (char *)"65537", NULL};
    run_launcher(launcher, &res, WS, bad);
    CHECK(WIFEXITED(res.status) && WEXITSTATUS(res.status) == 2 && strstr(res.out, "REFUSED usage") &&
              !strstr(res.out, "envc="),
          "bad request refused before exec: %s", res.out);
    run_launcher(launcher, &res, WS "/files", ok);
    CHECK(WIFEXITED(res.status) && WEXITSTATUS(res.status) == 2 && strstr(res.out, "REFUSED location") &&
              !strstr(res.out, "envc="),
          "files/ as fd 1 refused before exec: %s", res.out);
    run_launcher(launcher, &res, NULL, ok);
    CHECK(WIFEXITED(res.status) && WEXITSTATUS(res.status) == 2 && strstr(res.out, "REFUSED workspace"),
          "non-directory fd 1 refused: %s", res.out);
    char *raw[] = {(char *)"--unshare-net", (char *)"--bind", (char *)"/", (char *)"/", NULL};
    run_launcher(launcher, &res, WS, raw);
    CHECK(WIFEXITED(res.status) && WEXITSTATUS(res.status) == 2 && strstr(res.out, "REFUSED usage"),
          "raw bwrap arguments refused: %s", res.out);
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s ./launch-testing ./fake-bwrap ./launch-service-testing\n", argv[0]);
        return 2;
    }
    if (getuid() == 0 || geteuid() == 0) {
        fprintf(stderr, "refusing to run as root\n");
        return 2;
    }
    char launcher[PATH_MAX], fake[PATH_MAX];
    if (!realpath(argv[1], launcher) || !realpath(argv[2], fake)) {
        perror("realpath");
        return 2;
    }
    const char *tmp = getenv("TMPDIR");
    snprintf(prefix, sizeof prefix, "%s/srl-test.XXXXXX", tmp && *tmp ? tmp : "/tmp");
    if (!mkdtemp(prefix)) {
        perror("mkdtemp");
        return 2;
    }
    if (chmod(prefix, 0755) != 0) return 2;
    if (srl_testing_config(prefix, &cfg, &paths) != 0) return 2;
    build_tree(fake);
    test_parse();
    test_argv();
    test_project();
    test_workspace_fd();
    test_socket_dir();
    test_trusted();
    test_exec(launcher);
    for (int mode = 0; mode <= 10; mode++) {
        if (mode == 5) chmod_rel("/usr/bin/bwrap", 0644);
        test_service(argv[3], mode);
        if (mode == 5) chmod_rel("/usr/bin/bwrap", 0755);
    }
    char cmd[PATH_MAX + 32];
    snprintf(cmd, sizeof cmd, "rm -rf -- '%s'", prefix);
    if (system(cmd) != 0) fprintf(stderr, "warning: could not remove %s\n", prefix);
    if (failures) {
        fprintf(stderr, "test-launcher: %d failure(s)\n", failures);
        return 1;
    }
    printf("test-launcher: all %d checks passed\n", checks);
    return 0;
}
