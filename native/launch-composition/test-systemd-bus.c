/* Compile the actual sd-bus reader against a strict public-ABI fixture. The
 * monotonic clock is the fixture's own (clock_gettime is renamed before the
 * include, as in systemd-create/test-create.c): it only moves when a scenario
 * jumps it inside a chosen call, so every budget and sleep has an exact
 * expected value computed from the fixture's true time. */
#define clock_gettime fixture_clock_gettime
#include "systemd-observer.c"
#undef clock_gettime
#include <assert.h>
#include <stdarg.h>
struct sd_bus { int unused; };
struct sd_bus_message { int kind; };
static struct sd_bus connection;
static struct sd_bus_message reply;
static unsigned owners, mode;
static int freed;
/* --- fake clock: frozen except for scripted jumps --- */
static uint64_t clock_us, deadline_us;
static unsigned clock_calls, clock_fail_at;
int fixture_clock_gettime(clockid_t clk,struct timespec *ts) {
    assert(clk==CLOCK_MONOTONIC);
    if (++clock_calls==clock_fail_at) { errno=EINVAL; return -1; }
    ts->tv_sec=(time_t)(clock_us/1000000); ts->tv_nsec=(long)(clock_us%1000000)*1000; return 0;
}
/* Blocking calls (method calls and property Gets) are counted; the clock
 * jumps by jump_us inside call number jump_call, after the call was made. */
static unsigned calls, jump_call, budget_pending;
static uint64_t jump_us;
static void blocking_call(void) {
    assert(budget_pending); budget_pending=0; /* every blocking call freshly budgeted */
    if (++calls==jump_call) clock_us+=jump_us;
}
/* Connection is driven the production way: new + fixed address + client +
 * start, then nonblocking readiness. mode 1: start fails; modes 12-14 and the
 * idle scenarios below. */
static unsigned started, ready_polls, processed, ready_at_call;
int sd_bus_new(sd_bus **out) { *out=&connection; started=0; ready_polls=0; processed=0; return 0; }
int sd_bus_set_address(sd_bus *b,const char *a) { assert(b==&connection && !strcmp(a,"unix:path=/run/dbus/system_bus_socket")); return 0; }
int sd_bus_set_bus_client(sd_bus *b,int x) { assert(b==&connection && x==1); return 0; }
int sd_bus_start(sd_bus *b) { assert(b==&connection && !started && budget_pending); budget_pending=0; started=1; return mode==1 ? -EIO:0; }
/* Idle readiness: nothing buffered (process() returns 0), so each round must
 * sleep in ppoll; ready once idle_rounds ppolls have returned. ready_jump_us
 * moves the clock inside the first process() call. */
static unsigned idle, idle_rounds, ppolls, ppoll_fail, ppoll_eintr, timeout_fail;
static uint64_t ready_jump_us, bus_until, ppoll_log[8];
/* mode 12: ready only after 40 buffered process() steps (exceeds one dispatch
 * bound, must yield and continue); mode 13: readiness reports an error;
 * mode 14: process() fails. */
