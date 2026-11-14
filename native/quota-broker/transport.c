#define _GNU_SOURCE
#include "transport.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct client { int fd; uid_t peer_uid; size_t used; int64_t deadline; unsigned char bytes[QB_TRANSPORT_FRAME_MAX + 1]; };
static int64_t now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) return -1;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void drop(struct client *c) {
    if (c->fd >= 0) close(c->fd);
    memset(c, 0, sizeof(*c)); c->fd = -1;
}
/* Fixed tiny best-effort nonblocking responses; a partial send is not success.
 * Denial carries nothing (no errno, policy or identity). Success replies carry
 * ONLY values the core just verified under its authority for the authenticated
 * peer's own granted user subject, as fixed-format decimal/UUID text:
 *   ENSURE/1    -> OK/2 <project> <device> <inode> <bytes_hard> <inodes_hard> <mount-uuid>\n
 *   WORKSPACE/1 -> OK/3 <project> <device> <user-inode> <workspace-inode> <bytes_hard>
 *                       <inodes_hard> <mount-uuid>\n            (one line)
 *   USAGE/1     -> USAGE/1 <project> <bytes_used> <bytes_hard> <inodes_used> <inodes_hard>\n
 * No path (directories are the fixed p<project>[/<workspace-uuid>] names under the
 * fixed root), errno, other subject, FD or SCM_RIGHTS is ever sent. */
