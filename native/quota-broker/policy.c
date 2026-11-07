#define _GNU_SOURCE
#include "policy.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int deny(int error) { errno = error; return -1; }

enum key { VERSION, EPOCH, MOUNT_UUID, ROOT_DEVICE, ROOT_INODE, BYTES_HARD, INODES_HARD,
           FIRST_PROJECT, LAST_PROJECT, GATEWAY_UID, GATEWAY_GID, WORKLOAD_UID, GRANT, KEYS };
static const char *const names[KEYS] = {
    "version", "epoch", "mount_uuid", "root_device", "root_inode", "bytes_hard", "inodes_hard",
    "first_project", "last_project", "gateway_uid", "gateway_gid", "workload_uid", "user"};

/* Decimal, no sign, no leading zero, no overflow, within [min, max]. */
static int number(const char *s, size_t n, uint64_t min, uint64_t max, uint64_t *out) {
    if (!n || n > 20 || (s[0] == '0' && n > 1)) return -1;
    uint64_t v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return -1;
        uint64_t d = (uint64_t)(s[i] - '0');
        if (v > (UINT64_MAX - d) / 10) return -1;
        v = v * 10 + d;
    }
    if (v < min || v > max) return -1;
    *out = v;
    return 0;
}
static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
static int nonzero(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i]) return 1;
    return 0;
}
/* Canonical lowercase 8-4-4-4-12; text copied with NUL when text != NULL.
 * Every segment has an even length, so hex pairs never straddle a dash. */
static int uuid(const char *s, size_t n, uint8_t bytes[16], char text[40]) {
    if (n != 36) return -1;
    for (size_t i = 0; i < 36; i++) {
        int dash = i == 8 || i == 13 || i == 18 || i == 23;
        if (dash ? s[i] != '-' : hex(s[i]) < 0) return -1;
    }
    size_t j = 0;
    for (size_t i = 0; i < 36; i += 2) {
        if (s[i] == '-') i++;
        if (bytes) bytes[j] = (uint8_t)(hex(s[i]) << 4 | hex(s[i + 1]));
        j++;
    }
    if (j != 16) return -1;
    if (text) { memset(text, 0, 40); memcpy(text, s, 36); }
    return 0;
}

