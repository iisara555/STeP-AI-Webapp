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
 * A second broker instance in the per-user pool (service) model then exercises the operator
 * operations and a full pool: no bootstrap users, journal grants (qb_grant_add), a raise
 * (qb_raise) enforced by the kernel, the no-overcommit refusal, and a SQLite database in the
 * engine Store's journal mode (WAL, synchronous=FULL, same schema) inside a workspace of a
 * pool that is filled from ANOTHER workspace of the same user: committed rows stay readable
 * and intact, the failing write reports an error, and writes succeed again after freeing.
 * The SQLite work runs in the unprivileged writer child, linked against libsqlite3.so.0.
 *
 * Output: one "PASS <check>: ..." or "FAIL <check>: ..." line per check, "INFO"
 * lines for measurements that are not pass/fail gates, and a final RESULT line.
 * Exit 0 only if every check passed; 1 if any failed; 2 on refused preconditions.
 */
#define _GNU_SOURCE
#include "core.h"
#include "xfs.h"
#include "acceptance/sqlite3-min.h"
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
          W_CREATE_INODES, W_ESCAPE_USERNS, W_ESCAPE_INIT,
          W_SQL_RUNNING, W_SQL_FULL, W_SQL_VERIFY, W_SQL_AFTER_FREE };
struct wres {
    int identity_ok, error, error2, error3;
    uint64_t count, value;
    char detail[160];
    /* SQLite checks */
    int wal, rc_big, rc_store, integrity_ok, small_ok, fill_errno;
    int64_t big_len;
    uint64_t rows, checksum, checksum_before, mask, fill_count;
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
static void sql_body(int dir, enum op op, struct wres *r);
static void sql_running(int dir, struct wres *r, void (*fill)(void *, struct wres *), void *ctx);
static void fill_other(void *ctx, struct wres *r);
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
    case W_SQL_RUNNING: /* arg: the filler directory FD (another workspace of the pool) */
        sql_running(dir, r, fill_other, &arg);
        return;
    case W_SQL_FULL: case W_SQL_VERIFY: case W_SQL_AFTER_FREE:
        sql_body(dir, op, r);
        return;
    }
}

/* ------------------------------------------- engine Store SQLite (writer side only) */
/* harness/desktop/electron/store.ts opens with exactly this, every time. */
static const char STORE_OPEN[] =
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, "
    "value TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING "
    "fts5(id UNINDEXED, content, tokenize=\"trigram\"); PRAGMA user_version=2;";
static const char STORE_PUT[] =
    "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value";
