#ifndef STEP_QUOTA_TRANSPORT_H
#define STEP_QUOTA_TRANSPORT_H
#include "core.h"
#define QB_TRANSPORT_CLIENTS 8
#define QB_TRANSPORT_DEADLINE_MS 500
#define QB_TRANSPORT_ACCEPT_BACKOFF_MS 50
/* Longest request (WORKSPACE/1) is 86 bytes; longest reply (OK/3: u32 + 6 x u64 + UUID)
 * is 179 bytes plus NUL. */
#define QB_TRANSPORT_FRAME_MAX 86
#define QB_TRANSPORT_REPLY_MAX 256
/* Trusted startup only. No listener creation, paths, config parsing or bootstrap.
 * listener: protected AF_UNIX listening STREAM, NONBLOCK and CLOEXEC.
 * stop_fd: separate protected pollable descriptor; readability requests drain.
 * Borrowed FDs/broker must remain alive until run returns; never run twice on the
 * same listener. Caller joins this loop before qb_close/adapter destruction.
 * Single loop, no detached threads or unbounded queue. Synchronous trusted core
 * callbacks must terminate; stop cannot cancel an in-flight durable mutation.
 * allow_uid is a fixed protected client principal, NOT end-user authentication.
 */
/* Success reply v2 (see transport.c). Exposed for tests and the service. */
int qb_transport_format_ok(const struct qb_receipt *receipt, char *out, size_t size);
int qb_transport_format_workspace(const struct qb_workspace_receipt *receipt, char *out, size_t size);
int qb_transport_format_usage(const struct qb_usage *usage, char *out, size_t size);
int qb_transport_run(struct qb *broker, int listener, int stop_fd, uid_t allow_uid);
#endif