int qb_policy_parse(const char *text, size_t length, struct qb_service_policy *out, unsigned int *line) {
    if (line) *line = 0;
    if (!text || !out || !length || length > QB_POLICY_MAX_BYTES || text[length - 1] != '\n')
        return deny(EINVAL);
    struct qb_service_policy p;
    memset(&p, 0, sizeof(p));
    unsigned int seen[KEYS] = {0};
    uint64_t v[KEYS] = {0};
    unsigned int number_of_line = 0;
    for (size_t at = 0; at < length;) {
        number_of_line++;
        if (line) *line = number_of_line;
        const char *start = text + at;
        const char *end = memchr(start, '\n', length - at);
        size_t n = (size_t)(end - start);
        at += n + 1;
        if (n > QB_POLICY_MAX_LINE) return deny(EINVAL);
        /* Comments may contain spaces; nothing else may contain any whitespace/control. */
        int comment = n && start[0] == '#';
        for (size_t i = 0; i < n; i++) {
            unsigned char c = (unsigned char)start[i];
            if (c > 0x7e || c < (comment ? 0x20 : 0x21)) return deny(EINVAL);
        }
        if (!n || comment) continue;
        const char *eq = memchr(start, '=', n);
        if (!eq) return deny(EINVAL);
        size_t key_length = (size_t)(eq - start);
        const char *value = eq + 1;
        size_t value_length = n - key_length - 1;
        enum key k = KEYS;
        for (int i = 0; i < KEYS; i++)
            if (strlen(names[i]) == key_length && !memcmp(names[i], start, key_length)) k = (enum key)i;
        if (k == KEYS) return deny(EINVAL); /* unknown key */
        if (k != GRANT && seen[k]) return deny(EINVAL); /* duplicate */
        seen[k]++;
        int bad = 0;
        switch (k) {
        case VERSION: bad = number(value, value_length, 1, 1, &v[k]); break;
        case EPOCH:
            if (value_length != 32) { bad = 1; break; }
            for (size_t i = 0; i < 16; i++) {
                int hi = hex(value[2 * i]), lo = hex(value[2 * i + 1]);
                if (hi < 0 || lo < 0) { bad = 1; break; }
                p.core.epoch[i] = (uint8_t)(hi << 4 | lo);
            }
            if (!bad && !nonzero(p.core.epoch, 16)) bad = 1;
            break;
        case MOUNT_UUID:
            bad = uuid(value, value_length, p.core.mount_uuid, NULL) || !nonzero(p.core.mount_uuid, 16);
            break;
        case ROOT_DEVICE: case ROOT_INODE:
            bad = number(value, value_length, 1, UINT64_MAX, &v[k]); break;
        case BYTES_HARD:
            bad = number(value, value_length, 4096, UINT64_C(1099511627776), &v[k]) || v[k] % 4096;
            break;
        case INODES_HARD: bad = number(value, value_length, 1, 10000000, &v[k]); break;
        case FIRST_PROJECT: case LAST_PROJECT:
            bad = number(value, value_length, 100000, 199999, &v[k]); break;
        case GATEWAY_UID: case GATEWAY_GID: case WORKLOAD_UID:
            bad = number(value, value_length, 1, 2147483646, &v[k]); break;
        case GRANT: {
            if (p.core.grant_count >= QB_MAX_GRANTS) { bad = 1; break; }
            struct qb_grant *g = &p.core.grants[p.core.grant_count];
            if (uuid(value, value_length, NULL, g->workspace)) { bad = 1; break; }
            for (uint32_t i = 0; i < p.core.grant_count; i++)
                if (!strcmp(p.core.grants[i].workspace, g->workspace)) bad = 1;
            p.core.grant_count++;
            break;
        }
        default: bad = 1;
        }
        if (bad) return deny(EINVAL);
    }
    if (line) *line = 0;
    for (int i = 0; i < KEYS; i++) if (!seen[i]) return deny(EINVAL); /* missing */
    if (v[FIRST_PROJECT] > v[LAST_PROJECT] ||
        v[LAST_PROJECT] - v[FIRST_PROJECT] + 1 < p.core.grant_count) /* every grant can allocate */
        return deny(EINVAL);
#ifndef QB_BROKER_TESTING
    /* The workload must never be the gateway principal. Only the unprivileged FAKE-adapter
     * test build (which cannot chown to another uid) lets one test user play both. */
    if (v[WORKLOAD_UID] == v[GATEWAY_UID]) return deny(EINVAL);
#endif
    p.core.root_device = v[ROOT_DEVICE]; p.core.root_inode = v[ROOT_INODE];
    p.core.bytes_hard = v[BYTES_HARD]; p.core.inodes_hard = v[INODES_HARD];
    p.core.first_project = (uint32_t)v[FIRST_PROJECT]; p.core.last_project = (uint32_t)v[LAST_PROJECT];
    p.gateway_uid = (uint32_t)v[GATEWAY_UID]; p.gateway_gid = (uint32_t)v[GATEWAY_GID];
    p.workload_uid = (uint32_t)v[WORKLOAD_UID];
    p.core.layout = QB_LAYOUT_SHARED;
    p.core.access_gid = p.gateway_gid; p.core.content_uid = p.workload_uid;
    for (uint32_t i = 0; i < p.core.grant_count; i++) p.core.grants[i].peer_uid = p.gateway_uid;
    *out = p;
    return 0;
}

int qb_policy_load(int dir_fd, const char *name, uid_t owner, struct qb_service_policy *out,
                   unsigned int *line) {
    if (line) *line = 0;
    if (!name || !out || !name[0] || strchr(name, '/')) return deny(EINVAL);
    struct stat d;
    if (fstat(dir_fd, &d) < 0) return -1;
    if (!S_ISDIR(d.st_mode) || d.st_uid != owner || (d.st_mode & 022)) return deny(EPERM);
    struct open_how how = {
        .flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY | O_NONBLOCK,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    int fd = (int)syscall(SYS_openat2, dir_fd, name, &how, sizeof(how));
    if (fd < 0) return -1;
    char text[QB_POLICY_MAX_BYTES + 1];
    struct stat s;
    int result = -1;
    if (fstat(fd, &s) < 0) goto done;
    if (!S_ISREG(s.st_mode) || s.st_uid != owner || s.st_nlink != 1 ||
        ((s.st_mode & 07777) != 0600 && (s.st_mode & 07777) != 0644)) { errno = EPERM; goto done; }
    if (s.st_size < 1 || s.st_size > QB_POLICY_MAX_BYTES) { errno = EFBIG; goto done; }
    size_t used = 0;
    for (;;) {
        ssize_t n = read(fd, text + used, sizeof(text) - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) goto done;
        if (!n) break;
        used += (size_t)n;
        if (used > QB_POLICY_MAX_BYTES) { errno = EFBIG; goto done; }
    }
    if (used != (size_t)s.st_size) { errno = EIO; goto done; } /* changed while reading */
    result = qb_policy_parse(text, used, out, line);
done: {
    int saved = errno; close(fd); errno = saved;
    return result;
}}