#define SQL_ROWS 200
#define SQL_ROW_BYTES 1000
#define SQL_SMALL 20
#define SQL_BIG (6 * MIB)
static void row_value(int i, char *buf) {
    int n = snprintf(buf, SQL_ROW_BYTES + 1, "{\"id\":\"s%03d\",\"title\":\"history %03d\",\"text\":\"", i, i);
    for (int j = n; j < SQL_ROW_BYTES - 2; j++) buf[j] = (char)('a' + (i * 7 + j) % 26);
    buf[SQL_ROW_BYTES - 2] = '"'; buf[SQL_ROW_BYTES - 1] = '}'; buf[SQL_ROW_BYTES] = 0;
}
static uint64_t fnv(uint64_t h, const void *p, size_t n) {
    const unsigned char *c = p;
    for (size_t i = 0; i < n; i++) { h ^= c[i]; h *= UINT64_C(1099511628211); }
    return h;
}
static uint64_t expected_checksum(void) {
    uint64_t h = UINT64_C(14695981039346656037);
    char id[16], value[SQL_ROW_BYTES + 1];
    for (int i = 0; i < SQL_ROWS; i++) {
        snprintf(id, sizeof(id), "s%03d", i); row_value(i, value);
        h = fnv(h, id, strlen(id) + 1); h = fnv(h, value, SQL_ROW_BYTES + 1);
    }
    return h;
}
static int sql_open(sqlite3 **db) {
    *db = NULL;
    int rc = sqlite3_open_v2("workspace.sqlite", db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                             SQLITE_OPEN_NOFOLLOW, NULL);
    if (rc != SQLITE_OK) { if (*db) sqlite3_close(*db); *db = NULL; return rc; }
    sqlite3_extended_result_codes(*db, 1);
    sqlite3_busy_timeout(*db, 5000);
    return SQLITE_OK;
}
static int sql_put(sqlite3 *db, const char *id, const char *value, int length) {
    sqlite3_stmt *st = NULL;
    int rc = sqlite3_prepare_v2(db, STORE_PUT, -1, &st, NULL);
    if (rc == SQLITE_OK) {
        sqlite3_bind_text(st, 1, "session", -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, id, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, value, length, SQLITE_TRANSIENT);
        rc = sqlite3_step(st) == SQLITE_DONE ? SQLITE_OK : sqlite3_extended_errcode(db);
    } else rc = sqlite3_extended_errcode(db);
    sqlite3_finalize(st);
    return rc;
}
static int sql_index(sqlite3 *db, const char *id, const char *content) {
    sqlite3_stmt *st = NULL;
    int rc = sqlite3_prepare_v2(db, "INSERT INTO session_search(id,content) VALUES (?,?)", -1, &st, NULL);
    if (rc == SQLITE_OK) {
        sqlite3_bind_text(st, 1, id, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, content, -1, SQLITE_TRANSIENT);
        rc = sqlite3_step(st) == SQLITE_DONE ? SQLITE_OK : sqlite3_extended_errcode(db);
    } else rc = sqlite3_extended_errcode(db);
    sqlite3_finalize(st);
    return rc;
}
/* The original history rows in id order: count and FNV-1a over id\0value\0. */
static int sql_checksum(sqlite3 *db, uint64_t *rows, uint64_t *sum) {
    sqlite3_stmt *st = NULL;
    *rows = 0; *sum = UINT64_C(14695981039346656037);
    if (sqlite3_prepare_v2(db, "SELECT id, value FROM records WHERE kind='session' AND id GLOB "
                           "'s[0-9][0-9][0-9]' ORDER BY id", -1, &st, NULL) != SQLITE_OK) return -1;
    int rc;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        const unsigned char *id = sqlite3_column_text(st, 0), *v = sqlite3_column_text(st, 1);
        int n = sqlite3_column_bytes(st, 1);
        if (!id || !v) { rc = -1; break; }
        *sum = fnv(*sum, id, strlen((const char *)id) + 1); *sum = fnv(*sum, v, (size_t)n + 1);
        (*rows)++;
    }
    sqlite3_finalize(st);
    return rc == SQLITE_DONE ? 0 : -1;
}
static int sql_integrity(sqlite3 *db) {
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, "PRAGMA integrity_check", -1, &st, NULL) != SQLITE_OK) return 0;
    int ok = sqlite3_step(st) == SQLITE_ROW && sqlite3_column_text(st, 0) &&
             !strcmp((const char *)sqlite3_column_text(st, 0), "ok") && sqlite3_step(st) == SQLITE_DONE;
    sqlite3_finalize(st);
    return ok;
}
static int64_t sql_length(sqlite3 *db, const char *id) {
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, "SELECT length(value) FROM records WHERE kind='session' AND id=?", -1, &st,
                           NULL) != SQLITE_OK) return -2;
    sqlite3_bind_text(st, 1, id, -1, SQLITE_TRANSIENT);
    int rc = sqlite3_step(st);
    int64_t n = rc == SQLITE_ROW ? sqlite3_column_int64(st, 0) : rc == SQLITE_DONE ? -1 : -2;
    sqlite3_finalize(st);
    return n;
}
static char *big_value(void) {
    char *v = malloc(SQL_BIG + 1);
    if (!v) return NULL;
    for (size_t i = 0; i < SQL_BIG; i++) v[i] = (char)('A' + i % 23);
    v[SQL_BIG] = 0;
    return v;
}
static void sql_note(struct wres *r, sqlite3 *db, const char *what) {
    if (!r->detail[0]) snprintf(r->detail, sizeof(r->detail), "%s: %s", what, db ? sqlite3_errmsg(db) : "open");
}
static void small_writes(sqlite3 *db, struct wres *r) {
    char id[16], value[128];
    for (int i = 0; i < SQL_SMALL; i++) { /* small autocommit writes may or may not still fit */
        snprintf(id, sizeof(id), "x%02d", i);
        snprintf(value, sizeof(value), "%0100d", i);
        if (sql_put(db, id, value, 100) == SQLITE_OK) { r->mask |= UINT64_C(1) << i; r->small_ok++; }
    }
}
static int big_write(sqlite3 *db, struct wres *r) {
    char *big = big_value();
    if (!big) return ENOMEM;
    r->rc_big = sql_put(db, "big", big, SQL_BIG);
    if (r->rc_big) sql_note(r, db, "big write");
    free(big);
    return 0;
}
static void read_back(sqlite3 *db, struct wres *r) {
    if (sql_checksum(db, &r->rows, &r->checksum) < 0) { r->error2 = sqlite3_extended_errcode(db); sql_note(r, db, "read"); }
    r->integrity_ok = sql_integrity(db);
    r->big_len = sql_length(db, "big");
}
/* The running runtime: its Store connection is open (WAL) while the pool fills up. `fill`
 * fills the pool (acceptance: another workspace of the same user) and records what happened. */
static void sql_running(int dir, struct wres *r, void (*fill)(void *, struct wres *), void *ctx) {
    r->big_len = -1;
    if (fchdir(dir) < 0) { r->error = errno; snprintf(r->detail, sizeof(r->detail), "fchdir"); return; }
    sqlite3 *db = NULL;
    int rc = sql_open(&db);
    if (rc != SQLITE_OK) { r->error = rc; sql_note(r, NULL, "open"); return; }
    char id[16], value[SQL_ROW_BYTES + 1];
    if ((rc = sqlite3_exec(db, STORE_OPEN, NULL, NULL, NULL)) != SQLITE_OK ||
        (rc = sqlite3_exec(db, "PRAGMA synchronous=FULL", NULL, NULL, NULL)) != SQLITE_OK) {
        r->error = rc; sql_note(r, db, "store schema"); goto done;
    }
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, "PRAGMA journal_mode", -1, &st, NULL) == SQLITE_OK &&
        sqlite3_step(st) == SQLITE_ROW && sqlite3_column_text(st, 0))
        r->wal = !strcmp((const char *)sqlite3_column_text(st, 0), "wal");
    sqlite3_finalize(st);
    for (int i = 0; i < SQL_ROWS; i++) { /* one committed transaction per history row */
        snprintf(id, sizeof(id), "s%03d", i); row_value(i, value);
        if ((rc = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL)) != SQLITE_OK ||
            (rc = sql_put(db, id, value, SQL_ROW_BYTES)) != SQLITE_OK ||
            (rc = sql_index(db, id, value)) != SQLITE_OK ||
            (rc = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL)) != SQLITE_OK) {
            r->error = rc; sql_note(r, db, "insert"); goto done;
        }
        r->count++;
    }
    uint64_t rows = 0;
    if (sql_checksum(db, &rows, &r->checksum_before) < 0 || rows != SQL_ROWS) { r->error = EIO; goto done; }
    fill(ctx, r);
    if ((r->error = big_write(db, r)) != 0) goto done;
    small_writes(db, r);
    read_back(db, r);