int sd_bus_is_ready(sd_bus *b) {
    assert(b==&connection && started); ready_polls++;
    if (mode==13) return -EIO;
    if ((mode==12 && processed<40) || mode==14) return 0;
    if (idle) return ppolls>=idle_rounds;
    return 1;
}
static unsigned process_calls;
int sd_bus_process(sd_bus *b,sd_bus_message **m) {
    assert(b==&connection && !m); process_calls++;
    if (mode==14) return -EIO;
    if (idle) {
        if (process_calls==1) clock_us+=ready_jump_us;
        return 0;
    }
    processed++; return 1;
}
int sd_bus_get_events(sd_bus *b) { assert(b==&connection); return 1; }
int sd_bus_get_timeout(sd_bus *b,uint64_t *t) {
    assert(b==&connection);
    if (timeout_fail) { *t=0; return -EIO; }
    *t=bus_until; return 0;
}
int ppoll(struct pollfd *p,nfds_t n,const struct timespec *ts,const sigset_t *mask) {
    assert(p && n==1 && p->fd==123 && ts && !mask);
    assert(!timeout_fail);               /* a failed get_timeout must end the attempt */
    assert(ppolls<(ppoll_fail ? 1u:7u)); /* a failed ppoll must end it too */
    uint64_t got=(uint64_t)ts->tv_sec*1000000+(uint64_t)ts->tv_nsec/1000;
    /* buffered work must yield with a zero timeout, never sleep; an idle round
     * sleeps exactly until min(bus timeout, deadline), measured from now */
    uint64_t until=bus_until<deadline_us ? bus_until:deadline_us;
    uint64_t want=mode==12 ? 0:until>clock_us ? until-clock_us:0;
    assert(got==want && ts->tv_nsec%1000==0);
    ppoll_log[ppolls++]=got; p->revents=0;
    if (ppoll_fail) { errno=EIO; return -1; }
    if (ppoll_eintr && ppolls==1) { errno=EINTR; return -1; }
    return 0;
}
int sd_bus_get_fd(sd_bus *b) { assert(b==&connection); return 123; }
int sd_bus_get_bus_id(sd_bus *b,sd_id128_t *id) { assert(b==&connection); memset(id,0xdd,sizeof *id); return 0; }
int getsockopt(int fd,int level,int opt,void *value,socklen_t *length) {
    assert(fd==123 && level==SOL_SOCKET && opt==SO_PEERCRED && *length==sizeof(struct ucred));
    struct ucred p={.pid=1,.uid=mode==9 ? 1000u:0u,.gid=0}; memcpy(value,&p,sizeof p); return 0;
}
sd_bus *sd_bus_unref(sd_bus *b) { (void)b; return NULL; }
sd_bus_message *sd_bus_message_unref(sd_bus_message *m) { (void)m; return NULL; }
void sd_bus_error_free(sd_bus_error *e) { (void)e; freed++; }
static unsigned budgets;
static uint64_t budget_log[16];
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t timeout) {
    /* every blocking call is budgeted min(true time left, 2 s); the deadline is
     * the snapshot's start + 5 s, never refreshed, and an expired one is refused */
    assert(b==&connection && clock_us<deadline_us);
    uint64_t left=deadline_us-clock_us;
    assert(timeout==(left<2000000 ? left:2000000));
    assert(budgets<16); budget_log[budgets++]=timeout; budget_pending=1; return 0;
}
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *method,sd_bus_error *error,sd_bus_message **out,const char *types,...) {
    assert(b==&connection && !strcmp(types,"s"));
    if (!calls) ready_at_call=ready_polls;
    assert(ready_polls>0 && sd_bus_is_ready(b)==1); /* never before readiness */
    blocking_call();
    (void)path; (void)iface; *out=&reply;
    if (!strcmp(method,"GetNameOwner")) {
        assert(!strcmp(dest,"org.freedesktop.DBus")); owners++; reply.kind=1; return 0;
    }
    if (!strcmp(method,"GetConnectionUnixUser")) { reply.kind=4; return 0; }
    assert(!strcmp(method,"GetUnit") && !strcmp(dest,":1.42")); reply.kind=2;
    if (mode==2 || mode==3) { assert(error); error->name=mode==2 ? "org.freedesktop.systemd1.NoSuchUnit":"org.freedesktop.DBus.Error.AccessDenied"; return -ENOENT; }
    return 0;
}
int sd_bus_message_read(sd_bus_message *m,const char *types,...) {
    assert(m==&reply); va_list args; va_start(args,types);
    if (types[0]=='s' && types[1]==0) {
        assert(m->kind==1); *va_arg(args,const char **)=(mode==4 && owners>1) ? ":1.43":":1.42";
    } else if (types[0]=='o' && types[1]==0) {
        assert(m->kind==2); *va_arg(args,const char **)="/org/freedesktop/systemd1/unit/fixed";
    } else if (types[0]=='u' && types[1]==0) {
        assert(m->kind==4); *va_arg(args,unsigned *)=mode==10 ? 1000u:0u;
    } else {
        assert(m->kind==3 && !strcmp(types,"(uo)"));
        *va_arg(args,unsigned *)=mode==7 ? 42u:0u; *va_arg(args,const char **)="/";
    }
    va_end(args); return mode==8 ? -EBADMSG:1;
}
int sd_bus_message_read_array(sd_bus_message *m,char type,const void **bytes,size_t *length) {
    static unsigned char id[16]={0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc};
    assert(m==&reply && type=='y'); *bytes=id; *length=mode==5 ? 15:16; return 0;
}
int sd_bus_get_property(sd_bus *b,const char *dest,const char *path,const char *iface,const char *property,sd_bus_error *error,sd_bus_message **out,const char *type) {
    (void)path; (void)error;
    assert(b==&connection && !strcmp(dest,":1.42") && !strcmp(iface,"org.freedesktop.systemd1.Unit"));
    assert((!strcmp(property,"InvocationID") && !strcmp(type,"ay")) || (!strcmp(property,"Job") && !strcmp(type,"(uo)")));
    blocking_call();
    reply.kind=3; *out=&reply; return 0;
}
int sd_bus_get_property_string(sd_bus *b,const char *dest,const char *path,const char *iface,const char *property,sd_bus_error *error,char **out) {
    (void)b; (void)dest; (void)path; (void)error;
    assert(!strcmp(iface,!strcmp(property,"ControlGroup") ? "org.freedesktop.systemd1.Service":"org.freedesktop.systemd1.Unit"));
    assert(!strcmp(property,"ControlGroup") || !strcmp(property,"ActiveState"));
    blocking_call();
    /* mode 11: systemd 259 reports "" for a stopped unit whose cgroup was pruned */
    *out=strdup(!strcmp(property,"ControlGroup") ? (mode==11 ? "":"/protected.slice/original.service"):"inactive"); assert(*out);
    return mode==6 ? -EIO:0;
}
/* One snapshot with every fixture counter reset; the clock starts at an
 * arbitrary nonzero instant, so the attempt deadline is exactly +5 s. */
