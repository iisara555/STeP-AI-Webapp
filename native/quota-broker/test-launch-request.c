/* Real Unix peers, synthetic quota and fixed synchronous launcher. */
#define main original_test_main
#include "test-core.c"
#undef main
#include "launch-request.h"
#include <poll.h>
struct launch_model { int calls, fail; uint64_t inode; };
static int fake_spawn(void *ctx, const struct qb_workspace_receipt *r) {
    struct launch_model *m = ctx; struct stat st;
    assert(fstat(r->directory_fd, &st) == 0 && (uint64_t)st.st_ino == m->inode);
    m->calls++;
    if (m->fail) { errno = ECHILD; return -1; }
    return 0;
}
static void launch_fixture(struct fixture *f, struct qb_launch_identity *id) {
    fixture_init(f); f->policy.layout = QB_LAYOUT_SHARED;
    f->policy.access_gid = (uint32_t)getegid(); f->policy.content_uid = (uint32_t)geteuid();
    assert(fchmod(f->root, 0710) == 0); bootstrap(f);
    struct qb_workspace_receipt r; assert(workspace_as(f, 0, ws_a, geteuid(), &r) == 0);
    *id = (struct qb_launch_identity){r.device, r.user_inode, r.inode}; close(r.directory_fd);
}
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