done:
    sqlite3_close(db);
}
/* A fresh process (e.g. a runtime restart): open, then read / write / verify. */
static void sql_body(int dir, enum op op, struct wres *r) {
    r->big_len = -1;
    if (fchdir(dir) < 0) { r->error = errno; snprintf(r->detail, sizeof(r->detail), "fchdir"); return; }
    sqlite3 *db = NULL;
    int rc = sql_open(&db);
    if (rc != SQLITE_OK) { r->error = rc; sql_note(r, NULL, "open"); return; }
    char id[16], value[SQL_ROW_BYTES + 1];
    if (op == W_SQL_AFTER_FREE && (r->error = big_write(db, r)) != 0) goto done;
    if (op == W_SQL_FULL) {
        /* Measurement: the engine Store constructor's own writes (schema/user_version, search
         * index rebuild) and a small write while the pool is full. Never touches the rows. */
        r->rc_store = sqlite3_exec(db, STORE_OPEN, NULL, NULL, NULL);
        if (!r->rc_store) r->rc_store = sqlite3_exec(db, "DELETE FROM session_search", NULL, NULL, NULL);
        for (int i = 0; !r->rc_store && i < SQL_ROWS; i++) {
            snprintf(id, sizeof(id), "s%03d", i); row_value(i, value);
            r->rc_store = sql_index(db, id, value);
        }
    }
    read_back(db, r);
    if (op == W_SQL_VERIFY)
        for (int i = 0; i < SQL_SMALL; i++) {
            snprintf(id, sizeof(id), "x%02d", i);
            if (sql_length(db, id) == 100) r->mask |= UINT64_C(1) << i;
        }
done:
    sqlite3_close(db);
}
/* Writer side: fill the pool through the second inherited directory (fd number in *ctx). */
static void fill_other(void *ctx, struct wres *r) {
    struct wres t; memset(&t, 0, sizeof(t));
    writer_body((int)*(uint64_t *)ctx, W_FILL_BYTES, 0, &t);
    r->fill_count = t.count; r->fill_errno = t.error;
}
/* Fork, drop to the writer identity, operate ONLY relative to dir_fd. */
static int as_writer2(int dir_fd, int second_fd, enum op op, uint64_t arg, struct wres *r);
static int as_writer(int dir_fd, enum op op, uint64_t arg, struct wres *r) {
    return as_writer2(dir_fd, -1, op, arg, r);
}
/* second_fd (optional) is inherited as fd 102 and passed to the op as `arg`. */
static int as_writer2(int dir_fd, int second_fd, enum op op, uint64_t arg, struct wres *r) {
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
        if (second_fd >= 0) {
            if (fcntl(second_fd, F_DUPFD_CLOEXEC, 102) != 102) _exit(3);
            arg = 102;
        }
        close_range(3, 99, 0); close_range(second_fd >= 0 ? 103 : 102, ~0U, 0);
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


/* ------------------------------------------- per-user pool instance (service model) */
#define POOL_FIRST 100010u
#define POOL_LAST 100013u
static const char *const USERS[3] = {
    "a1000000-0000-4000-8000-0000000000a1", /* U1: raised; history db + filler workspaces */
    "a2000000-0000-4000-8000-0000000000a2", /* U2: other user, isolation */
    "a3000000-0000-4000-8000-0000000000a3", /* U3: refused (overcommit) */
};
static const char *const POOL_WS[3] = {
    "aa000000-0000-4000-8000-0000000000aa", /* U1 workspace A: raise fill, then pool filler */
    "ab000000-0000-4000-8000-0000000000ab", /* U1 workspace B: workspace.sqlite */
    "ac000000-0000-4000-8000-0000000000ac", /* U2 workspace */
};
static off_t journal_bytes(int state) {
    struct stat s; return fstatat(state, "journal", &s, 0) < 0 ? -1 : s.st_size;
}
static int pool_workspace(struct env *p, int user, int ws, struct qb_workspace_receipt *w) {
    char frame[96];
    snprintf(frame, sizeof(frame), "WORKSPACE/1 %s %s\n", USERS[user], POOL_WS[ws]);
    return qb_workspace(p->broker, PEER, frame, 86, w);
}
static int pool_usage(struct env *p, int user, struct qb_usage *u) {
    char frame[64];
    snprintf(frame, sizeof(frame), "USAGE/1 %s\n", USERS[user]);
    return qb_usage(p->broker, PEER, frame, 45, u);
}
/* Same thresholds as the gateway's usageLevel() (server/src/workspace/native-quota-socket.ts). */
static const char *level_of(const struct qb_usage *u) {
    double b = (double)u->bytes_used / (double)u->bytes_hard, i = (double)u->inodes_used / (double)u->inodes_hard;
    double w = b > i ? b : i;
    return w >= 1 ? "full" : w >= 0.95 ? "warn95" : w >= 0.8 ? "warn80" : "ok";
}
static void check_pool_add(struct env *p, uint64_t *u1_inode) {
    const char *n = "operator_add_user_journal_grant";
    off_t j0 = journal_bytes(p->state);
    uint32_t p1 = 0, p2 = 0, px = 0; struct qb_capacity c1, c2, cx;
    int a1 = qb_grant_add(p->broker, USERS[0], &p1, &c1);
    off_t j1 = journal_bytes(p->state);
    int dup = qb_grant_add(p->broker, USERS[0], &px, &cx), dup_err = errno;
    int inv = qb_grant_add(p->broker, "A1000000-0000-4000-8000-0000000000a1", &px, &cx), inv_err = errno;
    off_t j2 = journal_bytes(p->state);
    struct qb_usage u; int us = pool_usage(p, 0, &u), us_err = errno;
    struct fs_disk_quota q0; int q0rc = getq(p->mnt, POOL_FIRST, &q0), q0err = errno;
    struct qb_workspace_receipt w; memset(&w, 0, sizeof(w)); w.directory_fd = -1;
    int wr = pool_workspace(p, 0, 0, &w);
    struct fs_disk_quota q; struct fsxattr a; struct stat ws;
    int qrc = wr ? -1 : getq(p->mnt, p1, &q);
    int arc = wr ? -1 : getattr(w.directory_fd, &a);
    int src = wr ? -1 : fstat(w.directory_fd, &ws);
    int a2 = qb_grant_add(p->broker, USERS[1], &p2, &c2);
    uint64_t inode = w.inode;
    if (w.directory_fd >= 0) close(w.directory_fd);
    broker_stop(p);
    int st = broker_start(p);
    struct qb_workspace_receipt w2; memset(&w2, 0, sizeof(w2)); w2.directory_fd = -1;
    int wr2 = st ? -1 : pool_workspace(p, 0, 0, &w2);
    if (w2.directory_fd >= 0) close(w2.directory_fd);
    int dup2 = st ? 0 : qb_grant_add(p->broker, USERS[1], &px, &cx), dup2_err = errno;
    int blank = q0rc < 0 ? q0err == ENOENT : (!q0.d_blk_hardlimit && !q0.d_ino_hardlimit);
    int ok = !a1 && p1 == POOL_FIRST && j1 > j0 && j2 == j1 && dup < 0 && dup_err == EEXIST &&
             inv < 0 && inv_err == EINVAL && us < 0 && us_err == ENOENT && blank && !wr && w.project == p1 &&
             w.bytes_hard == BYTES_HARD && !qrc && (uint64_t)q.d_blk_hardlimit * 512 == BYTES_HARD &&
             q.d_ino_hardlimit == INODES_HARD && !arc && a.fsx_projid == p1 && (a.fsx_xflags & FS_XFLAG_PROJINHERIT) &&
             !src && ws.st_uid == writer_uid && ws.st_gid == writer_gid && (ws.st_mode & 07777) == 02750 &&
             !a2 && p2 == POOL_FIRST + 1 && !st && !wr2 && w2.inode == inode && dup2 < 0 && dup2_err == EEXIST;
    verdict(ok, n, "no bootstrap users; add U1 -> project %u (journal +%lld B), duplicate -> %s, uppercase -> %s "
            "(journal unchanged: %s); usage before first workspace -> %s; quota before -> %s; workspace -> project %u "
            "%llu B, readback blk_hard=%llu*512 ino_hard=%llu, dir projid=%u inherit=%d owner %u:%u mode %o; add U2 -> "
            "%u; restart %s: same workspace inode %s, U2 again -> %s",
            p1, (long long)(j1 - j0), dup < 0 ? strerrorname_np(dup_err) : "ADDED", inv < 0 ? strerrorname_np(inv_err) : "ADDED",
            j2 == j1 ? "yes" : "NO", us < 0 ? strerrorname_np(us_err) : "ANSWERED", blank ? "blank" : "SET", w.project,
            (unsigned long long)w.bytes_hard, qrc ? 0ULL : (unsigned long long)q.d_blk_hardlimit,
            qrc ? 0ULL : (unsigned long long)q.d_ino_hardlimit, arc ? 0u : a.fsx_projid,
            arc ? 0 : !!(a.fsx_xflags & FS_XFLAG_PROJINHERIT), src ? 0u : (unsigned)ws.st_uid,
            src ? 0u : (unsigned)ws.st_gid, src ? 0u : (unsigned)(ws.st_mode & 07777), p2, st ? strerror(errno) : "ok",
            !wr2 && w2.inode == inode ? "yes" : "NO", dup2 < 0 ? strerrorname_np(dup2_err) : "ADDED");
    *u1_inode = inode;
}
static void check_pool_raise(struct env *p) {
    const char *n = "operator_raise_limit_enforced_and_replayed";
    struct qb_capacity c;
    off_t j0 = journal_bytes(p->state);
    int lower = qb_raise(p->broker, USERS[0], BYTES_HARD - 4096, INODES_HARD, &c), lower_err = errno;
    int over = qb_raise(p->broker, USERS[0], UINT64_C(1) << 40, 2 * INODES_HARD, &c), over_err = errno;
    off_t j1 = journal_bytes(p->state);
    struct fs_disk_quota q1, q2, q3;
    int q1rc = getq(p->mnt, POOL_FIRST, &q1);
    int up = qb_raise(p->broker, USERS[0], 2 * BYTES_HARD, 2 * INODES_HARD, &c), up_err = errno;
    off_t j2 = journal_bytes(p->state);
    int q2rc = getq(p->mnt, POOL_FIRST, &q2);
    int again = qb_raise(p->broker, USERS[0], 2 * BYTES_HARD, 2 * INODES_HARD, &c);
    off_t j3 = journal_bytes(p->state);
    struct qb_workspace_receipt w; memset(&w, 0, sizeof(w)); w.directory_fd = -1;
    int wr = pool_workspace(p, 0, 0, &w);
    struct wres fill, un; memset(&fill, 0, sizeof(fill)); memset(&un, 0, sizeof(un));
    int fr = wr ? -1 : as_writer(w.directory_fd, W_FILL_BYTES, 0, &fill);
    int ur = wr ? -1 : as_writer(w.directory_fd, W_UNLINK, 1, &un);
    struct fs_disk_quota settled;
    int sr = wait_usage(p->mnt, POOL_FIRST, MIB, 2 * INODES_HARD, &settled);
    if (w.directory_fd >= 0) close(w.directory_fd);
    broker_stop(p);
    int st = broker_start(p);
    struct qb_workspace_receipt w2; memset(&w2, 0, sizeof(w2)); w2.directory_fd = -1;
    int wr2 = st ? -1 : pool_workspace(p, 0, 0, &w2);
    if (w2.directory_fd >= 0) close(w2.directory_fd);
    struct qb_usage u; int us = st ? -1 : pool_usage(p, 0, &u);
    int q3rc = getq(p->mnt, POOL_FIRST, &q3);
    int ok = lower < 0 && lower_err == EINVAL && over < 0 && over_err == EFBIG && j1 == j0 && !q1rc &&
             (uint64_t)q1.d_blk_hardlimit * 512 == BYTES_HARD && !up && j2 > j1 && !q2rc &&
             (uint64_t)q2.d_blk_hardlimit * 512 == 2 * BYTES_HARD && q2.d_ino_hardlimit == 2 * INODES_HARD &&
             !q2.d_blk_softlimit && !q2.d_ino_softlimit && !again && j3 == j2 && !wr && w.bytes_hard == 2 * BYTES_HARD &&
             !fr && quota_errno(fill.error) && fill.count > BYTES_HARD && fill.count <= 2 * BYTES_HARD &&
             fill.count + SLACK >= 2 * BYTES_HARD && !ur && !un.error && !sr && !st && !wr2 &&
             w2.bytes_hard == 2 * BYTES_HARD && w2.inodes_hard == 2 * INODES_HARD && !us &&
             u.bytes_hard == 2 * BYTES_HARD && !q3rc && (uint64_t)q3.d_blk_hardlimit * 512 == 2 * BYTES_HARD;
    verdict(ok, n, "lower -> %s, 1 TiB -> %s (journal unchanged %s, kernel %llu*512); raise to %llu B/%llu inodes -> %s "
            "(journal +%lld B), readback blk_hard=%llu*512 ino_hard=%llu soft=%llu/%llu; repeat -> %s (no record %s); "
            "writer wrote %llu B then %s (old limit %llu B); restart %s: receipt %llu B/%llu inodes, usage hard %llu B, "
            "kernel %llu*512",
            lower < 0 ? strerrorname_np(lower_err) : "ALLOWED", over < 0 ? strerrorname_np(over_err) : "ALLOWED",
            j1 == j0 ? "yes" : "NO", q1rc ? 0ULL : (unsigned long long)q1.d_blk_hardlimit,
            (unsigned long long)(2 * BYTES_HARD), (unsigned long long)(2 * INODES_HARD), up ? strerrorname_np(up_err) : "ok",
            (long long)(j2 - j1), q2rc ? 0ULL : (unsigned long long)q2.d_blk_hardlimit,
            q2rc ? 0ULL : (unsigned long long)q2.d_ino_hardlimit, q2rc ? 0ULL : (unsigned long long)q2.d_blk_softlimit,
            q2rc ? 0ULL : (unsigned long long)q2.d_ino_softlimit, again ? "failed" : "ok", j3 == j2 ? "yes" : "NO",
            (unsigned long long)fill.count, strerrorname_np(fill.error) ? strerrorname_np(fill.error) : "none",
            (unsigned long long)BYTES_HARD, st ? strerror(errno) : "ok", (unsigned long long)w2.bytes_hard,
            (unsigned long long)w2.inodes_hard, us ? 0ULL : (unsigned long long)u.bytes_hard,
            q3rc ? 0ULL : (unsigned long long)q3.d_blk_hardlimit);
}
static void check_pool_overcommit(struct env *p) {
    const char *n = "add_user_refused_on_overcommit";
    struct qb_capacity c; uint32_t project = 0;
    off_t j0 = journal_bytes(p->state);
    int rc = qb_grant_add(p->broker, USERS[2], &project, &c), err = errno;
    off_t j1 = journal_bytes(p->state);
    struct qb_receipt r; char frame[47];
    snprintf(frame, sizeof(frame), "ENSURE/1 %s\n", USERS[2]);
    int er = qb_ensure(p->broker, PEER, frame, 46, &r), eerr = errno;
    if (!er) close(r.directory_fd);
    verdict(rc < 0 && err == EFBIG && j1 == j0 && project == 0 && er < 0 && eerr == EACCES, n,
            "U3 -> %s: %u pools would promise %llu B + reserve %llu B > %llu B free; journal unchanged %s; U3 "
            "ensure -> %s", rc < 0 ? strerrorname_np(err) : "ADDED", c.users, (unsigned long long)c.committed,
            (unsigned long long)c.reserve, (unsigned long long)c.available, j1 == j0 ? "yes" : "NO",
            er < 0 ? strerrorname_np(eerr) : "ALLOCATED");
}
static void check_full_pool_history(struct env *p) {
    const char *n = "full_pool_keeps_sqlite_history_intact";
    uint64_t want = expected_checksum();
    struct qb_workspace_receipt fw, dw, ow;
    memset(&fw, 0, sizeof(fw)); memset(&dw, 0, sizeof(dw)); memset(&ow, 0, sizeof(ow));
    fw.directory_fd = dw.directory_fd = ow.directory_fd = -1;
    if (pool_workspace(p, 0, 0, &fw) < 0 || pool_workspace(p, 0, 1, &dw) < 0 || pool_workspace(p, 1, 2, &ow) < 0) {
        verdict(0, n, "workspace receipts: %s", strerror(errno));
        goto out;
    }
    struct wres run, fresh, v1, iso, un, after, v2;
    /* 1. The runtime's open Store connection while the pool fills from another workspace. */
    int rr = as_writer2(dw.directory_fd, fw.directory_fd, W_SQL_RUNNING, 0, &run);
    struct qb_usage u; memset(&u, 0, sizeof(u));
    int us = pool_usage(p, 0, &u), us_err = errno;
    /* 2. A fresh process while still full (runtime restart): measured, see INFO. */
    int rf = as_writer(dw.directory_fd, W_SQL_FULL, 0, &fresh);
    int riso = as_writer(ow.directory_fd, W_WRITE, MIB, &iso); /* another user's pool still writes */
    /* 3. Free space (delete the filler), then a new write and a fresh verification. */
    int run_un = as_writer(fw.directory_fd, W_UNLINK, 1, &un);
    struct fs_disk_quota q;
    int sr = wait_usage(p->mnt, dw.project, 2 * BYTES_HARD - 8 * MIB, 4 * INODES_HARD, &q), sr_err = errno;
    int rv1 = as_writer(dw.directory_fd, W_SQL_VERIFY, 0, &v1);
    int ra = as_writer(dw.directory_fd, W_SQL_AFTER_FREE, 0, &after);
    int rv2 = as_writer(dw.directory_fd, W_SQL_VERIFY, 0, &v2);
    int running_ok = !rr && !run.error && run.wal && run.count == SQL_ROWS && run.checksum_before == want &&
                     quota_errno(run.fill_errno) && run.rc_big != SQLITE_OK && run.rows == SQL_ROWS &&
                     run.checksum == want && run.integrity_ok && !run.error2;
    /* No silent loss: every write reported OK is there in a fresh process; the failed one is
     * all or nothing (an error after a durable WAL commit would keep it whole). */
    int verify_ok = !rv1 && !v1.error && v1.rows == SQL_ROWS && v1.checksum == want && v1.integrity_ok &&
                    (v1.mask & run.mask) == run.mask && (v1.big_len == -1 || v1.big_len == SQL_BIG);
    int free_ok = !riso && !iso.error && iso.count == MIB && !run_un && !un.error && !sr && !ra && !after.error &&
                  after.rc_big == SQLITE_OK && !rv2 && !v2.error && v2.rows == SQL_ROWS && v2.checksum == want &&
                  v2.integrity_ok && v2.big_len == SQL_BIG && (v2.mask & run.mask) == run.mask;
    verdict(running_ok && verify_ok && free_ok, n,
            "open Store (WAL %s) committed %llu rows; filler in another workspace of the pool wrote %llu B then %s; "
            "new %u MiB write -> sqlite %d (%s); %d/%d small writes ok; %llu/%d rows readable, checksum %s, integrity %s; "
            "other user wrote %llu B (%s); freed (%s); fresh process: %llu rows checksum %s integrity %s, failed write %s, "
            "ok-reported writes %s; new write -> sqlite %d; reopen: big row %lld B, rows %llu checksum %s integrity %s",
            run.wal ? "yes" : "NO", (unsigned long long)run.count, (unsigned long long)run.fill_count,
            strerrorname_np(run.fill_errno) ? strerrorname_np(run.fill_errno) : "none", (unsigned)(SQL_BIG / MIB),
            run.rc_big, run.detail, run.small_ok, SQL_SMALL, (unsigned long long)run.rows, SQL_ROWS,
            run.checksum == want ? "ok" : "BAD", run.integrity_ok ? "ok" : "BAD", (unsigned long long)iso.count,
            iso.error ? strerror(iso.error) : "ok", sr ? strerror(sr_err) : "usage settled",
            (unsigned long long)v1.rows, v1.checksum == want ? "ok" : "BAD", v1.integrity_ok ? "ok" : "BAD",
            v1.big_len == -1 ? "absent" : v1.big_len == SQL_BIG ? "kept whole" : "PARTIAL",
            (v1.mask & run.mask) == run.mask ? "all present" : "MISSING", after.rc_big, (long long)v2.big_len,
            (unsigned long long)v2.rows, v2.checksum == want ? "ok" : "BAD", v2.integrity_ok ? "ok" : "BAD");
    out("INFO full_pool_details: sqlite %s; usage at full %s (%llu/%llu B, %llu/%llu inodes) -> gateway level %s; "
        "fresh process while full: open/read %s (%llu rows, checksum %s), engine Store open sequence -> sqlite %d (%s)\n",
        sqlite3_libversion(), us ? strerror(us_err) : "ok", (unsigned long long)u.bytes_used,
        (unsigned long long)u.bytes_hard, (unsigned long long)u.inodes_used, (unsigned long long)u.inodes_hard,
        us ? "?" : level_of(&u), rf || fresh.error || fresh.error2 ? (fresh.detail[0] ? fresh.detail : "FAILED") : "ok",
        (unsigned long long)fresh.rows, fresh.checksum == want ? "ok" : "BAD", fresh.rc_store,
        fresh.rc_store ? "the runtime could not start its Store until space is freed" : "opens");
out:
    if (fw.directory_fd >= 0) close(fw.directory_fd);
    if (dw.directory_fd >= 0) close(dw.directory_fd);
    if (ow.directory_fd >= 0) close(ow.directory_fd);
}
/* Free space after earlier deletions have been released (deferred inode inactivation). */
static uint64_t settled_available(int fd) {
    uint64_t last = 0;
    for (int i = 0; i < 50; i++) {
        struct statvfs v;
        if (syncfs(fd) < 0 || fstatvfs(fd, &v) < 0) return 0;
        uint64_t now = (uint64_t)v.f_bavail * v.f_frsize;
        if (i && now == last) return now;
        last = now; pause_ms(200);
    }
    return last;
}
static void run_pool_instance(struct env *e) {
    struct env p; memset(&p, 0, sizeof(p)); p.mnt = e->mnt;
    p.broker_root = open_dir(e->mnt, "pool-root"); p.state = open_dir(e->mnt, "pool-state");
    struct stat rs;
    if (p.broker_root < 0 || p.state < 0 || fchown(p.broker_root, 0, writer_gid) < 0 ||
        fchmod(p.broker_root, 0710) < 0 || fchmod(p.state, 0700) < 0 || fstat(p.broker_root, &rs) < 0) {
        verdict(0, "pool_instance", "setup: %s", strerror(errno)); goto out;
    }
    uint64_t available = settled_available(p.broker_root);
    if (available < 8 * BYTES_HARD) { verdict(0, "pool_instance", "only %llu B free", (unsigned long long)available); goto out; }
    struct qb_policy *q = &p.policy;
    *q = e->policy;
    if (getrandom(q->epoch, sizeof(q->epoch), 0) != (ssize_t)sizeof(q->epoch)) refuse("getrandom");
    q->epoch[0] |= 1;
    q->root_device = (uint64_t)rs.st_dev; q->root_inode = (uint64_t)rs.st_ino;
    q->first_project = POOL_FIRST; q->last_project = POOL_LAST; q->grant_count = 0;
    memset(q->grants, 0, sizeof(q->grants));
    q->layout = QB_LAYOUT_SHARED; q->access_gid = writer_gid; q->content_uid = writer_uid;
    q->added_peer_uid = PEER;
    /* Room for 3.5 pools: U1 (raised to 2) + U2 fit, a third pool does not. */
    q->reserve_bytes = (available - 7 * BYTES_HARD / 2) / 4096 * 4096;
    if (qb_bootstrap(p.state, q) < 0 || broker_start(&p) < 0) {
        verdict(0, "pool_instance", "bootstrap/start: %s", strerror(errno)); goto out;
    }
    out("INFO pool instance (service model): shared layout, no bootstrap users, projects %u-%u, %llu B / %llu "
        "inodes per pool, reserve %llu B of %llu B free, access gid %u, workload uid %u\n", POOL_FIRST, POOL_LAST,
        (unsigned long long)BYTES_HARD, (unsigned long long)INODES_HARD, (unsigned long long)q->reserve_bytes,
        (unsigned long long)available, (unsigned)writer_gid, (unsigned)writer_uid);
    uint64_t inode = 0;
    check_pool_add(&p, &inode);
    if (p.broker) check_pool_raise(&p);
    if (p.broker) check_pool_overcommit(&p);
    if (p.broker) check_full_pool_history(&p);
    if (!p.broker) verdict(0, "pool_instance", "broker did not restart");
out:
    broker_stop(&p);
    if (p.broker_root >= 0) close(p.broker_root);
    if (p.state >= 0) close(p.state);
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
#ifdef QB_ACCEPTANCE_SQL_SELFTEST
/* Unprivileged self-test of the writer-side SQLite code above (make acceptance-sql-test). Not
 * the pinned binary. "Full" is modelled with RLIMIT_FSIZE at the current file sizes (writes
 * that would grow a file fail like ENOSPC); the real pool-full behaviour is only proven by the
 * owner-run acceptance on XFS. */
#include <sys/resource.h>
static struct rlimit saved_limit;
static int self_dir = -1;
static void fill_rlimit(void *ctx, struct wres *r) {
    (void)ctx;
    off_t largest = 0;
    const char *names[] = {"workspace.sqlite", "workspace.sqlite-wal"};
    for (int i = 0; i < 2; i++) {
        struct stat st;
        if (fstatat(self_dir, names[i], &st, 0) == 0 && st.st_size > largest) largest = st.st_size;
    }
    struct rlimit cap = saved_limit; cap.rlim_cur = (rlim_t)largest;
    r->fill_count = (uint64_t)largest;
    r->fill_errno = setrlimit(RLIMIT_FSIZE, &cap) < 0 ? errno : ENOSPC;
}
int main(int argc, char **argv) {
    if (geteuid() == 0 || argc != 2) { fprintf(stderr, "usage (not root): %s EMPTY-DIR\n", argv[0]); return 2; }
    self_dir = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (self_dir < 0 || getrlimit(RLIMIT_FSIZE, &saved_limit) < 0) { perror(argv[1]); return 2; }
    signal(SIGXFSZ, SIG_IGN);
    uint64_t want = expected_checksum();
    struct wres run, fresh, v1, after, v2;
    memset(&run, 0, sizeof(run)); sql_running(self_dir, &run, fill_rlimit, NULL);
    memset(&fresh, 0, sizeof(fresh)); sql_body(self_dir, W_SQL_FULL, &fresh); /* still capped */
    if (setrlimit(RLIMIT_FSIZE, &saved_limit) < 0) { perror("setrlimit"); return 1; }
    int run_ok = !run.error && run.wal && run.count == SQL_ROWS && run.checksum_before == want &&
                 run.fill_errno == ENOSPC && run.rc_big != SQLITE_OK && run.rows == SQL_ROWS && run.checksum == want &&
                 run.integrity_ok && run.big_len == -1 && !run.error2;
    printf("%s running store: %llu rows (wal %d), files capped at %llu B, big write -> %d (%s), %d/%d small ok, rows "
           "%llu checksum %s integrity %d\n", run_ok ? "ok" : "FAIL", (unsigned long long)run.count, run.wal,
           (unsigned long long)run.fill_count, run.rc_big, run.detail, run.small_ok, SQL_SMALL,
           (unsigned long long)run.rows, run.checksum == want ? "ok" : "BAD", run.integrity_ok);
    printf("info fresh open while capped: error %d/%d rows %llu checksum %s, store open sequence -> %d %s\n",
           fresh.error, fresh.error2, (unsigned long long)fresh.rows, fresh.checksum == want ? "ok" : "BAD",
           fresh.rc_store, fresh.detail);
    memset(&v1, 0, sizeof(v1)); sql_body(self_dir, W_SQL_VERIFY, &v1);
    int v1_ok = !v1.error && v1.rows == SQL_ROWS && v1.checksum == want && v1.integrity_ok && v1.big_len == -1 &&
                (v1.mask & run.mask) == run.mask;
    printf("%s reopen: rows %llu checksum %s integrity %d big %lld ok-writes %s\n", v1_ok ? "ok" : "FAIL",
           (unsigned long long)v1.rows, v1.checksum == want ? "ok" : "BAD", v1.integrity_ok, (long long)v1.big_len,
           (v1.mask & run.mask) == run.mask ? "present" : "MISSING");
    memset(&after, 0, sizeof(after)); sql_body(self_dir, W_SQL_AFTER_FREE, &after);
    memset(&v2, 0, sizeof(v2)); sql_body(self_dir, W_SQL_VERIFY, &v2);
    int after_ok = !after.error && after.rc_big == SQLITE_OK && !v2.error && v2.big_len == SQL_BIG &&
                   v2.rows == SQL_ROWS && v2.checksum == want && v2.integrity_ok && (v2.mask & run.mask) == run.mask;
    printf("%s after free: big write -> %d, reopen big %lld B rows %llu integrity %d\n", after_ok ? "ok" : "FAIL",
           after.rc_big, (long long)v2.big_len, (unsigned long long)v2.rows, v2.integrity_ok);
    printf("sqlite %s; acceptance SQL self-test %s (RLIMIT_FSIZE model, not XFS)\n", sqlite3_libversion(),
           run_ok && v1_ok && after_ok ? "PASS" : "FAIL");
    return run_ok && v1_ok && after_ok ? 0 : 1;
}
#else
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
        mkdirat(e.mnt, "other", 0700) < 0 || mkdirat(e.mnt, "pool-root", 0700) < 0 ||
        mkdirat(e.mnt, "pool-state", 0700) < 0) refuse("setup mkdir: %s", strerror(errno));
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
    run_pool_instance(&e);
    close(e.broker_root); close(e.state); close(e.mnt);
    out("RESULT: %s (%d passed, %d failed)\n", failed || !passed ? "FAIL" : "PASS", passed, failed);
    return failed || !passed ? 1 : 0;
}
#endif
