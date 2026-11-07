#define _GNU_SOURCE
#include "policy.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef NDEBUG
#error Tests require assertions
#endif

/* Placeholder policy values (15 GiB / 750000 inodes per user); the owner chooses real ones at install. */
static const char valid[] =
    "# step-quota-broker policy\n"
    "version=1\n"
    "epoch=0123456789abcdef0123456789abcdef\n"
    "mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304\n"
    "root_device=66306\n"
    "root_inode=1234567\n"
    "\n"
    "bytes_hard=16106127360\n"
    "inodes_hard=750000\n"
    "first_project=100000\n"
    "last_project=199999\n"
    "gateway_uid=1000\n"
    "gateway_gid=1000\n"
    "workload_uid=995\n"
    "user=12345678-1234-4234-8234-000000000000\n"
    "user=12345678-1234-4234-8234-000000000001\n";

static int parse(const char *text, struct qb_service_policy *p, unsigned int *line) {
    return qb_policy_parse(text, strlen(text), p, line);
}
/* Replace the first occurrence of `from` (a whole line incl. \n) in valid. */
static int parse_with(const char *from, const char *to, unsigned int *line) {
    static char buffer[QB_POLICY_MAX_BYTES * 2];
    const char *at = strstr(valid, from); assert(at);
    size_t head = (size_t)(at - valid);
    int n = snprintf(buffer, sizeof(buffer), "%.*s%s%s", (int)head, valid, to, at + strlen(from));
    assert(n > 0 && (size_t)n < sizeof(buffer));
    struct qb_service_policy p;
    errno = 0;
    int r = qb_policy_parse(buffer, (size_t)n, &p, line);
    assert(r == 0 || errno == EINVAL);
    return r;
}

