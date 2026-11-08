/* Real core, outcome ledger, lifecycle ledger and Unix socket. No real launch. */
#define main quota_test_main
#include "../quota-broker/test-core.c"
#undef main
#include "composition.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
struct composed_fixture {
    struct fixture quota;
    struct lco_config config;
    struct lco_slot spec;
    struct lco *owner;
    int lifecycle_fd, outcome_fd, calls, crash, fail_spawn, fail_completion;
};
static int fixed_spawn(void *ctx, const struct lc_entry *e, const struct qb_workspace_receipt *r) {
    struct composed_fixture *f=ctx; struct stat st;
    assert(e->state==LC_STARTING && !strcmp(e->launch,f->spec.launch));
    assert(fstat(r->directory_fd,&st)==0 && (uint64_t)st.st_ino==f->spec.identity.inode);
    f->calls++;
    if (f->crash) _exit(73); /* callback entered; qbl completion not yet written */
    if (f->fail_completion) {
        assert(fstatat(f->spec.state_fd,"launch.outcome",&st,0)==0);
        fail_sync_inode=(uint64_t)st.st_ino;
    }
    if (f->fail_spawn) { errno=ECHILD; return -1; }
    return 0;
}
static void init(struct composed_fixture *f, uint64_t capacity) {
    memset(f,0,sizeof *f); fixture_init(&f->quota);
    f->quota.policy.layout=QB_LAYOUT_SHARED;
    f->quota.policy.access_gid=(uint32_t)getegid(); f->quota.policy.content_uid=(uint32_t)geteuid();
    assert(fchmod(f->quota.root,0710)==0); bootstrap(&f->quota);
    struct qb_workspace_receipt r;
    assert(workspace_as(&f->quota,0,ws_a,geteuid(),&r)==0);
    f->spec=(struct lco_slot){.peer_uid=geteuid(),.launch="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .identity={r.device,r.user_inode,r.inode}};
    close(r.directory_fd);
    memcpy(f->spec.user,f->quota.policy.grants[0].workspace,37); memcpy(f->spec.workspace,ws_a,37);
    assert(mkdirat(f->quota.base,"lifecycle",0700)==0 && mkdirat(f->quota.base,"outcome",0700)==0);
    f->lifecycle_fd=openat(f->quota.base,"lifecycle",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    f->outcome_fd=openat(f->quota.base,"outcome",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    assert(f->lifecycle_fd>=0 && f->outcome_fd>=0); f->spec.state_fd=f->outcome_fd;
    f->config=(struct lco_config){.lifecycle={.directory_fd=f->lifecycle_fd,.capacity=capacity,
        .epoch="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",.boot="12345678-1234-4234-8234-000000000001"},
        .broker=f->quota.broker,.context=f,.spawn=fixed_spawn};
    assert(lc_establish(&f->config.lifecycle)==0);
}
static void finish(struct composed_fixture *f) {
    lco_close(f->owner); close(f->lifecycle_fd); close(f->outcome_fd); cleanup(&f->quota);
}
static void frame(const struct lco_slot *s, int query, char out[76]) {
    assert(snprintf(out,76,"%s/1 %s %s\n",query ? "STATUS":"LAUNCH",s->launch,s->launch)==75);
}
static void sockets(int s[2]) { assert(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0,s)==0); }
static void submit(int fd,const struct lco_slot *spec,int query) {
    char b[76]; frame(spec,query,b);
    assert(send(fd,b,75,MSG_NOSIGNAL)==75 && shutdown(fd,SHUT_WR)==0);
}
static void exchange(struct composed_fixture *f,int query,const char *expected) {
    int listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(listener>=0);
    struct sockaddr_un address={.sun_family=AF_UNIX}; static unsigned serial;
    assert(snprintf(address.sun_path+1,sizeof address.sun_path-1,"lco-%ld-%u",(long)getpid(),serial++)>0);
    assert(bind(listener,(struct sockaddr *)&address,sizeof address)==0 && listen(listener,1)==0);
    pid_t peer=fork(); assert(peer>=0);
    if (!peer) {
        close(listener);
        int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(fd>=0);
        assert(connect(fd,(struct sockaddr *)&address,sizeof address)==0); submit(fd,&f->spec,query);
        struct pollfd p={fd,POLLIN,0}; assert(poll(&p,1,2000)>0);
        char b[64]={0}; assert(recv(fd,b,sizeof b-1,0)>0 && !strcmp(b,expected));
        close(fd); _exit(0);
    }
    int fd=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK); assert(fd>=0); close(listener);
    struct ucred credentials; socklen_t length=sizeof credentials;
    assert(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&credentials,&length)==0 && credentials.pid==peer);
    assert(lco_serve(f->owner,fd)==0); close(fd);
    int status; assert(waitpid(peer,&status,0)==peer && WIFEXITED(status) && WEXITSTATUS(status)==0);
}
struct proof_model { struct lc_entry expected; int absence, metadata, absent_calls, clean_calls; };
static int exact(const struct lc_entry *a,const struct lc_entry *b) {
    return a->slot==b->slot && a->principal==b->principal && !strcmp(a->epoch,b->epoch) &&
        !strcmp(a->boot,b->boot) && !strcmp(a->user,b->user) && !strcmp(a->workspace,b->workspace) &&
        !strcmp(a->launch,b->launch) && !strcmp(a->container,b->container);
}
static int absent(void *ctx,const struct lc_entry *e) {
    struct proof_model *p=ctx; p->absent_calls++;
    return exact(e,&p->expected) ? p->absence:0;
}
static int clean(void *ctx,const struct lc_entry *e) {
    struct proof_model *p=ctx; p->clean_calls++; assert(exact(e,&p->expected)); return p->metadata;
}
static void fresh_spec(struct composed_fixture *f,unsigned n) {
    char name[32]; assert(snprintf(name,sizeof name,"outcome-%u",n)>0);
    assert(mkdirat(f->quota.base,name,0700)==0); close(f->outcome_fd);
    f->outcome_fd=openat(f->quota.base,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC); assert(f->outcome_fd>=0);
    f->spec.state_fd=f->outcome_fd;
    assert(snprintf(f->spec.launch,sizeof f->spec.launch,"%032x",n)==32);
}
static void crash_reopen(void) {
    struct composed_fixture f; init(&f,1);
    int s[2]; sockets(s); f.crash=1;
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        close(s[1]); assert(lco_open(&f.config,&f.owner)==0);
        struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
        (void)lco_serve(f.owner,s[0]); _exit(74);
    }
    close(s[0]);
    /* Drop the parent's inherited core handle; only the child startup owner
     * keeps authority during launch. Reopen the actual core after its death. */
    qb_close(f.quota.broker); f.quota.broker=NULL;
    submit(s[1],&f.spec,0);
    int status; assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==73);
    close(s[1]); f.crash=0;
    start(&f.quota); f.config.broker=f.quota.broker;
    assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry e; assert(lco_get(f.owner,1,&e)==0 && e.state==LC_FENCED);
    assert(lco_attach(f.owner,1,&f.spec)==0);
    exchange(&f,1,"LAUNCH/1 UNKNOWN\n"); exchange(&f,0,"LAUNCH/1 UNKNOWN\n");
    assert(f.calls==0);
    assert(lco_detach(f.owner)==0); fresh_spec(&f,2);
    struct lc_entry next;
    assert(lco_prepare(f.owner,&f.spec,&next)<0); /* new ID cannot evade drain */
    struct proof_model p={.expected=e,.absence=0,.metadata=1};
    assert(lco_reconcile(f.owner,1,absent,clean,&p)<0 && p.clean_calls==0);
    p.absence=-1; assert(lco_reconcile(f.owner,1,absent,clean,&p)<0 && p.clean_calls==0);
    p.absence=1; p.expected.launch[0]='f'; /* proof for wrong incarnation */
    assert(lco_reconcile(f.owner,1,absent,clean,&p)<0 && p.clean_calls==0);
    p.expected=e; p.metadata=-1;
    assert(lco_reconcile(f.owner,1,absent,clean,&p)<0 && p.clean_calls==1);
    assert(lco_prepare(f.owner,&f.spec,&next)<0);
    p.metadata=0; assert(lco_reconcile(f.owner,1,absent,clean,&p)<0);
    assert(lco_get(f.owner,1,&next)==0 && next.state==LC_FENCED);
    p.metadata=1; assert(lco_reconcile(f.owner,1,absent,clean,&p)==0);
    int before=p.absent_calls; assert(lco_reconcile(f.owner,1,absent,clean,&p)==0 && p.absent_calls==before);
    assert(lco_prepare(f.owner,&f.spec,&next)==0 && next.slot==2 && strcmp(next.container,e.container));
    exchange(&f,0,"LAUNCH/1 STARTED\n"); assert(f.calls==1);
    assert(lco_get(f.owner,2,&next)==0 && next.state==LC_STARTING); /* not readiness */
    finish(&f);
}
static void all_pending_fenced(void) {
    struct composed_fixture f; init(&f,4); assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry entries[3];
    for (unsigned i=0;i<3;i++) {
        if (i) fresh_spec(&f,i+1);
        /* Distinct reservations, even with spare capacity. */
        assert(snprintf(f.spec.workspace,37,"12345678-1234-4234-8234-%012u",i+50)==36);
        assert(lco_prepare(f.owner,&f.spec,&entries[i])==0 && lco_detach(f.owner)==0);
    }
    lco_close(f.owner); f.owner=NULL;
    f.config.lifecycle.boot[35]='9'; /* old boot identity must reach reconciler */
    assert(lco_open(&f.config,&f.owner)==0);
    fresh_spec(&f,4);
    for (uint64_t i=1;i<=3;i++) {
        struct lc_entry e; assert(lco_get(f.owner,i,&e)==0 && e.state==LC_FENCED);
        assert(exact(&e,&entries[i-1]));
        struct lc_entry blocked; assert(lco_prepare(f.owner,&f.spec,&blocked)<0);
        struct proof_model p={.expected=entries[i-1],.absence=1,.metadata=1};
        assert(lco_reconcile(f.owner,i,absent,clean,&p)==0);
    }
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0 && e.slot==4);
    assert(!strcmp(e.boot,f.config.lifecycle.boot)); finish(&f);
}
static void capacity_and_denial(int denied) {
    struct composed_fixture f; init(&f,1); assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
    if (denied) assert(qb_revoke(f.quota.broker,f.spec.user)==0);
    else f.fail_spawn=1;
    exchange(&f,0,denied ? "LAUNCH/1 DENIED\n":"LAUNCH/1 UNKNOWN\n");
    exchange(&f,1,denied ? "LAUNCH/1 DENIED\n":"LAUNCH/1 UNKNOWN\n");
    assert(f.calls==(denied ? 0:1));
    assert(lco_detach(f.owner)==0); fresh_spec(&f,2);
    memcpy(f.spec.workspace,ws_b,37);
    assert(lco_prepare(f.owner,&f.spec,&e)<0 && errno==ENOSPC); /* not duplicate workspace */
    assert(lco_get(f.owner,1,&e)==0 && e.state!=(enum lc_state)LC_RELEASED);
    finish(&f);
}
static void io_failure(int stage) {
    struct composed_fixture f; init(&f,1); assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
    struct stat st;
    if (stage==2) f.fail_completion=1;
    else {
        int fd=stage==0 ? f.outcome_fd:f.lifecycle_fd;
        const char *name=stage==0 ? "launch.outcome":"lifecycle.ledger";
        assert(fstatat(fd,name,&st,0)==0); fail_sync_inode=(uint64_t)st.st_ino;
    }
    exchange(&f,0,"LAUNCH/1 UNKNOWN\n"); exchange(&f,0,"LAUNCH/1 UNKNOWN\n");
    assert(f.calls==(stage==2 ? 1:0));
    lco_close(f.owner); f.owner=NULL; f.fail_completion=0;
    assert(lco_open(&f.config,&f.owner)==0);
    assert(lco_get(f.owner,1,&e)==0 && e.state==LC_FENCED);
    assert(lco_attach(f.owner,1,&f.spec)==0);
    /* Completion's successful write survived the injected fsync error here.
     * A power failure may recover PENDING instead: neither can replay spawn. */
    exchange(&f,1,stage==2 ? "LAUNCH/1 STARTED\n":"LAUNCH/1 UNKNOWN\n");
    exchange(&f,0,stage==2 ? "LAUNCH/1 STARTED\n":"LAUNCH/1 UNKNOWN\n");
    assert(f.calls==(stage==2 ? 1:0)); finish(&f);
}
static void startup_and_binding(void) {
    struct composed_fixture f; init(&f,2);
    struct lco *other=NULL; struct lco_config bad=f.config; bad.spawn=NULL;
    assert(lco_open(&bad,&other)<0 && !other && errno==ENOTSUP);
    assert(lco_open(&f.config,&f.owner)==0);
    assert(lco_open(&f.config,&other)<0 && !other); /* one kernel authority */
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
    assert(lco_detach(f.owner)==0);
    struct lco_slot wrong=f.spec;
    wrong.peer_uid++; assert(lco_attach(f.owner,1,&wrong)<0);
    wrong=f.spec; wrong.launch[0]='b'; assert(lco_attach(f.owner,1,&wrong)<0);
    wrong=f.spec; wrong.identity.inode++; assert(lco_attach(f.owner,1,&wrong)<0);
    assert(lco_attach(f.owner,1,&f.spec)==0);
    exchange(&f,1,"LAUNCH/1 EMPTY\n"); assert(f.calls==0);
    assert(lco_detach(f.owner)==0);
    assert(unlinkat(f.outcome_fd,"launch.outcome",0)==0); /* scratch corruption only */
    assert(lco_attach(f.owner,1,&f.spec)<0 && errno==ENOENT);
    assert(lco_get(f.owner,1,&e)==0 && e.state==LC_RESERVED);
    /* A preexisting outcome must not cause an automatically released reservation. */
    assert(lco_prepare(f.owner,&f.spec,&e)<0);
    finish(&f);
}
static void release_sync_failure(void) {
    struct composed_fixture f; init(&f,1); assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
    exchange(&f,0,"LAUNCH/1 STARTED\n"); assert(lco_detach(f.owner)==0);
    struct proof_model p={.expected=e,.absence=1,.metadata=1}; struct stat st;
    assert(fstatat(f.lifecycle_fd,"lifecycle.ledger",&st,0)==0); fail_sync_inode=(uint64_t)st.st_ino;
    assert(lco_reconcile(f.owner,1,absent,clean,&p)<0);
    fresh_spec(&f,2); assert(lco_prepare(f.owner,&f.spec,&e)<0 && errno==EIO);
    int before=p.absent_calls;
    assert(lco_reconcile(f.owner,1,absent,clean,&p)<0 && p.absent_calls==before);
    finish(&f);
}
static void recovered_empty_slot(void) {
    struct composed_fixture f; init(&f,1); assert(lco_open(&f.config,&f.owner)==0);
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)==0);
    lco_close(f.owner); f.owner=NULL;
    assert(lco_open(&f.config,&f.owner)==0 && lco_attach(f.owner,1,&f.spec)==0);
    exchange(&f,1,"LAUNCH/1 EMPTY\n");
    exchange(&f,0,"LAUNCH/1 UNKNOWN\n"); /* EMPTY is NOT restart launch authority */
    assert(f.calls==0 && lco_get(f.owner,1,&e)==0 && e.state==LC_FENCED);
    finish(&f);
}
static void prepare_error_retains(void) {
    struct composed_fixture f; init(&f,1); assert(lco_open(&f.config,&f.owner)==0);
    assert(fchmod(f.outcome_fd,0770)==0);
    struct lc_entry e; assert(lco_prepare(f.owner,&f.spec,&e)<0);
    assert(lco_get(f.owner,1,&e)==0 && e.state==LC_RESERVED);
    assert(fchmod(f.outcome_fd,0700)==0); fresh_spec(&f,2);
    memcpy(f.spec.workspace,ws_b,37);
    assert(lco_prepare(f.owner,&f.spec,&e)<0 && errno==ENOSPC);
    assert(f.calls==0); finish(&f);
}
#ifndef COMPOSITION_TEST_MAIN
#define COMPOSITION_TEST_MAIN main
#endif
int COMPOSITION_TEST_MAIN(void) {
    alarm(60); assert(geteuid()!=0); unsigned passed=0;
#define RUN(test) do { test; printf("ok %u - %s\n",++passed,#test); } while (0)
    RUN(crash_reopen()); RUN(all_pending_fenced());
    RUN(capacity_and_denial(0)); RUN(capacity_and_denial(1));
    RUN(io_failure(0)); RUN(io_failure(1)); RUN(io_failure(2));
    RUN(startup_and_binding()); RUN(release_sync_failure());
    RUN(recovered_empty_slot()); RUN(prepare_error_retains());
#undef RUN
    printf("%u composed unprivileged scenarios passed; ZERO real launches\n",passed);
    return 0;
}
