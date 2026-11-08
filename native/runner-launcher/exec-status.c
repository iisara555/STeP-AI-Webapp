#define _GNU_SOURCE
#include "exec-status.h"
#include "launcher.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int srl_status_prepare(uid_t trusted_peer) {
    struct ucred peer;
    socklen_t len = sizeof peer;
    int type = 0;
    socklen_t tlen = sizeof type;
    struct sockaddr_un address;
    socklen_t alen = sizeof address;
    if (getsockopt(SRL_STATUS_FD, SOL_SOCKET, SO_TYPE, &type, &tlen) ||
        type != SOCK_SEQPACKET || getsockname(SRL_STATUS_FD, (struct sockaddr *)&address, &alen) ||
        address.sun_family != AF_UNIX ||
        getsockopt(SRL_STATUS_FD, SOL_SOCKET, SO_PEERCRED, &peer, &len) ||
        len != sizeof peer || peer.uid != trusted_peer || peer.pid <= 0 ||
        getpeername(SRL_STATUS_FD, (struct sockaddr *)&address, &alen) ||
        fcntl(SRL_STATUS_FD, F_SETFD, FD_CLOEXEC)) return -1;
    /* Never block a launch fence on an undrained status channel. */
    int flags = fcntl(SRL_STATUS_FD, F_GETFL);
    if (flags < 0 || fcntl(SRL_STATUS_FD, F_SETFL, flags | O_NONBLOCK)) return -1;
    return 0;
}

int srl_status_send(unsigned int stage, unsigned int error, unsigned int exec_errno) {
    uint32_t wire[4] = {htonl(SRL_STATUS_MAGIC), htonl(stage), htonl(error), htonl(exec_errno)};
    ssize_t n;
    do { n = send(SRL_STATUS_FD, wire, sizeof wire, MSG_NOSIGNAL | MSG_DONTWAIT); }
    while (n < 0 && errno == EINTR);
    return n == sizeof wire ? 0 : -1;
}

int srl_status_receive(int fd, struct srl_exec_status *status) {
    if (!status || status->invalid || status->ambiguous_terminal) { errno = EINVAL; return -1; }
    uint32_t wire[4];
    char control[CMSG_SPACE(sizeof(int) * 16)];
    struct iovec iov = {.iov_base = wire, .iov_len = sizeof wire};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
                         .msg_control = control, .msg_controllen = sizeof control};
    ssize_t n;
    do { n = recvmsg(fd, &msg, MSG_DONTWAIT | MSG_CMSG_CLOEXEC); } while (n < 0 && errno == EINTR);
    if (n < 0) return -1;
    int ancillary = msg.msg_controllen != 0;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            int *fds = (int *)CMSG_DATA(c);
            for (size_t i = 0; i < count; i++) close(fds[i]);
        }
    }
    if (!ancillary && !(msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) && n == 0) {
        /* recvmsg(0) can be a live empty seqpacket, not just peer closure.
         * Stop conservatively; polling hangup cannot identify this record and
         * a peer may close concurrently or leave later records queued. */
        status->ambiguous_terminal = 1;
        return 0;
    }
    if (ancillary || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) || n != sizeof wire ||
        ntohl(wire[0]) != SRL_STATUS_MAGIC) goto invalid;
    unsigned int stage = ntohl(wire[1]), error = ntohl(wire[2]), exec_errno = ntohl(wire[3]);
    if (stage == SRL_STATUS_ENTERED && status->stage == 0 && !error && !exec_errno)
        status->stage = stage;
    else if (stage == SRL_STATUS_VALIDATED && status->stage == SRL_STATUS_ENTERED && !error && !exec_errno)
        status->stage = stage;
    else if (stage == SRL_STATUS_LAUNCH_EXEC_FAILED && status->stage == 0 && !error && exec_errno) {
        status->stage = stage;
        status->exec_errno = exec_errno;
    } else if (stage == SRL_STATUS_FAILED &&
             (status->stage == SRL_STATUS_ENTERED || status->stage == SRL_STATUS_VALIDATED) && error &&
             error <= SRL_E_INTERNAL && (!exec_errno ||
             (status->stage == SRL_STATUS_VALIDATED && error == SRL_E_INTERNAL))) {
        status->stage = stage;
        status->error = error;
        status->exec_errno = exec_errno;
    } else goto invalid;
    return 1;
invalid:
    status->invalid = 1;
    errno = EPROTO;
    return -1;
}
