#define _GNU_SOURCE
#include "transport.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <poll.h>
#include <pthread.h>
#include <sys/resource.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef NDEBUG
#error Tests require assertions
#endif
static const char request[] = "ENSURE/1 12345678-1234-4234-8234-000000000000\n";
struct model { struct qb_observation value; int blocking, release[2], entered[2]; };
static int mount_fake(void *ctx, int fd, uint8_t uuid[16], int *enforced) {
    (void)ctx; (void)fd; memset(uuid, 0, 16); uuid[0] = 42; *enforced = 1; return 0;
}
static int observe_fake(void *ctx, int root, int dir, uint32_t project, struct qb_observation *out) {
    (void)root; (void)dir; (void)project; *out = ((struct model *)ctx)->value; return 0;
}
static int configure_fake(void *ctx, int root, int dir, uint32_t project, uint64_t bytes, uint64_t inodes) {
    (void)root; (void)dir;
    struct model *m=ctx;
    if (m->blocking) {
        assert(write(m->entered[1], "C", 1) == 1);
        char release; assert(read(m->release[0], &release, 1) == 1 && release == 'C');
    }
    ((struct model *)ctx)->value = (struct qb_observation){.project = project, .bytes_hard = bytes, .inodes_hard = inodes, .inherit = 1}; return 0;
}
static int remove_item(const char *p, const struct stat *s, int t, struct FTW *w) {
    (void)s; (void)t; (void)w; return remove(p);
}
struct fixture { char path[108]; struct sockaddr_un address; int base, root, state, listener, stop, control[2], ack[2], denied; struct qb *broker; pid_t child; struct model model; };
static struct fixture *current;
static void *service_thread(void *context) {
    struct fixture *f=context;
    int result=qb_transport_run(f->broker, f->listener, f->stop, f->denied ? geteuid()+1 : geteuid());
    assert(result == 0); return NULL;
}
static void setup(struct fixture *f, int denied, int revoked) {
    memset(f, 0, sizeof(*f)); current = f;
    const char *tmp = getenv("TMPDIR"); assert(tmp && tmp[0] == '/');
    int n = snprintf(f->path, sizeof(f->path), "%s/qbt-XXXXXX", tmp); assert(n > 0 && (size_t)n < sizeof(f->path));
    assert(mkdtemp(f->path));
    f->base = open(f->path, O_RDONLY|O_DIRECTORY|O_CLOEXEC); assert(f->base >= 0);
    assert(mkdirat(f->base, "root", 0700) == 0 && mkdirat(f->base, "state", 0700) == 0);
    f->root = openat(f->base, "root", O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    f->state = openat(f->base, "state", O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    assert(f->root >= 0 && f->state >= 0);
    struct stat st; assert(fstat(f->root, &st) == 0);
    struct qb_policy policy = {.root_device=(uint64_t)st.st_dev, .root_inode=(uint64_t)st.st_ino,
        .bytes_hard=1048576, .inodes_hard=100, .first_project=100000, .last_project=100001, .grant_count=1};
    policy.epoch[0]=19; policy.mount_uuid[0]=42; policy.grants[0].peer_uid=(uint32_t)geteuid();
    memcpy(policy.grants[0].workspace, request+9, 36);
    struct qb_adapter adapter = {&f->model, mount_fake, observe_fake, configure_fake, NULL};
    assert(qb_bootstrap(f->state, &policy) == 0);
    assert(qb_open(f->root, f->state, &policy, &adapter, &f->broker) == 0);
    if (revoked == 1) assert(qb_revoke(f->broker, policy.grants[0].workspace) == 0);
    f->model.blocking=(revoked == 2);
    assert(pipe2(f->model.release, O_CLOEXEC) == 0 && pipe2(f->model.entered, O_CLOEXEC) == 0);
    f->address.sun_family=AF_UNIX;
    n=snprintf(f->address.sun_path, sizeof(f->address.sun_path), "%s/socket", f->path);
    assert(n > 0 && (size_t)n < sizeof(f->address.sun_path));
    f->listener=socket(AF_UNIX, SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC, 0); assert(f->listener >= 0);
    assert(bind(f->listener, (struct sockaddr *)&f->address, sizeof(f->address)) == 0);
    assert(chmod(f->address.sun_path, 0600) == 0 && listen(f->listener, QB_TRANSPORT_CLIENTS) == 0);
    f->stop=eventfd(0, EFD_CLOEXEC|EFD_NONBLOCK); assert(f->stop >= 0);
    f->denied=denied;
    assert(pipe2(f->control, O_CLOEXEC) == 0 && pipe2(f->ack, O_CLOEXEC) == 0);
    f->child=fork(); assert(f->child >= 0);
    if (!f->child) {
        alarm(20);
        close(f->control[1]); close(f->ack[0]);
        struct rlimit bound={64, 64}; assert(setrlimit(RLIMIT_NOFILE, &bound) == 0);
        pthread_t service; assert(pthread_create(&service, NULL, service_thread, f) == 0);
        char command;
        int spare[64]; int spares=0;
        while (read(f->control[0], &command, 1) == 1 && command != 'Q') {
            if (command == 'E') { /* exhaust the descriptor table under the service */
                int fd;
                while (spares < 64 && (fd=dup(f->control[0])) >= 0) spare[spares++]=fd;
                assert(errno == EMFILE);
                assert(write(f->ack[1], "E", 1) == 1); continue;
            }
            if (command == 'F') {
                while (spares) close(spare[--spares]);
                assert(write(f->ack[1], "F", 1) == 1); continue;
            }
            assert(command == 'R');
            assert(qb_revoke(f->broker, policy.grants[0].workspace) == 0);
            assert(write(f->ack[1], "R", 1) == 1);
        }
        assert(pthread_join(service, NULL) == 0);
        qb_close(f->broker); _exit(0);
    }
    close(f->control[0]); close(f->ack[1]);
}
/* NULL = the success reply, which is only known once p100000 exists. */
#define OK NULL
static void ok_reply(char *out, size_t size) {
    struct stat s; assert(fstatat(current->root, "p100000", &s, AT_SYMLINK_NOFOLLOW) == 0);
    int n = snprintf(out, size, "OK/2 100000 %llu %llu 1048576 100 2a000000-0000-0000-0000-000000000000\n",
                     (unsigned long long)s.st_dev, (unsigned long long)s.st_ino);
    assert(n > 0 && (size_t)n < size);
}
static int connect_client(struct fixture *f) {
    int fd=socket(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0); assert(fd >= 0);
    assert(connect(fd, (struct sockaddr *)&f->address, sizeof(f->address)) == 0); return fd;
}
static void response(int fd, const char *expected) {
    char bytes[256]; size_t used=0; char success[160];
    for (;;) {
        struct pollfd p={fd, POLLIN, 0}; assert(poll(&p, 1, 3000) > 0);
        char ancillary[CMSG_SPACE(sizeof(int)*4)];
        struct iovec io={bytes+used, sizeof(bytes)-used};
        struct msghdr message={.msg_iov=&io, .msg_iovlen=1,
            .msg_control=ancillary, .msg_controllen=sizeof(ancillary)};
        ssize_t n=recvmsg(fd, &message, MSG_CMSG_CLOEXEC);
        if (n < 0 && errno == ECONNRESET) break;
        assert(n >= 0);
        assert(message.msg_controllen == 0 && !(message.msg_flags & MSG_CTRUNC));
        if (!n) break;
        used+=(size_t)n; assert(used < sizeof(bytes));
    }
    if (!expected) { ok_reply(success, sizeof(success)); expected = success; }
    assert(used == strlen(expected) && !memcmp(bytes, expected, used)); close(fd);
}
static void exchange(struct fixture *f, const void *bytes, size_t size, const char *expected) {
    int fd=connect_client(f); assert(send(fd, bytes, size, MSG_NOSIGNAL) == (ssize_t)size);
    assert(shutdown(fd, SHUT_WR) == 0); response(fd, expected);
}
static void cleanup(struct fixture *f) {
    uint64_t one=1; assert(write(f->stop, &one, sizeof(one)) == sizeof(one));
    assert(write(f->control[1], "Q", 1) == 1); close(f->control[1]); close(f->ack[0]);
    int status; assert(waitpid(f->child, &status, 0) == f->child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(f->stop); close(f->listener); qb_close(f->broker); close(f->root); close(f->state); close(f->base);
    close(f->model.release[0]); close(f->model.release[1]);
    close(f->model.entered[0]); close(f->model.entered[1]);
    assert(nftw(f->path, remove_item, 16, FTW_DEPTH|FTW_PHYS) == 0);
}
int main(void) {
    assert(geteuid() != 0); alarm(30);
    struct fixture f; setup(&f, 0, 0);
    assert(qb_transport_run(NULL, f.listener, f.stop, geteuid()) < 0 && errno == EINVAL);
    assert(qb_transport_run(f.broker, f.root, f.stop, geteuid()) < 0 && errno == EINVAL);
    assert(qb_transport_run(f.broker, f.listener, f.listener, geteuid()) < 0 && errno == EINVAL);
    assert(fcntl(f.listener, F_SETFD, 0) == 0);
    assert(qb_transport_run(f.broker, f.listener, f.stop, geteuid()) < 0 && errno == EINVAL);
    assert(fcntl(f.listener, F_SETFD, FD_CLOEXEC) == 0);
    char bad[8192];
    static const char usage[] = "USAGE/1 12345678-1234-4234-8234-000000000000\n";
    exchange(&f, usage, 45, "DENIED/1\n"); /* usage never allocates */
    exchange(&f, request, 46, OK); exchange(&f, request, 46, OK);
    exchange(&f, usage, 45, "USAGE/1 100000 0 1048576 0 100\n");
    exchange(&f, usage, 44, "DENIED/1\n");
    exchange(&f, "USAGE/1 12345678-1234-4234-8234-000000000001\n", 45, "DENIED/1\n");
    /* WORKSPACE/1 needs the shared (per-user) layout; this fixture is private. */
    exchange(&f, "WORKSPACE/1 12345678-1234-4234-8234-000000000000 aaaaaaaa-0000-4000-8000-000000000001\n",
             86, "DENIED/1\n");
    memset(bad, 'X', 87); memcpy(bad, usage, 45);
    exchange(&f, bad, 87, "DENIED/1\n"); /* longer than any frame */
    /* Strict one-shot EOF framing, no caller authority fields or error details. */
    exchange(&f, "", 0, "DENIED/1\n");
    exchange(&f, request, 45, "DENIED/1\n");
    memset(bad, 'X', sizeof(bad));
    exchange(&f, bad, sizeof(bad), "DENIED/1\n");
    memcpy(bad, request, 46); bad[12] = '\0';
    exchange(&f, bad, 46, "DENIED/1\n");
    memcpy(bad, request, 46); bad[44] = 'F';
    exchange(&f, bad, 46, "DENIED/1\n");
    memcpy(bad, request, 46); memcpy(bad+46, request, 46);
    exchange(&f, bad, 92, "DENIED/1\n");
    exchange(&f, "REVOKE/1 12345678-1234-4234-8234-000000000000\n", 46, "DENIED/1\n");
    /* Operator-only pool operations have no frame on the gateway socket. */
    exchange(&f, "ADD/1 12345678-1234-4234-8234-0000000000aa\n", 43, "DENIED/1\n");
    exchange(&f, "GRANT/1 12345678-1234-4234-8234-0000000000aa\n", 45, "DENIED/1\n");
    exchange(&f, "RAISE/1 12345678-1234-4234-8234-000000000000 2097152 200\n", 57, "DENIED/1\n");
    exchange(&f, usage, 45, "USAGE/1 100000 0 1048576 0 100\n"); /* limits unchanged */
    exchange(&f, "{\"path\":\"/etc\",\"uid\":0,\"project\":100000,\"limit\":1}", 48, "DENIED/1\n");
    exchange(&f, "ENSURE/1 12345678-1234-4234-8234-000000000001\n", 46, "DENIED/1\n");
    int fd=connect_client(&f);
    assert(send(fd, request, 20, MSG_NOSIGNAL) == 20);
    usleep(20000);
    assert(send(fd, request+20, 26, MSG_NOSIGNAL) == 26);
    assert(shutdown(fd, SHUT_WR) == 0); response(fd, OK);
    /* Complete data without EOF is not accepted; absolute timeout is not reset. */
    fd=connect_client(&f); assert(send(fd, request, 46, MSG_NOSIGNAL) == 46);
    response(fd, "DENIED/1\n");
    fd=connect_client(&f); assert(send(fd, request, 10, MSG_NOSIGNAL) == 10);
    usleep(300000); assert(send(fd, request+10, 10, MSG_NOSIGNAL) == 10);
    struct pollfd deadline={fd, POLLIN, 0}; assert(poll(&deadline, 1, 350) > 0);
    response(fd, "DENIED/1\n");
    /* Disconnects don't kill service; repeated success cannot leak receipt FDs. */
    for (int i=0; i<100; i++) { fd=connect_client(&f); close(fd); exchange(&f, request, 46, OK); }
    /* No ancillary caller capabilities, even with an otherwise valid frame. */
    for (int i=0; i<100; i++) {
        fd=connect_client(&f);
        char control[CMSG_SPACE(sizeof(int))]; memset(control, 0, sizeof(control));
        struct iovec io={(void *)request, 46};
        struct msghdr message={.msg_iov=&io, .msg_iovlen=1,
            .msg_control=control, .msg_controllen=sizeof(control)};
        struct cmsghdr *header=CMSG_FIRSTHDR(&message); assert(header);
        header->cmsg_level=SOL_SOCKET; header->cmsg_type=SCM_RIGHTS; header->cmsg_len=CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(header), &f.root, sizeof(int));
        assert(sendmsg(fd, &message, MSG_NOSIGNAL) == 46);
        assert(shutdown(fd, SHUT_WR) == 0); response(fd, "DENIED/1\n");
    }
    int held[QB_TRANSPORT_CLIENTS];
    for (int i=0; i<QB_TRANSPORT_CLIENTS; i++) held[i]=connect_client(&f);
    usleep(20000); fd=connect_client(&f); response(fd, "");
    for (int i=0; i<QB_TRANSPORT_CLIENTS; i++) response(held[i], "DENIED/1\n");
    exchange(&f, request, 46, OK);
    /* Descriptor exhaustion at accept pauses accepting instead of ending the service,
     * and the queued connection is served once descriptors are free again. */
    {
        char done;
        assert(write(f.control[1], "E", 1) == 1);
        struct pollfd exhausted={f.ack[0], POLLIN, 0}; assert(poll(&exhausted, 1, 3000) > 0);
        assert(read(f.ack[0], &done, 1) == 1 && done == 'E');
        int queued=connect_client(&f);
        assert(send(queued, request, 46, MSG_NOSIGNAL) == 46 && shutdown(queued, SHUT_WR) == 0);
        usleep(150000); /* several accept attempts fail with EMFILE meanwhile */
        assert(write(f.control[1], "F", 1) == 1);
        struct pollfd freed={f.ack[0], POLLIN, 0}; assert(poll(&freed, 1, 3000) > 0);
        assert(read(f.ack[0], &done, 1) == 1 && done == 'F');
        int status; assert(waitpid(f.child, &status, WNOHANG) == 0); /* service still alive */
        response(queued, OK); /* complete frame + EOF already queued, served after accept */
        exchange(&f, request, 46, OK);
    }
    /* Connected and partially sent before revoke must still be denied at ensure. */
    fd=connect_client(&f); assert(send(fd, request, 20, MSG_NOSIGNAL) == 20);
    assert(write(f.control[1], "R", 1) == 1);
    struct pollfd ack={f.ack[0], POLLIN, 0}; assert(poll(&ack, 1, 3000) > 0);
    char completed; assert(read(f.ack[0], &completed, 1) == 1 && completed == 'R');
    assert(send(fd, request+20, 26, MSG_NOSIGNAL) == 26);
    assert(shutdown(fd, SHUT_WR) == 0); response(fd, "DENIED/1\n");
    exchange(&f, request, 46, "DENIED/1\n");
    fd=connect_client(&f); /* shutdown drains idle connections, not just happy path */
    cleanup(&f); response(fd, "");
    puts("transport: cross-process framing/limits/deadline/drain passed");
    setup(&f, 1, 0);
    fd=connect_client(&f); /* rejected with no input, BEFORE any parsing */
    response(fd, "");
    fd=connect_client(&f);
    (void)send(fd, bad, sizeof(bad), MSG_NOSIGNAL); response(fd, "");
    struct stat st; assert(fstatat(f.root, "p100000", &st, 0) < 0 && errno == ENOENT);
    cleanup(&f);
    setup(&f, 0, 1); exchange(&f, request, 46, "DENIED/1\n");
    assert(fstatat(f.root, "p100000", &st, 0) < 0 && errno == ENOENT);
    cleanup(&f); puts("transport: peer-before-read/revocation/no-disclosure passed");
    setup(&f, 0, 2);
    fd=connect_client(&f); assert(send(fd, request, 46, MSG_NOSIGNAL) == 46);
    assert(shutdown(fd, SHUT_WR) == 0);
    struct pollfd entered={f.model.entered[0], POLLIN, 0}; assert(poll(&entered, 1, 3000) > 0);
    assert(read(f.model.entered[0], &completed, 1) == 1 && completed == 'C');
    assert(write(f.control[1], "R", 1) == 1);
    ack=(struct pollfd){f.ack[0], POLLIN, 0}; assert(poll(&ack, 1, 50) == 0);
    uint64_t one=1; assert(write(f.stop, &one, sizeof(one)) == sizeof(one));
    int status; assert(waitpid(f.child, &status, WNOHANG) == 0);
    assert(write(f.model.release[1], "C", 1) == 1);
    response(fd, OK); /* mutation finishes before completed revoke, not after */
    assert(poll(&ack, 1, 3000) > 0 && read(f.ack[0], &completed, 1) == 1);
    cleanup(&f); puts("transport: blocked mutation/revoke/stop/join lifetime passed"); return 0;
}
