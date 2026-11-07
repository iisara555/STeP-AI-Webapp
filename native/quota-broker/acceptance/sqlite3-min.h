/* Minimal subset of the public SQLite C API (sqlite3.h, SQLite is in the public domain) used by
 * the owner-run XFS acceptance (xfs-acceptance.c, full-pool history check). The host has the
 * runtime library (libsqlite3.so.0, package libsqlite3-0) but not the -dev header; these
 * declarations are copied verbatim from sqlite3.h 3.46.1 and only stable, documented entry
 * points are used. Linked with -l:libsqlite3.so.0. */
#ifndef STEP_SQLITE3_MIN_H
#define STEP_SQLITE3_MIN_H
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
typedef long long int sqlite3_int64;
typedef void (*sqlite3_destructor_type)(void *);
#define SQLITE_OK 0
#define SQLITE_IOERR 10
#define SQLITE_FULL 13
#define SQLITE_ROW 100
#define SQLITE_DONE 101
#define SQLITE_OPEN_READWRITE 0x00000002
#define SQLITE_OPEN_CREATE 0x00000004
#define SQLITE_OPEN_NOFOLLOW 0x01000000
#define SQLITE_TRANSIENT ((sqlite3_destructor_type)-1)
const char *sqlite3_libversion(void);
int sqlite3_open_v2(const char *filename, sqlite3 **ppDb, int flags, const char *zVfs);
int sqlite3_close(sqlite3 *);
int sqlite3_extended_result_codes(sqlite3 *, int onoff);
int sqlite3_busy_timeout(sqlite3 *, int ms);
int sqlite3_exec(sqlite3 *, const char *sql, int (*callback)(void *, int, char **, char **), void *,
                 char **errmsg);
int sqlite3_prepare_v2(sqlite3 *db, const char *zSql, int nByte, sqlite3_stmt **ppStmt, const char **pzTail);
int sqlite3_bind_text(sqlite3_stmt *, int, const char *, int, void (*)(void *));
int sqlite3_step(sqlite3_stmt *);
int sqlite3_reset(sqlite3_stmt *pStmt);
int sqlite3_finalize(sqlite3_stmt *pStmt);
sqlite3_int64 sqlite3_column_int64(sqlite3_stmt *, int iCol);
const unsigned char *sqlite3_column_text(sqlite3_stmt *, int iCol);
int sqlite3_column_bytes(sqlite3_stmt *, int iCol);
int sqlite3_extended_errcode(sqlite3 *db);
const char *sqlite3_errmsg(sqlite3 *);
#endif
