#define _GNU_SOURCE
#include "transport.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct client { int fd; uid_t peer_uid; size_t used; int64_t deadline; unsigned char bytes[47]; };
static int64_t now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) return -1;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void drop(struct client *c) {
    if (c->fd >= 0) close(c->fd);
    memset(c, 0, sizeof(*c)); c->fd = -1;
}
/* Fixed tiny best-effort nonblocking response. Never leak errno, policy,
 * identities, paths, project IDs, limits or FDs. Partial send is not success. */
static void finish(struct client *c, int ok) {
    const char *reply = ok ? "OK/1\n" : "DENIED/1\n";
    (void)send(c->fd, reply, strlen(reply), MSG_NOSIGNAL|MSG_DONTWAIT);
    drop(c);
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
            if (now >= c->deadline) { finish(c, 0); continue; }
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
            if (message.msg_flags & MSG_CTRUNC) { finish(c, 0); continue; }
            c->used += (size_t)got;
            if (c->used > 46) { finish(c, 0); continue; }
            if (got != 0) continue; /* Require write EOF: no pipelining/trailing data. */
            /* Core revalidates exact protocol + workspace grant under authority.
             * Credentials were checked before any read, not derived from bytes. */
            struct qb_receipt receipt;
            int ok = qb_ensure(broker, c->peer_uid, c->bytes, c->used, &receipt) == 0;
            if (ok) close(receipt.directory_fd); /* NEVER transmit a launch FD. */
            finish(c, ok);
        }
        if (p[1].revents & POLLIN) {
            /* Bounded accept batch prevents a connection flood starving stop/deadlines. */
            for (size_t batch = 0; batch < QB_TRANSPORT_CLIENTS; batch++) {
                int fd = accept4(listener, NULL, NULL, SOCK_CLOEXEC|SOCK_NONBLOCK);
                if (fd < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) break;
                    goto done;
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
