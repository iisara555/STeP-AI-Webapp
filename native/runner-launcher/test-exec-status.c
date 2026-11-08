/* Unprivileged protocol/adversarial tests; no principal switch or real bwrap. */
#define _GNU_SOURCE
#include "exec-status.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static void pair_new(int p[2]) {
    assert(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, p) == 0);
}
static void frame(int fd, unsigned int stage) {
    uint32_t w[4] = {htonl(SRL_STATUS_MAGIC), htonl(stage), 0, 0};
    assert(send(fd, w, sizeof w, MSG_NOSIGNAL) == sizeof w);
}
int main(void) {
    assert(getuid() != 0);
    for (unsigned int stage = 0; stage <= 2; stage++) {
        int p[2]; pair_new(p);
        pid_t child = fork(); assert(child >= 0);
        if (!child) {
            close(p[0]);
            if (stage >= 1) frame(p[1], SRL_STATUS_ENTERED);
            if (stage >= 2) frame(p[1], SRL_STATUS_VALIDATED);
            kill(getpid(), SIGKILL);
            _exit(99);
        }
        close(p[1]);
        int exit_status; assert(waitpid(child, &exit_status, 0) == child);
        assert(WIFSIGNALED(exit_status));
        struct srl_exec_status s = {0};
        for (unsigned int i = 0; i < stage; i++) assert(srl_status_receive(p[0], &s) == 1);
        assert(srl_status_receive(p[0], &s) == 0 && s.eof && s.stage == stage);
        /* stage 2 + EOF is identical to a successful exec: NO ready bit exists. */
        close(p[0]);
    }
    for (int mode = 0; mode < 5; mode++) {
        int p[2]; pair_new(p);
        struct srl_exec_status s = {0};
        if (mode == 0) frame(p[1], SRL_STATUS_VALIDATED); /* out of order */
        if (mode == 1) {
            frame(p[1], SRL_STATUS_ENTERED);
            assert(srl_status_receive(p[0], &s) == 1);
            frame(p[1], SRL_STATUS_ENTERED); /* duplicate */
        }
        if (mode == 2) assert(send(p[1], "x", 1, 0) == 1);
        if (mode == 3) { char large[17] = {0}; assert(send(p[1], large, sizeof large, 0) == sizeof large); }
        if (mode == 4) {
            uint32_t w[4] = {htonl(SRL_STATUS_MAGIC), htonl(SRL_STATUS_ENTERED), 0, 0};
            char control[CMSG_SPACE(sizeof(int))] = {0};
            struct iovec iov = {.iov_base = w, .iov_len = sizeof w};
            struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
                                 .msg_control = control, .msg_controllen = sizeof control};
            struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
            c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
            *(int *)CMSG_DATA(c) = p[1];
            assert(sendmsg(p[1], &msg, 0) == sizeof w);
        }
        assert(srl_status_receive(p[0], &s) == -1 && errno == EPROTO && s.invalid);
        assert(srl_status_receive(p[0], &s) == -1 && s.invalid);
        close(p[0]); close(p[1]);
    }
    int p[2]; pair_new(p);
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
        assert(dup2(p[1], SRL_STATUS_FD) == SRL_STATUS_FD);
        assert(srl_status_prepare(getuid() + 1) == -1); /* wrong trusted creator */
        assert(srl_status_prepare(getuid()) == 0);
        assert(fcntl(SRL_STATUS_FD, F_GETFD) & FD_CLOEXEC);
        close(p[0]);
        struct pollfd closed = {.fd = SRL_STATUS_FD, .events = POLLIN};
        assert(poll(&closed, 1, 2000) > 0);
        assert(srl_status_send(SRL_STATUS_ENTERED, 0, 0) == -1); /* peer gone */
        _exit(0); /* MSG_NOSIGNAL survives EPIPE */
    }
    close(p[0]); close(p[1]);
    int exit_status; assert(waitpid(child, &exit_status, 0) == child);
    assert(WIFEXITED(exit_status) && WEXITSTATUS(exit_status) == 0);
    puts("test-exec-status: crash at 3 stages, 5 hostile frames, peer identity and broken peer passed");
    return 0;
}