static void request_frame(const struct qbl_config *c, char out[96], int query) {
    assert(snprintf(out, 96, "%s/1 %s %s\n", query ? "STATUS" : "LAUNCH",
                    c->incarnation, c->launch_id) == 75);
}
static void exchange(struct qbl *a, const char *frame, const char *expected, int lost) {
    int done[2]; assert(pipe(done) == 0);
    int s[2];
    int listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(listener>=0);
    struct sockaddr_un address={.sun_family=AF_UNIX};
    static unsigned serial;
    snprintf(address.sun_path+1,sizeof address.sun_path-1,"qbl-%ld-%u",(long)getpid(),serial++);
    assert(bind(listener,(struct sockaddr *)&address,sizeof address)==0 && listen(listener,1)==0);
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
        close(listener); close(done[1]);
        s[1]=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(s[1]>=0);
        assert(connect(s[1],(struct sockaddr *)&address,sizeof address)==0);
        assert(send(s[1], frame, strlen(frame), MSG_NOSIGNAL) == (ssize_t)strlen(frame));
        assert(shutdown(s[1], SHUT_WR) == 0);
        if (!lost) {
            struct pollfd p = {.fd = s[1], .events = POLLIN}; assert(poll(&p, 1, 2000) > 0);
            char b[96] = {0}; ssize_t n = recv(s[1], b, sizeof b-1, 0);
            assert(n >= 0 && strcmp(b, expected) == 0);
        } else { char b; assert(read(done[0], &b, 1) == 1); }
        close(done[0]); close(done[1]); close(s[1]); _exit(0);
    }
    s[0]=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK); assert(s[0]>=0);
    close(listener); close(done[0]);
    struct ucred peer; socklen_t length=sizeof peer;
    assert(getsockopt(s[0],SOL_SOCKET,SO_PEERCRED,&peer,&length)==0 && peer.pid==child);
    assert(qbl_serve(a, s[0]) == 0); close(s[0]);
    if (lost) assert(write(done[1], "x", 1) == 1);
    close(done[1]);
    int status; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static int fixed_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    assert(strcmp(id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") == 0);
    return fake_spawn(ctx, r);
}
static struct qbl_config config(struct fixture *f, struct launch_model *m) {
    struct qb_launch_identity id; launch_fixture(f,&id); m->inode=id.inode;
    struct qbl_config c={.broker=f->broker,.state_fd=f->state,.peer_uid=geteuid(),.identity=id,
        .incarnation="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",.launch_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .spawn=fixed_spawn,.context=m};
    memcpy(c.user,f->policy.grants[0].workspace,37); memcpy(c.workspace,ws_a,37); return c;
}
static void pair(int s[2], int type) {
    assert(socketpair(AF_UNIX,type|SOCK_CLOEXEC|SOCK_NONBLOCK,0,s)==0);
}
static void rejected(struct qbl *a, const void *data, size_t size, int eof) {
    int s[2]; pair(s,SOCK_STREAM);
    if (size) assert(send(s[1],data,size,MSG_NOSIGNAL)==(ssize_t)size);
    if (eof) assert(shutdown(s[1],SHUT_WR)==0);
    assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]);
}
static void unsafe_inputs(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    struct qbl *a, *other; struct qbl_config bad=c; bad.spawn=NULL;
    assert(qbl_open(&bad,&a)<0 && errno==ENOTSUP);
    assert(qbl_open(&c,&a)<0 && errno==ENOENT);
    assert(qbl_establish(&c)==0); assert(qbl_establish(&c)<0 && errno==EEXIST);
    assert(qbl_open(&c,&a)==0); assert(qbl_open(&c,&other)<0);
    char frame[96]; request_frame(&c,frame,0);
    rejected(a,frame,74,1); frame[75]='x'; rejected(a,frame,76,1);
    request_frame(&c,frame,0); frame[10]='z'; rejected(a,frame,75,1);
    request_frame(&c,frame,0); frame[45]='c'; rejected(a,frame,75,1);
    request_frame(&c,frame,0); rejected(a,frame,75,0); /* EOF deadline */
    int s[2]; pair(s,SOCK_DGRAM); assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]);
    pair(s,SOCK_STREAM); assert(fcntl(s[0],F_SETFD,0)==0);
    assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]);
    pair(s,SOCK_STREAM); assert(fcntl(s[0],F_SETFL,0)==0);
    assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]);
    assert(qbl_serve(a,f.root)<0);
    pair(s,SOCK_STREAM);
    char control[CMSG_SPACE(sizeof(int))]={0}; struct iovec io={frame,75};
    struct msghdr msg={.msg_iov=&io,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    struct cmsghdr *h=CMSG_FIRSTHDR(&msg); h->cmsg_level=SOL_SOCKET; h->cmsg_type=SCM_RIGHTS;
    h->cmsg_len=CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(h),&f.root,sizeof(int));
    assert(sendmsg(s[1],&msg,0)==75 && shutdown(s[1],SHUT_WR)==0);
    assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]);
    request_frame(&c,frame,1); exchange(a,frame,"LAUNCH/1 EMPTY\n",0);
    assert(m.calls==0); qbl_close(a);
    bad=c; bad.peer_uid++;
    /* Header binds peer principal; cannot reinterpret an existing slot. */
    assert(qbl_open(&bad,&a)<0);
    assert(unlinkat(f.state,"launch.outcome",0)==0); /* TEST ONLY fresh slot */
    assert(qbl_establish(&bad)==0); assert(qbl_open(&bad,&a)==0); pair(s,SOCK_STREAM);
    assert(send(s[1],"hostile",7,0)==7);
    assert(qbl_serve(a,s[0])<0 && errno==EACCES);
    char b[8]; assert(recv(s[0],b,7,MSG_PEEK)==7); /* no read before auth */
    assert(recv(s[1],b,8,MSG_DONTWAIT)<0 && errno==EAGAIN); /* no response */
    close(s[0]); close(s[1]); qbl_close(a);
    assert(fchmodat(f.state,"launch.outcome",0660,0)==0); assert(qbl_open(&bad,&a)<0);
    assert(unlinkat(f.state,"launch.outcome",0)==0);
    assert(symlinkat("journal",f.state,"launch.outcome")==0); assert(qbl_open(&c,&a)<0);
    cleanup(&f);
}
static void terminal_outcomes(int fail) {
    struct fixture f; struct launch_model m={.fail=fail}; struct qbl_config c=config(&f,&m);
    struct qbl *a; assert(qbl_establish(&c)==0); assert(qbl_open(&c,&a)==0);
    if (!fail) assert(qb_revoke(f.broker,c.user)==0);
    char frame[96]; request_frame(&c,frame,0);
    const char *expected=fail ? "LAUNCH/1 UNKNOWN\n" : "LAUNCH/1 DENIED\n";
    exchange(a,frame,expected,0); exchange(a,frame,expected,0);
    assert(m.calls==(fail ? 1 : 0)); qbl_close(a);
    assert(qbl_open(&c,&a)==0); exchange(a,frame,expected,0);
    assert(m.calls==(fail ? 1 : 0)); qbl_close(a); cleanup(&f);
}
static int crash_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    (void)ctx; (void)id; assert(fcntl(r->directory_fd,F_GETFD)>=0); _exit(73);
}
static void uncertain_crash(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    assert(qbl_establish(&c)==0);
    int s[2]; pair(s,SOCK_STREAM); c.spawn=crash_spawn;
    pid_t child=fork(); assert(child>=0);
    if (!child) { close(s[1]); struct qbl *a; assert(qbl_open(&c,&a)==0); (void)qbl_serve(a,s[0]); _exit(74); }
    close(s[0]); char frame[96]; request_frame(&c,frame,0);
    assert(send(s[1],frame,75,0)==75 && shutdown(s[1],SHUT_WR)==0);
    int status; assert(waitpid(child,&status,0)==child && WEXITSTATUS(status)==73); close(s[1]);
    c.spawn=fixed_spawn; struct qbl *a; assert(qbl_open(&c,&a)==0);
    exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0); assert(m.calls==0); qbl_close(a); cleanup(&f);
}
int __real_pthread_mutex_lock(pthread_mutex_t *mutex);
int __wrap_pthread_mutex_lock(pthread_mutex_t *mutex);
static _Thread_local int probe_lock;
static _Thread_local int expect_closed=-1;
static pthread_barrier_t observed;
int __wrap_pthread_mutex_lock(pthread_mutex_t *mutex) {
    if (probe_lock) {
        probe_lock=0; assert(pthread_mutex_trylock(mutex)==EBUSY);
        int rc=pthread_barrier_wait(&observed); assert(rc==0 || rc==PTHREAD_BARRIER_SERIAL_THREAD);
    }
    int rc=__real_pthread_mutex_lock(mutex);
    if (expect_closed>=0) { assert(fcntl(expect_closed,F_GETFD)<0 && errno==EBADF); expect_closed=-1; }
    return rc;
}
struct order_model { struct fixture *f; pthread_t thread; int borrowed; };
static void *revoke_order(void *ctx) {
    struct order_model *m=ctx; probe_lock=1; expect_closed=m->borrowed;
    assert(qb_revoke(m->f->broker,m->f->policy.grants[0].workspace)==0); return NULL;
}
static int ordered_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    (void)id; struct order_model *m=ctx; m->borrowed=r->directory_fd;
    assert(pthread_create(&m->thread,NULL,revoke_order,m)==0);
    int rc=pthread_barrier_wait(&observed); assert(rc==0 || rc==PTHREAD_BARRIER_SERIAL_THREAD);
    assert(fcntl(m->borrowed,F_GETFD)>=0); return 0;
}
static void transport_ordering(void) {
    struct fixture f; struct launch_model model={0}; struct qbl_config c=config(&f,&model);
    struct order_model m={.f=&f}; c.spawn=ordered_spawn; c.context=&m;
    assert(pthread_barrier_init(&observed,NULL,2)==0);
    struct qbl *a; assert(qbl_establish(&c)==0); assert(qbl_open(&c,&a)==0); char frame[96]; request_frame(&c,frame,0);
    exchange(a,frame,"LAUNCH/1 STARTED\n",0);
    assert(pthread_join(m.thread,NULL)==0); assert(pthread_barrier_destroy(&observed)==0);
    qbl_close(a); cleanup(&f);
}
static int disconnect_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    (void)id; assert(fcntl(r->directory_fd,F_GETFD)>=0);
    assert(shutdown(*(int *)ctx,SHUT_RDWR)==0); return 0;
}
static void disconnected_reply(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    int s[2]; pair(s,SOCK_STREAM); c.spawn=disconnect_spawn; c.context=&s[1];
    struct qbl *a; assert(qbl_establish(&c)==0); assert(qbl_open(&c,&a)==0); char frame[96]; request_frame(&c,frame,0);
    assert(send(s[1],frame,75,0)==75 && shutdown(s[1],SHUT_WR)==0);
    assert(qbl_serve(a,s[0])<0); close(s[0]); close(s[1]); qbl_close(a);
    c.spawn=fixed_spawn; c.context=&m; assert(qbl_open(&c,&a)==0);
    exchange(a,frame,"LAUNCH/1 STARTED\n",0); assert(m.calls==0); qbl_close(a); cleanup(&f);
}
static void journal_failures(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    assert(qbl_establish(&c)==0); struct qbl *a; assert(qbl_open(&c,&a)==0);
    struct stat st; assert(fstatat(f.state,"launch.outcome",&st,0)==0);
    fail_sync_inode=(uint64_t)st.st_ino;
    char frame[96]; request_frame(&c,frame,0);
    exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0); assert(m.calls==0);
    exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0); assert(m.calls==0); qbl_close(a);
    assert(qbl_open(&c,&a)==0); exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0); assert(m.calls==0); qbl_close(a);
    assert(unlinkat(f.state,"launch.outcome",0)==0);
    assert(qbl_open(&c,&a)<0 && errno==ENOENT);
    int fd=openat(f.state,"launch.outcome",O_CREAT|O_RDWR|O_CLOEXEC,0600); assert(fd>=0); close(fd);
    assert(qbl_open(&c,&a)<0 && errno==EIO); cleanup(&f);
}
static int expired_clock;
int __real_clock_gettime(clockid_t clock, struct timespec *t);
int __wrap_clock_gettime(clockid_t clock, struct timespec *t);
int __wrap_clock_gettime(clockid_t clock, struct timespec *t) {
    int rc=__real_clock_gettime(clock,t); if (!rc && clock==CLOCK_MONOTONIC && expired_clock) t->tv_sec+=2;
    return rc;
}
static int expire_mount(void *ctx, int fd, uint8_t out[16], int *enforced) {
    int rc=mock_mount(ctx,fd,out,enforced); expired_clock=1; return rc;
}
static void deadline_before_spawn(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    qb_close(f.broker); f.broker=NULL; f.adapter.mount=expire_mount; start(&f);
    expired_clock=0; c.broker=f.broker;
    assert(qbl_establish(&c)==0); struct qbl *a; assert(qbl_open(&c,&a)==0);
    int s[2]; pair(s,SOCK_STREAM); char frame[96]; request_frame(&c,frame,0);
    assert(send(s[1],frame,75,0)==75 && shutdown(s[1],SHUT_WR)==0);
    assert(qbl_serve(a,s[0])<0); assert(m.calls==0);
    expired_clock=0; close(s[0]); close(s[1]);
    request_frame(&c,frame,1); exchange(a,frame,"LAUNCH/1 DENIED\n",0); qbl_close(a); cleanup(&f);
}
static int expire_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    int rc=fixed_spawn(ctx,id,r); expired_clock=1; return rc;
}
static void deadline_after_spawn(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    c.spawn=expire_spawn;
    struct qbl *a; assert(qbl_establish(&c)==0 && qbl_open(&c,&a)==0);
    int s[2]; pair(s,SOCK_STREAM); char frame[96]; request_frame(&c,frame,0);
    assert(send(s[1],frame,75,0)==75 && shutdown(s[1],SHUT_WR)==0);
    assert(qbl_serve(a,s[0])<0 && m.calls==1); expired_clock=0;
    close(s[0]); close(s[1]); qbl_close(a);
    c.spawn=fixed_spawn; assert(qbl_open(&c,&a)==0);
    request_frame(&c,frame,1); exchange(a,frame,"LAUNCH/1 STARTED\n",0);
    request_frame(&c,frame,0); exchange(a,frame,"LAUNCH/1 STARTED\n",0);
    assert(m.calls==1); qbl_close(a); cleanup(&f);
}
static int fail_completion_spawn(void *ctx, const char *id, const struct qb_workspace_receipt *r) {
    struct qbl_config *c=ctx; struct stat st;
    int rc=fixed_spawn(c->context,id,r);
    assert(fstatat(c->state_fd,"launch.outcome",&st,0)==0);
    fail_sync_inode=(uint64_t)st.st_ino; return rc;
}
static void completion_sync_failure(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config original=config(&f,&m), c=original;
    c.spawn=fail_completion_spawn; c.context=&original;
    struct qbl *a; assert(qbl_establish(&c)==0 && qbl_open(&c,&a)==0);
    char frame[96]; request_frame(&c,frame,0);
    exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0);
    exchange(a,frame,"LAUNCH/1 UNKNOWN\n",0); assert(m.calls==1);
    qbl_close(a);
    /* Successful pwrite survived in this filesystem despite the injected sync
     * error. A real power loss can instead recover PENDING: neither may retry. */
    assert(qbl_open(&original,&a)==0);
    exchange(a,frame,"LAUNCH/1 STARTED\n",0); assert(m.calls==1);
    qbl_close(a); cleanup(&f);
}
static void fragmented_frame(void) {
    struct fixture f; struct launch_model m={0}; struct qbl_config c=config(&f,&m);
    struct qbl *a; assert(qbl_establish(&c)==0 && qbl_open(&c,&a)==0);
    int s[2], gate[2]; pair(s,SOCK_STREAM); assert(pipe(gate)==0);
    char frame[96]; request_frame(&c,frame,0);
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        close(s[0]); close(gate[0]);
        for (size_t i=0; i<75; i++) {
            assert(send(s[1],frame+i,1,MSG_NOSIGNAL)==1);
            if (!i) { assert(write(gate[1],"x",1)==1); close(gate[1]); }
        }
        assert(shutdown(s[1],SHUT_WR)==0);
        struct pollfd p={s[1],POLLIN,0}; assert(poll(&p,1,2000)>0);
        char reply[32]={0}; assert(recv(s[1],reply,sizeof reply-1,0)>0);
        assert(strcmp(reply,"LAUNCH/1 STARTED\n")==0); close(s[1]); _exit(0);
    }
    close(s[1]); close(gate[1]); char b; assert(read(gate[0],&b,1)==1); close(gate[0]);
    assert(qbl_serve(a,s[0])==0); close(s[0]); int status;
    assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    assert(m.calls==1); qbl_close(a); cleanup(&f);
}
static void lost_response_replay(void) {
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    struct launch_model m = {.inode = id.inode};
    struct qbl_config c = {.broker=f.broker, .state_fd=f.state, .peer_uid=geteuid(), .identity=id,
        .incarnation="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .launch_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .spawn=fixed_spawn, .context=&m};
    memcpy(c.user, f.policy.grants[0].workspace, 37); memcpy(c.workspace, ws_a, 37);
    struct qbl *a; assert(qbl_establish(&c)==0); assert(qbl_open(&c, &a) == 0);
    char frame[96]; request_frame(&c, frame, 0);
    exchange(a, frame, "", 1); /* response lost AFTER actual launch */
    assert(m.calls == 1);
    exchange(a, frame, "LAUNCH/1 STARTED\n", 0); assert(m.calls == 1);
    qbl_close(a);
    assert(qbl_open(&c, &a) == 0);
    request_frame(&c, frame, 1); exchange(a, frame, "LAUNCH/1 STARTED\n", 0);
    assert(m.calls == 1); qbl_close(a); cleanup(&f);
}
int main(void) {
    alarm(30); assert(geteuid()!=0); unsigned passed=0;
#define RUN(test) do { test; printf("ok %u - %s\n",++passed,#test); } while (0)
    RUN(unsafe_inputs()); RUN(terminal_outcomes(0)); RUN(terminal_outcomes(1));
    RUN(uncertain_crash()); RUN(transport_ordering()); RUN(disconnected_reply());
    RUN(journal_failures()); RUN(deadline_before_spawn()); RUN(deadline_after_spawn());
    RUN(completion_sync_failure()); RUN(fragmented_frame()); RUN(lost_response_replay());
#undef RUN
    printf("%u unprivileged launch-request scenarios passed; ZERO real launches\n",passed);
    return 0;
}
