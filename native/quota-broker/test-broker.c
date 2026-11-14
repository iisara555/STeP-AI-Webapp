/* Unprivileged tests of the step-quota-broker main program (FAKE-adapter TESTING build):
 * policy/directory/mount refusal paths at startup, one-time bootstrap, and a real served
 * Unix socket. Refuses root. No quota/attribute syscall is executed by the fake build. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef NDEBUG
#error Tests require assertions
#endif
extern char **environ;

static const char *binary;
static char base[4096];
static int base_fd;
static const char *grant0 = "12345678-1234-4234-8234-000000000000";
static const char *grant1 = "12345678-1234-4234-8234-000000000001";
static const char *mount_uuid = "6b52590c-aed0-4f2e-bcb1-204a09a49304";

static void put(const char *name, const char *text, mode_t mode) {
    (void)unlinkat(base_fd, name, 0);
    int fd = openat(base_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600); assert(fd >= 0);
    assert(write(fd, text, strlen(text)) == (ssize_t)strlen(text));
    assert(fchmod(fd, mode) == 0); close(fd);
}
static char *slurp(const char *name) {
    static char text[8192];
    int fd = openat(base_fd, name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { text[0] = 0; return text; }
    ssize_t n = read(fd, text, sizeof(text) - 1); assert(n >= 0); text[n] = 0; close(fd);
    return text;
}
/* Policy with root device/inode of broker/root; `extra` replaces nothing, it is appended. */
static void policy(const char *override_key, const char *override_line, mode_t mode) {
    struct stat s; assert(fstatat(base_fd, "broker/root", &s, 0) == 0);
    char text[4096];
    char lines[13][160];
    snprintf(lines[0], 160, "version=2\n");
    snprintf(lines[1], 160, "epoch=00112233445566778899aabbccddeeff\n");
    snprintf(lines[2], 160, "mount_uuid=%s\n", mount_uuid);
    snprintf(lines[3], 160, "root_device=%llu\n", (unsigned long long)s.st_dev);
    snprintf(lines[4], 160, "root_inode=%llu\n", (unsigned long long)s.st_ino);
    snprintf(lines[5], 160, "bytes_hard=16106127360\n");
    snprintf(lines[6], 160, "inodes_hard=750000\n");
    snprintf(lines[7], 160, "first_project=100000\n");
    snprintf(lines[8], 160, "last_project=100009\n");
    snprintf(lines[9], 160, "gateway_uid=%u\n", (unsigned)geteuid());
    snprintf(lines[10], 160, "gateway_gid=%u\n", (unsigned)getegid());
    snprintf(lines[11], 160, "workload_uid=%u\n", (unsigned)geteuid());
    snprintf(lines[12], 160, "reserve_bytes=0\n");
    size_t used = (size_t)snprintf(text, sizeof(text), "# test policy (placeholder 15 GiB / 750000 inodes per user)\n");
    for (int i = 0; i < 13; i++) {
        const char *l = lines[i];
        if (override_key && !strncmp(l, override_key, strlen(override_key))) l = override_line;
        used += (size_t)snprintf(text + used, sizeof(text) - used, "%s", l);
    }
    put("policy/policy", text, mode);
}
static int run_values(const char *command, const char *v1, const char *v2, const char *v3,
                      const char *socket_dir, pid_t *spawned) {
    const char *argv[17]; int n = 0;
    argv[n++] = binary; argv[n++] = command;
    if (v1) argv[n++] = v1;
    if (v2) argv[n++] = v2;
    if (v3) argv[n++] = v3;
    const char *rest[] = {"--trust-root", base, "--policy-dir", "/policy", "--broker-dir", "/broker",
                          "--socket-dir", socket_dir, "--fake-dir", "/fake", NULL};
    for (int i = 0; rest[i]; i++) argv[n++] = rest[i];
    argv[n] = NULL;
    posix_spawn_file_actions_t actions;
    assert(posix_spawn_file_actions_init(&actions) == 0);
    char out[4200], err[4200];
    snprintf(out, sizeof(out), "%s/out", base); snprintf(err, sizeof(err), "%s/err", base);
    assert(posix_spawn_file_actions_addopen(&actions, 1, out, O_WRONLY | O_CREAT | O_TRUNC, 0600) == 0);
    assert(posix_spawn_file_actions_addopen(&actions, 2, err, O_WRONLY | O_CREAT | O_TRUNC, 0600) == 0);
    pid_t pid;
    assert(posix_spawn(&pid, binary, &actions, NULL, (char **)argv, environ) == 0);
    posix_spawn_file_actions_destroy(&actions);
    if (spawned) { *spawned = pid; return 0; }
    int status; assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status));
    return WEXITSTATUS(status);
}
static int run_for(const char *command, const char *socket_dir, pid_t *spawned) {
    return run_values(command, NULL, NULL, NULL, socket_dir, spawned);
}
static int run(const char *command) { return run_for(command, "/run0", NULL); }
static int add_user(const char *user) { return run_values("--add-user", user, NULL, NULL, "/run0", NULL); }
static int raise_user(const char *user, const char *bytes, const char *inodes) {
    return run_values("--raise-user", user, bytes, inodes, "/run0", NULL);
}
static void expect_rc(int rc, int want, const char *message, const char *label) {
    const char *err = slurp("err");
    if (rc != want || (message && !strstr(err, message))) {
        fprintf(stderr, "%s: rc=%d (want %d) stderr=%s\n", label, rc, want, err); assert(0);
    }
}
static void expect_refused(const char *command, const char *message, const char *label) {
    int rc = run(command);
    const char *err = slurp("err");
    if (rc != 2 || !strstr(err, "REFUSED") || (message && !strstr(err, message))) {
        fprintf(stderr, "%s: rc=%d stderr=%s\n", label, rc, err); assert(0);
    }
}
static int remove_item(const char *p, const struct stat *s, int t, struct FTW *w) {
    (void)s; (void)t; (void)w; return remove(p);
}
static void fixture(void) {
    const char *tmp = getenv("TMPDIR"); assert(tmp && tmp[0] == '/');
    int n = snprintf(base, sizeof(base), "%s/qbs-XXXXXX", tmp);
    assert(n > 0 && (size_t)n < sizeof(base) && mkdtemp(base));
    base_fd = open(base, O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(base_fd >= 0);
    assert(mkdirat(base_fd, "policy", 0755) == 0 && fchmodat(base_fd, "policy", 0755, 0) == 0);
    assert(mkdirat(base_fd, "broker", 0755) == 0 && fchmodat(base_fd, "broker", 0755, 0) == 0);
    assert(mkdirat(base_fd, "broker/root", 0710) == 0 && fchmodat(base_fd, "broker/root", 0710, 0) == 0);
    assert(mkdirat(base_fd, "broker/state", 0700) == 0);
    assert(mkdirat(base_fd, "fake", 0700) == 0);
    assert(mkdirat(base_fd, "run0", 0700) == 0);
}
static int connect_to(const char *socket_dir) {
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    int n = snprintf(a.sun_path, sizeof(a.sun_path), "%s%s/broker.sock", base, socket_dir);
    assert(n > 0 && (size_t)n < sizeof(a.sun_path));
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0); assert(fd >= 0);
    assert(connect(fd, (struct sockaddr *)&a, sizeof(a)) == 0);
    return fd;
}
static void exchange(const char *socket_dir, const char *frame, size_t size, char *reply, size_t cap) {
    int fd = connect_to(socket_dir);
    assert(send(fd, frame, size, MSG_NOSIGNAL) == (ssize_t)size && shutdown(fd, SHUT_WR) == 0);
    size_t used = 0;
    for (;;) {
        struct pollfd p = {fd, POLLIN, 0}; assert(poll(&p, 1, 3000) > 0);
        ssize_t got = recv(fd, reply + used, cap - 1 - used, 0);
        if (got < 0 && errno == ECONNRESET) break;
        assert(got >= 0);
        if (!got) break;
        used += (size_t)got; assert(used < cap - 1);
    }
    reply[used] = 0; close(fd);
}
static void ensure(const char *socket_dir, const char *workspace, char *reply, size_t cap) {
    char frame[64]; int n = snprintf(frame, sizeof(frame), "ENSURE/1 %s\n", workspace); assert(n == 46);
    exchange(socket_dir, frame, 46, reply, cap);
}
static pid_t serve(const char *socket_dir) {
    pid_t pid; run_for("--serve", socket_dir, &pid);
    for (int i = 0; i < 500; i++) {
        if (strstr(slurp("out"), "READY")) return pid;
        int status;
        if (waitpid(pid, &status, WNOHANG) == pid) {
            fprintf(stderr, "serve exited early: %s\n", slurp("err")); assert(0);
        }
        struct timespec t = {0, 10000000}; nanosleep(&t, NULL);
    }
    assert(!"broker never became ready");
    return -1;
}
static void stop(pid_t pid) {
    assert(kill(pid, SIGTERM) == 0);
    int status; assert(waitpid(pid, &status, 0) == pid);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static void expect_ok(const char *reply, unsigned int project, struct stat *dir) {
    char name[32]; snprintf(name, sizeof(name), "broker/root/p%u", project);
    assert(fstatat(base_fd, name, dir, AT_SYMLINK_NOFOLLOW) == 0);
    char expected[200];
    snprintf(expected, sizeof(expected), "OK/2 %u %llu %llu 16106127360 750000 %s\n", project,
             (unsigned long long)dir->st_dev, (unsigned long long)dir->st_ino, mount_uuid);
    if (strcmp(reply, expected)) { fprintf(stderr, "reply %s expected %s", reply, expected); assert(0); }
}

static void usage_and_policy_refusals(void) {
    posix_spawn_file_actions_t quiet;
    assert(posix_spawn_file_actions_init(&quiet) == 0);
    assert(posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0) == 0);
    const char *argv[] = {binary, NULL};
    pid_t pid; int status;
    assert(posix_spawn(&pid, binary, &quiet, NULL, (char **)argv, environ) == 0);
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 2);
    const char *argv2[] = {binary, "--serve", "--policy-dir", "/etc", NULL};
    assert(posix_spawn(&pid, binary, &quiet, NULL, (char **)argv2, environ) == 0);
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 2);
    posix_spawn_file_actions_destroy(&quiet);

    expect_refused("--check", "policy file", "missing policy");
    policy(NULL, NULL, 0664); expect_refused("--check", "policy file", "group-writable policy file");
    policy(NULL, NULL, 0640); expect_refused("--check", "policy file", "0640 policy file");
    policy("version=", "version=2\ncolour=blue\n", 0644);
    expect_refused("--check", "line 3", "unknown key");
    policy("bytes_hard=", "bytes_hard=1\n", 0644); expect_refused("--check", "policy file", "byte limit range");
    policy("inodes_hard=", "inodes_hard=10000001\n", 0644); expect_refused("--check", "policy file", "inode range");
    policy("first_project=", "first_project=424242\n", 0644); expect_refused("--check", "policy file", "project range");
    /* Version 1 (users listed in the policy) is refused with a pointer to the migration. */
    policy("version=", "version=1\n", 0644); expect_refused("--check", "version 1", "policy version 1");
    policy("reserve_bytes=", "reserve_bytes=0\nuser=12345678-1234-4234-8234-000000000000\n", 0644);
    expect_refused("--check", "Policy migration", "user= line");
    policy("reserve_bytes=", "", 0644); expect_refused("--check", "policy file", "missing reserve");
    policy(NULL, NULL, 0644);
    assert(fchmodat(base_fd, "policy", 0775, 0) == 0);
    expect_refused("--check", "policy directory", "group-writable policy dir");
    assert(fchmodat(base_fd, "policy", 0755, 0) == 0);
    assert(fchmod(base_fd, 0770) == 0);
    expect_refused("--check", "policy directory", "group-writable trust ancestor");
    assert(fchmod(base_fd, 0700) == 0);
    assert(renameat(base_fd, "policy/policy", base_fd, "real-policy") == 0);
    assert(symlinkat("../real-policy", base_fd, "policy/policy") == 0);
    expect_refused("--check", "policy file", "symlinked policy");
    assert(unlinkat(base_fd, "policy/policy", 0) == 0);
    assert(renameat(base_fd, "real-policy", base_fd, "policy/policy") == 0);
}
static void directory_and_mount_refusals(void) {
    expect_refused("--check", "open broker state", "not bootstrapped (check)");
    expect_refused("--serve", "open broker state", "serve never bootstraps");
    assert(fchmodat(base_fd, "broker/root", 0700, 0) == 0);
    expect_refused("--bootstrap", "0710", "root 0700");
    assert(fchmodat(base_fd, "broker/root", 0711, 0) == 0);
    expect_refused("--bootstrap", "0710", "root 0711");
    assert(fchmodat(base_fd, "broker/root", 0710, 0) == 0);
    assert(fchmodat(base_fd, "broker", 0775, 0) == 0);
    expect_refused("--bootstrap", "broker directory", "group-writable broker dir");
    assert(fchmodat(base_fd, "broker", 0755, 0) == 0);
    policy("root_inode=", "root_inode=1\n", 0644);
    expect_refused("--bootstrap", "root_inode", "root identity mismatch");
    policy(NULL, NULL, 0644);
    put("fake/mount-uuid", "6b52590c-aed0-4f2e-bcb1-204a09a49305\n", 0600);
    expect_refused("--bootstrap", "mount UUID", "mount UUID mismatch");
    assert(unlinkat(base_fd, "fake/mount-uuid", 0) == 0);
    put("fake/not-enforced", "", 0600);
    expect_refused("--bootstrap", "not enforced", "quota not enforced");
    assert(unlinkat(base_fd, "fake/not-enforced", 0) == 0);
    assert(mkdirat(base_fd, "broker/root/p100000", 0700) == 0);
    expect_refused("--bootstrap", "root is not empty", "non-empty root");
    assert(unlinkat(base_fd, "broker/root/p100000", AT_REMOVEDIR) == 0);
    put("broker/state/leftover", "", 0600);
    expect_refused("--bootstrap", "state directory is not empty", "non-empty state");
    assert(unlinkat(base_fd, "broker/state/leftover", 0) == 0);
    struct stat s; assert(fstatat(base_fd, "broker/state/manifest", &s, 0) < 0 && errno == ENOENT);
}
static void bootstrap_once(void) {
    assert(run("--bootstrap") == 0 && strstr(slurp("err"), "bootstrapped"));
    expect_refused("--bootstrap", "not empty", "second bootstrap");
    assert(run("--check") == 0 && strstr(slurp("err"), "check passed"));
    policy("bytes_hard=", "bytes_hard=21474836480\n", 0644); /* a raise is not a policy edit */
    expect_refused("--check", "open broker state", "policy changed after bootstrap");
    expect_refused("--serve", "open broker state", "serve with changed policy");
    policy(NULL, NULL, 0644);
    assert(run("--check") == 0);
}
static void socket_refusals(void) {
    assert(fchmodat(base_fd, "run0", 0755, 0) == 0);
    expect_refused("--serve", "socket", "socket dir 0755");
    assert(fchmodat(base_fd, "run0", 0700, 0) == 0);
    put("run0/broker.sock", "", 0600);
    expect_refused("--serve", "socket", "leftover socket never unlinked");
    struct stat s; assert(fstatat(base_fd, "run0/broker.sock", &s, 0) == 0 && S_ISREG(s.st_mode));
    assert(unlinkat(base_fd, "run0/broker.sock", 0) == 0);
    int rc = run_for("--serve", "/missing", NULL);
    assert(rc == 2 && strstr(slurp("err"), "socket directory"));
}
static void operator_add_users(void) {
    /* Strict operator values, refused before anything is opened. */
    const char *argv[] = {binary, "--add-user", NULL};
    posix_spawn_file_actions_t quiet;
    assert(posix_spawn_file_actions_init(&quiet) == 0);
    assert(posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0) == 0);
    pid_t pid; int status;
    assert(posix_spawn(&pid, binary, &quiet, NULL, (char **)argv, environ) == 0);
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 2);
    posix_spawn_file_actions_destroy(&quiet);
    expect_rc(add_user("12345678-1234-4234-8234-00000000000G"), 2, "canonical", "non-canonical uuid");
    expect_rc(add_user("../../etc/passwd"), 2, "canonical", "path as uuid");
    expect_rc(raise_user(grant0, "01", "1"), 2, "decimal", "non-canonical decimal");
    expect_rc(raise_user(grant0, "-1", "1"), 2, "decimal", "negative");
    /* No overcommit against (fake) free space: 2 x 15 GiB fit exactly, a third does not. */
    put("fake/available", "32212254720\n", 0600);
    expect_rc(add_user(grant0), 0, "added user 12345678-1234-4234-8234-000000000000: project 100000", "add 0");
    assert(strstr(slurp("err"), "capacity: 1 users promise 16106127360 B + reserve 0 B, 32212254720 B free"));
    expect_rc(add_user(grant0), 2, "already a user", "duplicate add");
    expect_rc(add_user(grant1), 0, "project 100001", "add 1");
    expect_rc(add_user("12345678-1234-4234-8234-000000000002"), 2, "overcommit", "overcommit add");
    assert(strstr(slurp("err"), "3 users promise 48318382080 B"));
    assert(unlinkat(base_fd, "fake/available", 0) == 0);
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 2, "not allocated", "raise before allocation");
    /* The policy is unchanged by adding users (users are journal state). */
    assert(run("--check") == 0);
}
static const char *ws_a = "aaaaaaaa-0000-4000-8000-000000000001";
static const char *ws_b = "bbbbbbbb-0000-4000-8000-000000000002";
static void workspace(const char *socket_dir, const char *user, const char *ws, char *reply, size_t cap) {
    char frame[128]; int n = snprintf(frame, sizeof(frame), "WORKSPACE/1 %s %s\n", user, ws); assert(n == 86);
    exchange(socket_dir, frame, 86, reply, cap);
}
static void expect_workspace(const char *reply, unsigned int project, const char *ws, struct stat *dir) {
    char name[96]; struct stat user;
    snprintf(name, sizeof(name), "broker/root/p%u", project);
    assert(fstatat(base_fd, name, &user, AT_SYMLINK_NOFOLLOW) == 0);
    snprintf(name, sizeof(name), "broker/root/p%u/%s", project, ws);
    assert(fstatat(base_fd, name, dir, AT_SYMLINK_NOFOLLOW) == 0);
    char expected[256];
    snprintf(expected, sizeof(expected), "OK/3 %u %llu %llu %llu 16106127360 750000 %s\n", project,
             (unsigned long long)dir->st_dev, (unsigned long long)user.st_ino,
             (unsigned long long)dir->st_ino, mount_uuid);
    if (strcmp(reply, expected)) { fprintf(stderr, "reply %s expected %s", reply, expected); assert(0); }
}
static void serve_and_restart(void) {
    assert(mkdirat(base_fd, "run1", 0700) == 0);
    pid_t pid = serve("/run1");
    struct stat s;
    assert(fstatat(base_fd, "run1", &s, 0) == 0 && (s.st_mode & 07777) == 0710 && s.st_gid == getegid());
    assert(fstatat(base_fd, "run1/broker.sock", &s, AT_SYMLINK_NOFOLLOW) == 0);
    assert(S_ISSOCK(s.st_mode) && (s.st_mode & 07777) == 0660 && s.st_gid == getegid());
    char reply[256]; struct stat dir, again, wa, wb;
    char usage[64]; snprintf(usage, sizeof(usage), "USAGE/1 %s\n", grant0);
    exchange("/run1", usage, 45, reply, sizeof(reply));
    assert(!strcmp(reply, "DENIED/1\n")); /* usage never allocates */
    /* The user's pool: broker-owned 0750, one project per user. */
    ensure("/run1", grant0, reply, sizeof(reply)); expect_ok(reply, 100000, &dir);
    assert((dir.st_mode & 07777) == 0750 && dir.st_uid == geteuid() && dir.st_gid == getegid());
    /* Workspaces inside the pool, handed to the workload. */
    workspace("/run1", grant0, ws_a, reply, sizeof(reply)); expect_workspace(reply, 100000, ws_a, &wa);
    assert((wa.st_mode & 07777) == 02750 && wa.st_uid == geteuid() && wa.st_gid == getegid());
    char name[128];
    snprintf(name, sizeof(name), "broker/root/p100000/%s/files", ws_a);
    assert(fstatat(base_fd, name, &s, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(s.st_mode) && (s.st_mode & 07777) == 02750);
    snprintf(name, sizeof(name), "broker/root/p100000/%s/snapshots", ws_a);
    assert(fstatat(base_fd, name, &s, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(s.st_mode) && (s.st_mode & 07777) == 02750);
    workspace("/run1", grant0, ws_b, reply, sizeof(reply)); expect_workspace(reply, 100000, ws_b, &wb);
    assert(wb.st_ino != wa.st_ino);
    workspace("/run1", grant0, ws_a, reply, sizeof(reply)); expect_workspace(reply, 100000, ws_a, &again);
    assert(again.st_ino == wa.st_ino);
    ensure("/run1", grant0, reply, sizeof(reply)); expect_ok(reply, 100000, &again);
    assert(again.st_ino == dir.st_ino);
    /* Usage reporting (fake usage written by the test, as XFS would account it). */
    put("fake/u100000", "12884901888 600000\n", 0600); /* 80% of bytes and inodes */
    exchange("/run1", usage, 45, reply, sizeof(reply));
    assert(!strcmp(reply, "USAGE/1 100000 12884901888 16106127360 600000 750000\n"));
    ensure("/run1", "12345678-1234-4234-8234-0000000000ff", reply, sizeof(reply));
    assert(!strcmp(reply, "DENIED/1\n"));
    workspace("/run1", "12345678-1234-4234-8234-0000000000ff", ws_a, reply, sizeof(reply));
    assert(!strcmp(reply, "DENIED/1\n"));
    exchange("/run1", "ENSURE/1 /etc/passwd\n", 21, reply, sizeof(reply));
    assert(!strcmp(reply, "DENIED/1\n"));
    /* A second broker cannot open the same state (exclusive journal lock). */
    assert(mkdirat(base_fd, "run2", 0700) == 0);
    expect_refused("--check", "in use", "second instance");
    stop(pid);
    assert(strstr(slurp("err"), "stopped"));
    /* Restart (fresh runtime directory as systemd provides): allocations persisted. */
    pid = serve("/run2");
    workspace("/run2", grant0, ws_a, reply, sizeof(reply)); expect_workspace(reply, 100000, ws_a, &again);
    assert(again.st_ino == wa.st_ino);
    workspace("/run2", grant1, ws_a, reply, sizeof(reply)); expect_workspace(reply, 100001, ws_a, &again);
    assert(again.st_ino != wa.st_ino); /* same workspace UUID under another user is another dir */
    /* Changed boundary modes: denied, not repaired. */
    snprintf(name, sizeof(name), "broker/root/p100000/%s", ws_a);
    assert(fchmodat(base_fd, name, 02770, 0) == 0);
    workspace("/run2", grant0, ws_a, reply, sizeof(reply)); assert(!strcmp(reply, "DENIED/1\n"));
    assert(fchmodat(base_fd, name, 02750, 0) == 0);
    assert(fchmodat(base_fd, "broker/root/p100000", 0755, 0) == 0);
    ensure("/run2", grant0, reply, sizeof(reply)); assert(!strcmp(reply, "DENIED/1\n"));
    assert(fchmodat(base_fd, "broker/root/p100000", 0750, 0) == 0);
    workspace("/run2", grant0, ws_a, reply, sizeof(reply)); expect_workspace(reply, 100000, ws_a, &again);
    stop(pid);
}
static void operator_raise(void) {
    char reply[256], usage[64]; struct stat dir;
    snprintf(usage, sizeof(usage), "USAGE/1 %s\n", grant0);
    assert(mkdirat(base_fd, "run3", 0700) == 0);
    pid_t pid = serve("/run3");
    /* Never while the service holds the journal; never over the gateway socket. */
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 2, "in use", "raise while serving");
    expect_rc(add_user("12345678-1234-4234-8234-000000000003"), 2, "in use", "add while serving");
    char frame[96];
    int n = snprintf(frame, sizeof(frame), "RAISE/1 %s 21474836480 1000000\n", grant0);
    exchange("/run3", frame, (size_t)n, reply, sizeof(reply)); assert(!strcmp(reply, "DENIED/1\n"));
    stop(pid);
    expect_rc(raise_user(grant0, "16106123264", "1000000"), 2, "only increase", "lower bytes");
    expect_rc(raise_user(grant0, "21474836480", "749999"), 2, "only increase", "lower inodes");
    expect_rc(raise_user(grant0, "21474836481", "1000000"), 2, "only increase", "unaligned");
    expect_rc(raise_user("12345678-1234-4234-8234-0000000000ff", "21474836480", "1000000"), 2, "unknown", "unknown user");
    put("fake/available", "16106127360\n", 0600); /* grant1's untouched 15 GiB + 5 GiB more > free */
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 2, "overcommit", "overcommit raise");
    assert(!strcmp(slurp("fake/q100000"), "16106127360 750000\n"));
    assert(unlinkat(base_fd, "fake/available", 0) == 0);
    /* Failure after the record: denied until the same raise is repeated. */
    put("fake/fail-raise", "", 0600);
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 2, "repeat the same command", "failed raise");
    assert(unlinkat(base_fd, "fake/fail-raise", 0) == 0);
    assert(mkdirat(base_fd, "run4", 0700) == 0);
    pid = serve("/run4");
    ensure("/run4", grant0, reply, sizeof(reply)); assert(!strcmp(reply, "DENIED/1\n"));
    stop(pid);
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 0, "raised user", "repeat applies");
    assert(!strcmp(slurp("fake/q100000"), "21474836480 1000000\n"));
    expect_rc(raise_user(grant0, "21474836480", "1000000"), 0, "raised user", "already applied");
    /* Restart replays to the same limits: receipts and usage report them. */
    assert(mkdirat(base_fd, "run5", 0700) == 0);
    pid = serve("/run5");
    ensure("/run5", grant0, reply, sizeof(reply));
    assert(fstatat(base_fd, "broker/root/p100000", &dir, AT_SYMLINK_NOFOLLOW) == 0);
    char expected[200];
    snprintf(expected, sizeof(expected), "OK/2 100000 %llu %llu 21474836480 1000000 %s\n",
             (unsigned long long)dir.st_dev, (unsigned long long)dir.st_ino, mount_uuid);
    if (strcmp(reply, expected)) { fprintf(stderr, "reply %s expected %s", reply, expected); assert(0); }
    exchange("/run5", usage, 45, reply, sizeof(reply));
    assert(!strcmp(reply, "USAGE/1 100000 12884901888 21474836480 600000 1000000\n"));
    ensure("/run5", grant1, reply, sizeof(reply)); expect_ok(reply, 100001, &dir); /* others unchanged */
    stop(pid);
    assert(run("--check") == 0);
}
int main(int argc, char **argv) {
    assert(geteuid() != 0);
    assert(argc == 2); binary = argv[1];
    alarm(60);
    umask(077);
    fixture();
    void (*tests[])(void) = {usage_and_policy_refusals, directory_and_mount_refusals, bootstrap_once,
                             socket_refusals, operator_add_users, serve_and_restart, operator_raise};
    const char *names[] = {"usage and policy file refusals", "directory/identity/mount refusals",
                           "one-time bootstrap bound to policy", "socket directory refusals",
                           "operator add-user: journal grants, duplicates, no overcommit",
                           "served per-user pool, workspaces, usage, restart",
                           "operator raise-user: only up, in-use refusal, retry, replay to receipts"};
    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); i++) {
        tests[i](); printf("ok %zu - %s\n", i + 1, names[i]);
    }
    close(base_fd);
    assert(nftw(base, remove_item, 16, FTW_DEPTH | FTW_PHYS) == 0);
    printf("%zu broker main tests passed (FAKE adapter; no quota syscalls)\n", sizeof(tests) / sizeof(tests[0]));
    return 0;
}