static int uuid_text(const uint8_t *u, char out[37]) {
    return snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                    u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11],
                    u[12], u[13], u[14], u[15]) == 36 ? 0 : -1;
}
static int fit(int n, size_t size) {
    if (n < 0 || (size_t)n >= size) { errno = EOVERFLOW; return -1; }
    return n;
}
int qb_transport_format_ok(const struct qb_receipt *r, char *out, size_t size) {
    char u[37];
    if (uuid_text(r->mount_uuid, u) < 0) return -1;
    return fit(snprintf(out, size, "OK/2 %u %llu %llu %llu %llu %s\n", r->project,
                        (unsigned long long)r->device, (unsigned long long)r->inode,
                        (unsigned long long)r->bytes_hard, (unsigned long long)r->inodes_hard, u), size);
}
int qb_transport_format_workspace(const struct qb_workspace_receipt *r, char *out, size_t size) {
    char u[37];
    if (uuid_text(r->mount_uuid, u) < 0) return -1;
    return fit(snprintf(out, size, "OK/3 %u %llu %llu %llu %llu %llu %s\n", r->project,
                        (unsigned long long)r->device, (unsigned long long)r->user_inode,
                        (unsigned long long)r->inode, (unsigned long long)r->bytes_hard,
                        (unsigned long long)r->inodes_hard, u), size);
}
int qb_transport_format_usage(const struct qb_usage *u, char *out, size_t size) {
    return fit(snprintf(out, size, "USAGE/1 %u %llu %llu %llu %llu\n", u->project,
                        (unsigned long long)u->bytes_used, (unsigned long long)u->bytes_hard,
                        (unsigned long long)u->inodes_used, (unsigned long long)u->inodes_hard), size);
}
static void reply(struct client *c, const char *text, int n) {
    if (n < 0) { text = "DENIED/1\n"; n = 9; }
    (void)send(c->fd, text, (size_t)n, MSG_NOSIGNAL|MSG_DONTWAIT);
    drop(c);
}
static void finish(struct client *c, const void *unused) { (void)unused; reply(c, NULL, -1); }
/* One complete frame (write EOF seen). The core revalidates the exact frame. */
static void serve(struct qb *broker, struct client *c) {
    char text[QB_TRANSPORT_REPLY_MAX];
    int n = -1;
    if (c->used == 46 && !memcmp(c->bytes, "ENSURE/1 ", 9)) {
        struct qb_receipt r;
        if (qb_ensure(broker, c->peer_uid, c->bytes, c->used, &r) == 0) {
            close(r.directory_fd); /* NEVER transmit a launch FD. */
            n = qb_transport_format_ok(&r, text, sizeof(text));
        }
    } else if (c->used == 86 && !memcmp(c->bytes, "WORKSPACE/1 ", 12)) {
        struct qb_workspace_receipt r;
        if (qb_workspace(broker, c->peer_uid, c->bytes, c->used, &r) == 0) {
            close(r.directory_fd);
            n = qb_transport_format_workspace(&r, text, sizeof(text));
        }
    } else if (c->used == 45 && !memcmp(c->bytes, "USAGE/1 ", 8)) {
        struct qb_usage u;
        if (qb_usage(broker, c->peer_uid, c->bytes, c->used, &u) == 0)
            n = qb_transport_format_usage(&u, text, sizeof(text));
    }
    reply(c, text, n);
}
int qb_transport_run(struct qb *broker, int listener, int stop_fd, uid_t allow_uid) {
    struct sockaddr_un address;
    socklen_t length = sizeof(address);
    int listening = 0, type = 0;
    socklen_t option_length = sizeof(int);
    if (!broker || listener < 0 || stop_fd < 0 || listener == stop_fd ||
        fcntl(stop_fd, F_GETFD) < 0 ||
        getsockname(listener, (struct sockaddr *)&address, &length) < 0 ||
        address.sun_family != AF_UNIX ||
        getsockopt(listener, SOL_SOCKET, SO_TYPE, &type, &option_length) < 0 || type != SOCK_STREAM ||
        getsockopt(listener, SOL_SOCKET, SO_ACCEPTCONN, &listening, &option_length) < 0 || !listening ||
        !(fcntl(listener, F_GETFL) & O_NONBLOCK) || !(fcntl(listener, F_GETFD) & FD_CLOEXEC)) {
        errno = EINVAL; return -1;
    }
    /* Fixed pending queue as well as fixed accepted slots. Linux may keep one
     * additional pending connection; kernel socket memory accounting still applies. */
    if (listen(listener, QB_TRANSPORT_CLIENTS) < 0) return -1;
    struct client clients[QB_TRANSPORT_CLIENTS];
    for (size_t i = 0; i < QB_TRANSPORT_CLIENTS; i++) clients[i] = (struct client){.fd = -1};
    int result = -1;
    int64_t accept_resume = 0;
    for (;;) {
        struct pollfd p[QB_TRANSPORT_CLIENTS+2];
        p[0] = (struct pollfd){stop_fd, POLLIN, 0};
        p[1] = (struct pollfd){listener, POLLIN, 0};
        int64_t now = now_ms(); if (now < 0) break;
        int timeout = QB_TRANSPORT_DEADLINE_MS;
        for (size_t i = 0; i < QB_TRANSPORT_CLIENTS; i++) {
            p[i+2] = (struct pollfd){clients[i].fd, POLLIN, 0};
            if (clients[i].fd >= 0) {
                int64_t left = clients[i].deadline - now;
                if (left < timeout) timeout = left > 0 ? (int)left : 0;
            }
        }
        /* Resource exhaustion at accept pauses accepting for a short fixed back-off
         * (no busy loop, pending peers stay queued) instead of ending the service. */
        if (accept_resume > now) {
            p[1].fd = -1;
            int64_t left = accept_resume - now;
            if (left < timeout) timeout = (int)left;
        }
        int n = poll(p, QB_TRANSPORT_CLIENTS+2, timeout);
        if (n < 0) { if (errno == EINTR) continue; break; }
        /* Stop wins over readiness, and returns only after closing every client. */
        if (p[0].revents) { result = (p[0].revents & POLLIN) ? 0 : -1; break; }
        if (p[1].revents & (POLLERR|POLLHUP|POLLNVAL)) { errno = EIO; break; }
        now = now_ms(); if (now < 0) break;
        for (size_t i = 0; i < QB_TRANSPORT_CLIENTS; i++) {
            struct client *c = &clients[i];
            if (c->fd < 0) continue;
            /* A previous synchronous core call may have taken time. Never use a
             * stale pre-mutation timestamp to admit a different expired client. */
            now = now_ms(); if (now < 0) goto done;
            if (now >= c->deadline) { finish(c, NULL); continue; }
            if (p[i+2].revents & (POLLERR|POLLNVAL)) { drop(c); continue; }
            if (!(p[i+2].revents & (POLLIN|POLLHUP))) continue;
            struct iovec input = {c->bytes+c->used, sizeof(c->bytes)-c->used};
            struct msghdr message = {.msg_iov=&input, .msg_iovlen=1};
            /* No ancillary buffer: Linux closes undisclosed SCM_RIGHTS rather
             * than installing them. MSG_CTRUNC makes any such request deny. */
            ssize_t got = recvmsg(c->fd, &message, MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
            if (got < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) drop(c);
                continue;
            }
            if (message.msg_flags & MSG_CTRUNC) { finish(c, NULL); continue; }
            c->used += (size_t)got;
            if (c->used > QB_TRANSPORT_FRAME_MAX) { finish(c, NULL); continue; }
            if (got != 0) continue; /* Require write EOF: no pipelining/trailing data. */
            /* Core revalidates exact protocol + workspace grant under authority.
             * Credentials were checked before any read, not derived from bytes. */
            serve(broker, c);
        }
        if (p[1].revents & POLLIN) {
            /* Bounded accept batch prevents a connection flood starving stop/deadlines. */
            for (size_t batch = 0; batch < QB_TRANSPORT_CLIENTS; batch++) {
                int fd = accept4(listener, NULL, NULL, SOCK_CLOEXEC|SOCK_NONBLOCK);
                if (fd < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) break;
                    if (errno == EMFILE || errno == ENFILE || errno == ENOBUFS || errno == ENOMEM) {
                        int64_t paused = now_ms(); if (paused < 0) goto done;
                        accept_resume = paused + QB_TRANSPORT_ACCEPT_BACKOFF_MS; break;
                    }
                    /* Per accept(2): one aborted/failed pending connection, not the listener. */
                    if (errno == ECONNABORTED || errno == EPROTO || errno == EPERM) continue;
                    goto done; /* EBADF/EINVAL/ENOTSOCK...: listener itself is unusable. */
                }
                struct ucred peer;
                socklen_t peer_length = sizeof(peer);
                /* No read/parse/reply to untrusted principal, including at capacity. */
                if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_length) < 0 ||
                    peer_length != sizeof(peer) || peer.uid != allow_uid) { close(fd); continue; }
                int buffer = 1024;
                if (setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buffer, sizeof(buffer)) < 0 ||
                    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &buffer, sizeof(buffer)) < 0) {
                    close(fd); continue;
                }
                size_t slot;
                for (slot = 0; slot < QB_TRANSPORT_CLIENTS; slot++) if (clients[slot].fd < 0) break;
                if (slot == QB_TRANSPORT_CLIENTS) { close(fd); continue; }
                int64_t accepted = now_ms();
                if (accepted < 0) { close(fd); goto done; }
                clients[slot] = (struct client){.fd=fd, .peer_uid=peer.uid,
                    .deadline=accepted+QB_TRANSPORT_DEADLINE_MS};
            }
        }
    }
done:
    for (size_t i = 0; i < QB_TRANSPORT_CLIENTS; i++) drop(&clients[i]);
    return result;
}