static void accepts_valid(void) {
    struct qb_service_policy p; unsigned int line = 99;
    assert(parse(valid, &p, &line) == 0 && line == 0);
    assert(p.core.layout == QB_LAYOUT_SHARED && p.core.access_gid == 1000 && p.core.content_uid == 995);
    assert(p.gateway_uid == 1000 && p.gateway_gid == 1000 && p.workload_uid == 995);
    assert(p.core.bytes_hard == UINT64_C(16106127360) && p.core.inodes_hard == 750000);
    assert(p.core.first_project == 100000 && p.core.last_project == 199999);
    assert(p.core.root_device == 66306 && p.core.root_inode == 1234567);
    assert(p.core.epoch[0] == 0x01 && p.core.epoch[15] == 0xef);
    const uint8_t mount[16] = {0x6b, 0x52, 0x59, 0x0c, 0xae, 0xd0, 0x4f, 0x2e,
                               0xbc, 0xb1, 0x20, 0x4a, 0x09, 0xa4, 0x93, 0x04};
    assert(!memcmp(p.core.mount_uuid, mount, 16));
    assert(p.core.grant_count == 2 && p.core.grants[1].peer_uid == 1000);
    assert(!strcmp(p.core.grants[1].workspace, "12345678-1234-4234-8234-000000000001"));
    assert(p.core.grants[0].workspace[36] == 0 && p.core.grants[0].workspace[39] == 0);
    /* maximum grant count and limits on the boundaries */
    char big[QB_POLICY_MAX_BYTES];
    int n = snprintf(big, sizeof(big), "%.*s", (int)(strstr(valid, "user=") - valid), valid);
    for (int i = 0; i < QB_MAX_GRANTS; i++)
        n += snprintf(big + n, sizeof(big) - (size_t)n, "user=12345678-1234-4234-8234-%012d\n", i);
    assert(parse(big, &p, NULL) == 0 && p.core.grant_count == QB_MAX_GRANTS);
    n += snprintf(big + n, sizeof(big) - (size_t)n, "user=12345678-1234-4234-8234-%012d\n", 999);
    assert(parse(big, &p, NULL) < 0 && errno == EINVAL);
    assert(parse_with("bytes_hard=16106127360\n", "bytes_hard=4096\n", NULL) == 0);
    assert(parse_with("bytes_hard=16106127360\n", "bytes_hard=1099511627776\n", NULL) == 0);
    assert(parse_with("inodes_hard=750000\n", "inodes_hard=10000000\n", NULL) == 0);
    assert(parse_with("last_project=199999\n", "last_project=100001\n", NULL) == 0);
}
static void refuses_format(void) {
    struct qb_service_policy p; unsigned int line;
    assert(qb_policy_parse(valid, strlen(valid) - 1, &p, &line) < 0); /* no final newline */
    assert(qb_policy_parse(NULL, 1, &p, &line) < 0 && qb_policy_parse(valid, 0, &p, &line) < 0);
    struct { const char *from, *to; unsigned int line; } cases[] = {
        {"version=1\n", "colour=blue\nversion=1\n", 2},     /* unknown key */
        {"version=1\n", "Version=1\n", 2},                  /* keys are lowercase/exact */
        {"version=1\n", "version = 1\n", 2},                /* no spaces */
        {"version=1\n", "version=1 \n", 2},
        {"version=1\n", "version=1\r\n", 2},
        {"version=1\n", "version=1\t\n", 2},
        {"version=1\n", " # indented comment\nversion=1\n", 2},
        {"version=1\n", "version\n", 2},
        {"version=1\n", "version=2\n", 2},
        {"version=1\n", "version=1\nversion=1\n", 3},       /* duplicate */
        {"workload_uid=995\n", "workload_uid=995\nworkload_uid=995\n", 15},
        {"user=12345678-1234-4234-8234-000000000001\n", "user=12345678-1234-4234-8234-000000000000\n", 16},
        {"version=1\n", "", 0},                             /* missing */
        {"epoch=0123456789abcdef0123456789abcdef\n", "", 0},
        {"user=12345678-1234-4234-8234-000000000000\nuser=12345678-1234-4234-8234-000000000001\n", "", 0},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        line = 1234;
        int r = parse_with(cases[i].from, cases[i].to, &line);
        if (r == 0 || line != cases[i].line) {
            fprintf(stderr, "format case %zu: r=%d line=%u\n", i, r, line);
            assert(0);
        }
    }
    char nul[sizeof(valid)]; memcpy(nul, valid, sizeof(valid)); nul[30] = 0;
    assert(qb_policy_parse(nul, sizeof(valid) - 1, &p, &line) < 0);
    char longline[QB_POLICY_MAX_LINE + 40];
    memset(longline, 'a', sizeof(longline)); longline[0] = '#';
    longline[QB_POLICY_MAX_LINE + 1] = '\n'; longline[QB_POLICY_MAX_LINE + 2] = 0;
    assert(parse_with("version=1\n", longline, NULL) < 0);
}
static void refuses_values(void) {
    const char *bad[][2] = {
        {"epoch=0123456789abcdef0123456789abcdef\n", "epoch=00000000000000000000000000000000\n"},
        {"epoch=0123456789abcdef0123456789abcdef\n", "epoch=0123456789ABCDEF0123456789abcdef\n"},
        {"epoch=0123456789abcdef0123456789abcdef\n", "epoch=0123456789abcdef0123456789abcde\n"},
        {"epoch=0123456789abcdef0123456789abcdef\n", "epoch=0123456789abcdef0123456789abcdefa0\n"},
        {"mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304\n", "mount_uuid=00000000-0000-0000-0000-000000000000\n"},
        {"mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304\n", "mount_uuid=6B52590C-aed0-4f2e-bcb1-204a09a49304\n"},
        {"mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304\n", "mount_uuid=6b52590caed04f2ebcb1204a09a49304\n"},
        {"mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304\n", "mount_uuid=6b52590c-aed0-4f2e-bcb1204a-09a49304\n"},
        {"root_device=66306\n", "root_device=0\n"},
        {"root_device=66306\n", "root_device=066306\n"},
        {"root_device=66306\n", "root_device=+66306\n"},
        {"root_device=66306\n", "root_device=-1\n"},
        {"root_inode=1234567\n", "root_inode=18446744073709551616\n"},
        {"root_inode=1234567\n", "root_inode=0x10\n"},
        {"root_inode=1234567\n", "root_inode=\n"},
        {"bytes_hard=16106127360\n", "bytes_hard=4095\n"},
        {"bytes_hard=16106127360\n", "bytes_hard=16106127361\n"},
        {"bytes_hard=16106127360\n", "bytes_hard=1099511631872\n"},
        {"bytes_hard=16106127360\n", "bytes_hard=10GiB\n"},
        {"inodes_hard=750000\n", "inodes_hard=0\n"},
        {"inodes_hard=750000\n", "inodes_hard=10000001\n"},
        {"first_project=100000\n", "first_project=99999\n"},
        {"first_project=100000\n", "first_project=424242\n"},
        {"last_project=199999\n", "last_project=200000\n"},
        {"last_project=199999\n", "last_project=1099999\n"},
        {"first_project=100000\n", "first_project=150000\n"},  /* ok alone ... */
        {"gateway_uid=1000\n", "gateway_uid=0\n"},
        {"gateway_uid=1000\n", "gateway_uid=995\n"},           /* gateway == workload */
        {"gateway_uid=1000\n", "gateway_uid=4294967295\n"},
        {"gateway_gid=1000\n", "gateway_gid=0\n"},
        {"workload_uid=995\n", "workload_uid=0\n"},
        {"user=12345678-1234-4234-8234-000000000001\n", "user=12345678-1234-4234-8234-00000000000g\n"},
        {"user=12345678-1234-4234-8234-000000000001\n", "user=../../etc/passwd\n"},
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        int r = parse_with(bad[i][0], bad[i][1], NULL);
        int expected_ok = !strcmp(bad[i][1], "first_project=150000\n");
        if ((r == 0) != expected_ok) { fprintf(stderr, "value case %zu: r=%d\n", i, r); assert(0); }
    }
    /* first > last, and a range too small for every grant */
    assert(parse_with("last_project=199999\n", "last_project=100000\n", NULL) < 0);
    char swapped[sizeof(valid) + 8];
    const char *f = strstr(valid, "first_project=100000\n"); assert(f);
    int n = snprintf(swapped, sizeof(swapped), "%.*sfirst_project=100002\nlast_project=100001\n%s",
                     (int)(f - valid), valid, strstr(valid, "gateway_uid="));
    struct qb_service_policy p;
    assert(n > 0 && qb_policy_parse(swapped, (size_t)n, &p, NULL) < 0);
}
static int remove_item(const char *p, const struct stat *s, int t, struct FTW *w) {
    (void)s; (void)t; (void)w; return remove(p);
}
static void write_file(int dir, const char *name, const char *text, mode_t mode) {
    int fd = openat(dir, name, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600); assert(fd >= 0);
    assert(write(fd, text, strlen(text)) == (ssize_t)strlen(text));
    assert(fchmod(fd, mode) == 0); close(fd);
}
static void load_file_protection(void) {
    const char *tmp = getenv("TMPDIR"); assert(tmp && tmp[0] == '/');
    char path[4096]; int n = snprintf(path, sizeof(path), "%s/qb-policy-XXXXXX", tmp);
    assert(n > 0 && (size_t)n < sizeof(path) && mkdtemp(path));
    int dir = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(dir >= 0);
    assert(fchmod(dir, 0755) == 0);
    struct qb_service_policy p; unsigned int line;
    uid_t me = geteuid();
    write_file(dir, "policy", valid, 0644);
    assert(qb_policy_load(dir, "policy", me, &p, &line) == 0 && p.core.grant_count == 2);
    write_file(dir, "policy", valid, 0600);
    assert(qb_policy_load(dir, "policy", me, &p, &line) == 0);
    /* wrong owner (the production owner is root) */
    assert(qb_policy_load(dir, "policy", me + 1, &p, &line) < 0 && errno == EPERM);
    mode_t modes[] = {0640, 0664, 0666, 0400, 0444, 0700, 0755, 04644, 01644};
    for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
        assert(fchmodat(dir, "policy", modes[i], 0) == 0);
        assert(qb_policy_load(dir, "policy", me, &p, &line) < 0 && errno == EPERM);
    }
    assert(fchmodat(dir, "policy", 0644, 0) == 0);
    /* the directory must not be group/other-writable nor foreign */
    assert(fchmod(dir, 0775) == 0 && qb_policy_load(dir, "policy", me, &p, &line) < 0 && errno == EPERM);
    assert(fchmod(dir, 0757) == 0 && qb_policy_load(dir, "policy", me, &p, &line) < 0 && errno == EPERM);
    assert(fchmod(dir, 0755) == 0);
    /* symlink, hard link, directory, path components, empty, oversize */
    assert(symlinkat("policy", dir, "link") == 0);
    assert(qb_policy_load(dir, "link", me, &p, &line) < 0);
    assert(linkat(dir, "policy", dir, "hard", 0) == 0);
    assert(qb_policy_load(dir, "policy", me, &p, &line) < 0 && errno == EPERM);
    assert(unlinkat(dir, "hard", 0) == 0);
    assert(mkdirat(dir, "sub", 0755) == 0);
    write_file(dir, "sub/policy", valid, 0644);
    assert(qb_policy_load(dir, "sub/policy", me, &p, &line) < 0 && errno == EINVAL);
    assert(qb_policy_load(dir, "../policy", me, &p, &line) < 0);
    assert(qb_policy_load(dir, "sub", me, &p, &line) < 0 && errno == EPERM);
    write_file(dir, "empty", "", 0644);
    assert(qb_policy_load(dir, "empty", me, &p, &line) < 0 && errno == EFBIG);
    static char huge[QB_POLICY_MAX_BYTES + 2];
    memset(huge, '#', sizeof(huge) - 1); huge[sizeof(huge) - 2] = '\n';
    write_file(dir, "huge", huge, 0644);
    assert(qb_policy_load(dir, "huge", me, &p, &line) < 0 && errno == EFBIG);
    write_file(dir, "unknown", "version=1\nextra=1\n", 0644);
    assert(qb_policy_load(dir, "unknown", me, &p, &line) < 0 && errno == EINVAL && line == 2);
    assert(qb_policy_load(dir, "missing", me, &p, &line) < 0 && errno == ENOENT);
    close(dir);
    assert(nftw(path, remove_item, 16, FTW_DEPTH | FTW_PHYS) == 0);
}
int main(void) {
    assert(geteuid() != 0);
    umask(0077);
    accepts_valid(); puts("ok 1 - valid policy, boundaries, 512 users");
    refuses_format(); puts("ok 2 - unknown/duplicate/missing keys and format refused with line");
    refuses_values(); puts("ok 3 - out-of-range and malformed values refused");
    load_file_protection(); puts("ok 4 - owner/mode/link/size protection of the policy file");
    puts("4 policy tests passed");
    return 0;
}