static int run(struct lso_snapshot *s) {
    owners=0; budgets=0; process_calls=0; calls=0; budget_pending=0; ppolls=0; ready_at_call=0; clock_calls=0;
    memset(budget_log,0,sizeof budget_log); memset(ppoll_log,0,sizeof ppoll_log);
    clock_us=1000000000ULL; deadline_us=clock_us+5000000ULL;
    return snapshot(NULL,"fixed.service",":1.42",s);
}
static void plain(void) {
    jump_call=0; jump_us=0; clock_fail_at=0; idle=0; idle_rounds=0; ppoll_fail=0; ppoll_eintr=0;
    timeout_fail=0; ready_jump_us=0; bus_until=UINT64_MAX;
}
static void ok_snapshot(int r,const struct lso_snapshot *s) {
    assert(r==0 && !s->missing && !strcmp(s->invocation,"cccccccccccccccccccccccccccccccc") && !strcmp(s->manager,":1.42"));
}
int main(void) {
    struct lso_snapshot s;
    for (mode=0;mode<15;mode++) {
        plain();
        int r=run(&s);
        if (mode==0) assert(budgets==11 && calls==9 && clock_calls==13); /* start; owner x2; GetUnit; 2 strings; InvocationID; Job; closing owner x2; final check */
        if (mode==12) assert(r==0 && processed==40 && ready_polls>LSO_DISPATCH_BOUND);
        /* errors end readiness at once, not by running into the deadline */
        if (mode==13) assert(r<0 && process_calls==0 && ready_polls==1);
        if (mode==14) assert(r<0 && process_calls==1);
        if (mode==0 || mode==7) {
            ok_snapshot(r,&s); assert(s.job==(mode==7 ? 42u:0u));
        } else if (mode==2) assert(r==0 && s.missing==1);
        else if (mode==11) assert(r==0 && !s.missing && s.cgroup[0]==0 && !strcmp(s.state,"inactive"));
        else if (mode==12) assert(!s.missing && !strcmp(s.invocation,"cccccccccccccccccccccccccccccccc"));
        else assert(r<0);
        printf("ok - sd-bus ABI fixture %u\n",mode);
    }
    assert(freed==15);
    mode=0;
    /* 3.5 s pass inside GetUnit (call 3): every later budget is exactly the
     * 1.5 s left, never the 2 s ceiling. */
    plain(); jump_call=3; jump_us=3500000;
    ok_snapshot(run(&s),&s);
    assert(budgets==11 && budget_log[3]==2000000 && budget_log[4]==1500000 && budget_log[10]==1500000);
    printf("ok - per-call budget is the exact time left below the ceiling\n");
    /* The clock reaches the deadline exactly inside call n (n=9 is the closing
     * GetConnectionUnixUser: only the final check covers it); nothing is
     * called afterwards and the snapshot fails. 1 us short still succeeds. */
    for (unsigned n=1;n<=9;n++) {
        plain(); jump_call=n; jump_us=5000000;
        assert(run(&s)<0 && calls==n && budgets==n+1);
        plain(); jump_call=n; jump_us=4999999;
        ok_snapshot(run(&s),&s); assert(calls==9 && budgets==11 && budget_log[n+1]==1 && budget_log[10]==1);
    }
    printf("ok - expired deadline refused after every call, including the last\n");
    /* 4 s pass inside readiness (first process()): the sleep is the fresh 1 s
     * left, and the deadline is not refreshed once ready. */
    plain(); idle=1; idle_rounds=1; ready_jump_us=4000000;
    ok_snapshot(run(&s),&s);
    assert(ppolls==1 && ppoll_log[0]==1000000 && budget_log[0]==2000000 && budget_log[1]==1000000 && budget_log[10]==1000000);
    /* The deadline is reached exactly inside readiness: zero sleep, then the
     * next round refuses before asking readiness again; no call, no budget. */
    plain(); idle=1; idle_rounds=1; ready_jump_us=5000000;
    assert(run(&s)<0 && ppolls==1 && ppoll_log[0]==0 && ready_polls==1 && calls==0 && budgets==1);
    printf("ok - readiness time counts against the snapshot deadline\n");
    /* Idle connection: one is_ready, one process() and one ppoll per round,
     * sleeping exactly the bus timeout (0.7 s) - no busy spin. */
    plain(); idle=1; idle_rounds=3; bus_until=1000000000ULL+700000;
    ok_snapshot(run(&s),&s);
    assert(process_calls==3 && ready_at_call==4 && ppolls==3 && ppoll_log[0]==700000 && ppoll_log[2]==700000);
    assert(clock_calls==19); /* start, start budget, 3x(round, sleep), round 4, 10 budgets */
    printf("ok - idle readiness sleeps in ppoll, one dispatch per round\n");
    /* sd_bus_get_timeout fails: the attempt ends, no sleep, no call */
    plain(); idle=1; idle_rounds=3; timeout_fail=1;
    assert(run(&s)<0 && process_calls==1 && ppolls==0 && calls==0);
    timeout_fail=0;
    /* ppoll fails: the attempt ends at once, no retry, no call */
    plain(); idle=1; idle_rounds=3; ppoll_fail=1;
    assert(run(&s)<0 && process_calls==1 && ppolls==1 && calls==0);
    /* EINTR is not an error: readiness continues */
    plain(); idle=1; idle_rounds=2; ppoll_eintr=1;
    ok_snapshot(run(&s),&s); assert(ppolls==2 && process_calls==2);
    printf("ok - readiness timeout/ppoll errors end the attempt; EINTR retries\n");
    /* A clock failure at any read refuses (plain: 13 reads, idle: 19 reads). */
    for (unsigned k=1;k<=13;k++) { plain(); clock_fail_at=k; assert(run(&s)<0); }
    for (unsigned k=1;k<=19;k++) { plain(); idle=1; idle_rounds=3; bus_until=1000000000ULL+700000; clock_fail_at=k; assert(run(&s)<0); }
    printf("ok - clock failure at every read refuses the snapshot\n");
    return 0;
}
