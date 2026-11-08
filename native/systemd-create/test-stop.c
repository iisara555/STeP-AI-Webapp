#define _GNU_SOURCE
#define LSC_TESTING 1
#define LSC_FIXTURE_INCLUDE 1
#define fsync fixture_fsync
#define getsockopt fixture_getsockopt
#define clock_gettime fixture_clock_gettime
#include "stop.c"
#undef fsync
#undef getsockopt
#undef clock_gettime
extern int fsync(int);
#include <assert.h>
#include <stdarg.h>
/* Fake bus in the style of test-create.c: typed token messages with sd-bus
 * cursor rules, every request argument asserted, replies/signals delivered only
 * through sd_bus_process from a FIFO. The fake systemd knows ONE unit; its
 * ActiveState/ControlGroup change only when Kill reaches the invocation path.
 * Any method other than the allowed read-only queries, Unit.Kill and Unit.Stop
 * on the invocation path aborts the test (no StopUnit/KillUnit by name, no
 * ResetFailed, no job cancel). The only exception is Unit.ResetFailed() on the
 * invocation path from a las_reset_open handle (reset tests at the end). */
#define UNIT "step-lc-11111111111111111111111111111111-0000000000000001.service"
#define CGROUP "/system.slice/" UNIT
#define INV "01000000000000000000000000000000"
#define INV_PATH "/org/freedesktop/systemd1/unit/_30" "1000000000000000000000000000000"
#define RULE "type='signal',sender=':1.42',path='/org/freedesktop/systemd1',interface='org.freedesktop.systemd1.Manager',member='JobRemoved',arg2='" UNIT "'"
#define EPOCH "11111111111111111111111111111111"
#define UUID "11111111-1111-1111-1111-111111111111"
#define LAUNCH "22222222222222222222222222222222"
#define CREATE_JOURNAL "INTENT v1 1 1000 " EPOCH " " UUID " " UUID " " UUID " " LAUNCH " " UNIT " " EPOCH " :1.42\n" \
    "JOB 7 /org/freedesktop/systemd1/job/7\nANCHOR 7 " INV " " CGROUP "\n"
#define STOPL "STOP v1 1 " LAUNCH " " UNIT " " EPOCH " :1.42 " INV " 7\n"
#define KILLL "KILL all 9\n"
#define JOB9 "/org/freedesktop/systemd1/job/9"
#define JOBL "JOB 9 " JOB9 "\n"
#define STOPPEDL "STOPPED 9 " INV " failed\n"
#define RESETL "RESET v1 1 " LAUNCH " " UNIT " " EPOCH " :1.42 " INV " 7\n"
#define DONEL "RESET-DONE " INV " inactive\n"
#define DONEGCL "RESET-DONE " INV " collected\n"
enum { REQ=1, REPLY, SIGNAL, PROP };
struct tok { char k, ct; const char *sig, *str; uint64_t n; const void *p; size_t len; };
struct sd_bus { int unused; };
struct sd_bus_slot { int alive; };
#define MSG_TOKENS 16
struct sd_bus_message { int refs, kind, error, depth; size_t n, pos; struct tok t[MSG_TOKENS]; const char *sender, *member; char arg[64]; unsigned char bytes[32]; size_t nbytes; };
static struct sd_bus bus;
static struct sd_bus_slot call_slot, match_slot;
static struct sd_bus_message pool[256];
static sd_bus_message_handler_t method_cb, signal_cb;
static void *method_ctx, *signal_ctx;
static struct las *cur;
static int resets_sent, reset_done, reset_gone, reset_noop;
static int kills, stops, synced, bus_live, bus_events, timeout_fail, process_fail, bypass_arg2, endless, reply_delivered, variant, nth, killed;
static uint64_t clock_us, bus_timeout, call_timeout_now, call_timeout_max, call_timeouts;
static unsigned process_calls;
static const char *after_state, *after_cgroup;
static char fault[96], trace[8192], scratch[512]; static size_t trace_n;
static int auth_token;
static struct { char site[96]; int n; } counts[128]; static size_t ncounts;
static sd_bus_message *queue[256]; static size_t qh, qt;
static int hit(const char *site) {
    size_t i=0; for (;i<ncounts && strcmp(counts[i].site,site);i++) {}
    if (i==ncounts) { assert(ncounts<128 && strlen(site)<96); strcpy(counts[ncounts++].site,site); counts[i].n=0; }
    counts[i].n++; return !strcmp(fault,site) && counts[i].n==nth;
}
static int count(const char *site) { for (size_t i=0;i<ncounts;i++) if (!strcmp(counts[i].site,site)) return counts[i].n; return 0; }
static void record(const char *fmt,...) {
    va_list a; va_start(a,fmt); int n=vsnprintf(trace+trace_n,sizeof trace-trace_n,fmt,a); va_end(a);
    assert(n>=0 && (size_t)n<sizeof trace-trace_n); trace_n+=(size_t)n;
}
static sd_bus_message *msg(int kind) {
    for (size_t i=0;i<sizeof pool/sizeof *pool;i++) if (!pool[i].refs) { memset(&pool[i],0,sizeof pool[i]); pool[i].refs=1; pool[i].kind=kind; return &pool[i]; }
    assert(0); return NULL;
}
static size_t live(void) { size_t n=0; for (size_t i=0;i<sizeof pool/sizeof *pool;i++) n+=pool[i].refs>0; return n; }
static struct tok *put(sd_bus_message *m,char k) { assert(m->n<MSG_TOKENS); struct tok *t=&m->t[m->n++]; memset(t,0,sizeof *t); t->k=k; return t; }
static void put_s(sd_bus_message *m,char k,const char *s) { put(m,k)->str=s; }
static void put_n(sd_bus_message *m,char k,uint64_t n) { put(m,k)->n=n; }
static void put_y(sd_bus_message *m,const void *p,size_t len) { struct tok *t=put(m,'Y'); t->p=p; t->len=len; }
static void open_(sd_bus_message *m,char ct,const char *sig) { struct tok *t=put(m,'<'); t->ct=ct; t->sig=sig; }
static void close_(sd_bus_message *m) { put(m,'>'); }
/* --- sd-bus cursor semantics (as test-create.c) --- */
int sd_bus_message_read(sd_bus_message *m,const char *types,...) {
    assert(m && m->refs>0 && m->kind!=REQ);
    va_list a; va_start(a,types); int first=1, r=1;
    for (const char *p=types;*p && r>0;p++) {
        struct tok *t=m->pos<m->n ? &m->t[m->pos]:NULL;
        if (!t || t->k=='>') { r=first ? 0:-ENXIO; break; }
        first=0;
        if (*p=='(') { if (t->k!='<' || t->ct!='r') { r=-ENXIO; break; } m->depth++; m->pos++; continue; }
        if (*p==')') { r=-ENXIO; break; }
        if (t->k!=*p) { r=-ENXIO; break; }
        if (*p=='s' || *p=='o') *va_arg(a,const char **)=t->str;
        else if (*p=='u') *va_arg(a,uint32_t *)=(uint32_t)t->n;
        else assert(0);
        m->pos++;
        if (p[1]==')') { if (m->pos>=m->n || m->t[m->pos].k!='>') { r=-EBUSY; break; } m->depth--; m->pos++; p++; }
    }
    va_end(a); return r;
}
int sd_bus_message_read_array(sd_bus_message *m,char type,const void **p,size_t *n) {
    assert(m && type=='y'); if (m->pos>=m->n || m->t[m->pos].k!='Y') return -ENXIO;
    *p=m->t[m->pos].p; *n=m->t[m->pos].len; m->pos++; return 1;
}
int sd_bus_message_exit_container(sd_bus_message *m) {
    assert(m && m->kind!=REQ);
    if (!m->depth) return -ENXIO;
    if (m->pos>=m->n || m->t[m->pos].k!='>') return -EBUSY;
    m->pos++; m->depth--; return 1;
}
int sd_bus_message_at_end(sd_bus_message *m,int complete) {
    assert(m && m->kind!=REQ);
    if (complete) return m->pos==m->n;
    return m->pos==m->n || m->t[m->pos].k=='>';
}
int sd_bus_message_is_method_error(sd_bus_message *m,const char *e) { assert(m && m->kind==REPLY && !e); return m->error; }
sd_bus_message *sd_bus_message_unref(sd_bus_message *m) { if (m) { assert(m->refs>0); m->refs--; } return NULL; }
void sd_bus_error_free(sd_bus_error *e) { assert(e); e->name=e->message=NULL; }
/* --- connection --- */
int sd_bus_get_fd(sd_bus *b) { assert(b==&bus && bus_live); return 42; }
int sd_bus_get_events(sd_bus *b) { assert(b==&bus && bus_live); return bus_events; }
int sd_bus_get_timeout(sd_bus *b,uint64_t *t) { assert(b==&bus && bus_live && t); if (timeout_fail) return -EIO; *t=bus_timeout; return 0; }
int fixture_getsockopt(int fd,int level,int opt,void *v,socklen_t *n) {
    assert(fd==42 && level==SOL_SOCKET && opt==SO_PEERCRED && *n==sizeof(struct ucred));
    struct ucred *u=v; memset(u,0,sizeof *u); u->pid=1; u->uid=hit("peer") ? 1000U:0U; *n=sizeof *u; return 0;
}
int fixture_clock_gettime(clockid_t clk,struct timespec *ts) {
    assert(clk==CLOCK_MONOTONIC);
    if (hit("clock")) { errno=EINVAL; return -1; }
    ts->tv_sec=(time_t)(clock_us/1000000); ts->tv_nsec=(long)(clock_us%1000000)*1000; return 0;
}
int fixture_fsync(int fd) {
    if (hit("fsync")) { errno=EIO; return -1; }
    synced++; record("fsync;"); return fsync(fd);
}
int sd_bus_new(sd_bus **b) { assert(!bus_live); if (hit("new")) return -ENOMEM; *b=&bus; bus.unused=0; bus_live=1; return 0; }
int sd_bus_set_address(sd_bus *b,const char *a) { assert(b==&bus && !strcmp(a,"unix:path=/run/dbus/system_bus_socket")); return 0; }
int sd_bus_set_bus_client(sd_bus *b,int x) { assert(b==&bus && x==1); return 0; }
int sd_bus_start(sd_bus *b) { assert(b==&bus && call_timeout_now>0); return hit("start") ? -ECONNREFUSED:0; }
int sd_bus_is_ready(sd_bus *b) { assert(b==&bus); return bus.unused; }
int sd_bus_get_bus_id(sd_bus *b,sd_id128_t *id) { assert(b==&bus); memset(id->bytes,hit("busid") ? 0x12:0x11,16); return 0; }
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t t) {
    assert(b==&bus && t>0 && t<=2000000); call_timeout_now=t; call_timeouts++; if (t>call_timeout_max) call_timeout_max=t; return 0;
}
/* Every blocking call must already be bounded by the time left. */
static void bounded(uint64_t timeout) {
    assert(cur && cur->deadline);
    if (!(clock_us<cur->deadline && timeout<=cur->deadline-clock_us)) {
        fprintf(stderr,"unbounded call: timeout %llu, left %lld (fault %s nth %d)\n",(unsigned long long)timeout,
            (long long)cur->deadline-(long long)clock_us,fault,nth);
        assert(0);
    }
}
static int slow_to_deadline; static uint64_t slow_by;
static void slow(const char *site) {
    if (!hit(site)) return;
    if (slow_to_deadline) clock_us=cur->deadline; else clock_us+=slow_by ? slow_by:6000000;
}
sd_bus *sd_bus_unref(sd_bus *b) { if (b) { assert(b==&bus && bus_live); bus_live=0; } return NULL; }
sd_bus_slot *sd_bus_slot_unref(sd_bus_slot *s) { if (s) { assert(s==&call_slot || s==&match_slot); s->alive=0; } return NULL; }
/* --- requests --- */
static char journal_now[1024];
static const char *stop_journal(void) {
    memset(journal_now,0,sizeof journal_now); assert(pread(cur->fd,journal_now,sizeof journal_now-1,0)>=0); return journal_now;
}
int sd_bus_message_new_method_call(sd_bus *b,sd_bus_message **m,const char *dest,const char *path,const char *iface,const char *member) {
    assert(b==&bus && !strcmp(dest,":1.42"));
    if (!strcmp(member,"GetUnitByInvocationID")) assert(!strcmp(path,"/org/freedesktop/systemd1") && !strcmp(iface,"org.freedesktop.systemd1.Manager"));
    else assert(!strcmp(member,"Stop") && !strcmp(path,INV_PATH) && !strcmp(iface,"org.freedesktop.systemd1.Unit"));
    *m=msg(REQ); (*m)->member=member; return 0;
}
int sd_bus_message_append(sd_bus_message *m,const char *types,...) {
    assert(m->kind==REQ && !strcmp(m->member,"Stop") && !strcmp(types,"s") && !*m->arg);
    va_list a; va_start(a,types); const char *v=va_arg(a,const char *); va_end(a);
    assert(strlen(v)<sizeof m->arg); strcpy(m->arg,v); return 0;
}
int sd_bus_message_append_array(sd_bus_message *m,char type,const void *p,size_t n) {
    assert(m->kind==REQ && !strcmp(m->member,"GetUnitByInvocationID") && type=='y' && n<=sizeof m->bytes && !m->nbytes);
    memcpy(m->bytes,p,n); m->nbytes=n; return 0;
}
static const unsigned char inv_ok[16]={1}, inv_other[16]={2};
static char long_text[600]; /* longer than any reader buffer */
int sd_bus_call(sd_bus *b,sd_bus_message *m,uint64_t usec,sd_bus_error *e,sd_bus_message **out) {
    assert(b==&bus && m && m->kind==REQ && !strcmp(m->member,"GetUnitByInvocationID") && usec==0 && e && !e->name && out);
    assert(m->nbytes==16 && !memcmp(m->bytes,inv_ok,16));
    bounded(call_timeout_now); record("GetUnitByInvocationID;"); slow("slow:ByInvocation");
    if (reset_done && reset_gone) { e->name="org.freedesktop.systemd1.NoUnitForInvocationID"; return -ENXIO; }
    if (hit("ByInvocation-missing")) { e->name="org.freedesktop.systemd1.NoUnitForInvocationID"; return -ENXIO; }
    if (hit("ByInvocation-error")) { e->name="org.freedesktop.DBus.Error.AccessDenied"; return -EACCES; }
    int v=hit("ByInvocation") ? variant:0;
    sd_bus_message *r=msg(REPLY);
    put_s(r,'o',v==1 ? "/org/freedesktop/systemd1/unit/step_2dlc_2d11111111111111111111111111111111_2d0000000000000001_2eservice":
                v==2 ? "/org/freedesktop/systemd1/unit/_302000000000000000000000000000000":INV_PATH);
    if (v==3) put_s(r,'s',"x");
    *out=r; return 1;
}
int sd_bus_call_async(sd_bus *b,sd_bus_slot **s,sd_bus_message *m,sd_bus_message_handler_t cb,void *ctx,uint64_t timeout) {
    assert(b==&bus && m && m->kind==REQ && m->refs==1 && !strcmp(m->member,"Stop") && !strcmp(m->arg,"fail") && cb && ctx==cur && !cur->reset_mode);
    bounded(timeout); assert(timeout<=2000000);
    /* Stop only after the durable STOP and KILL lines */
    assert(!strcmp(stop_journal(),STOPL KILLL));
    stops++; record("Stop;"); if (hit("async")) return -EIO;
    call_slot.alive=1; *s=&call_slot; method_cb=cb; method_ctx=ctx; return 0;
}
int sd_bus_add_match(sd_bus *b,sd_bus_slot **s,const char *rule,sd_bus_message_handler_t cb,void *ctx) {
    assert(b==&bus && !strcmp(rule,RULE) && cb && ctx==cur); record("AddMatch;");
    if (hit("match")) return -ENOMEM;
    match_slot.alive=1; *s=&match_slot; signal_cb=cb; signal_ctx=ctx; return 0;
}
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *member,sd_bus_error *e,sd_bus_message **out,const char *types,...) {
    assert(b==&bus && out && (!e || !strcmp(member,"ResetFailed"))); bounded(call_timeout_now); va_list a; va_start(a,types); sd_bus_message *r=NULL; int rc=1;
    record("%s;",member);
    if (!strcmp(member,"GetNameOwner") || !strcmp(member,"GetConnectionUnixUser")) {
        assert(!strcmp(dest,"org.freedesktop.DBus") && !strcmp(path,"/org/freedesktop/DBus") && !strcmp(iface,"org.freedesktop.DBus") && !strcmp(types,"s"));
        const char *arg=va_arg(a,const char *); r=msg(REPLY);
        if (member[3]=='N') { assert(!strcmp(arg,"org.freedesktop.systemd1")); slow("slow:GetNameOwner"); put_s(r,'s',hit("GetNameOwner") ? ":1.99":":1.42"); if (hit("GetNameOwner-trailing")) put_s(r,'s',"x"); }
        else { assert(!strcmp(arg,":1.42")); slow("slow:GetConnectionUnixUser"); put_n(r,'u',hit("GetConnectionUnixUser") ? 1000:0); if (hit("GetConnectionUnixUser-trailing")) put_s(r,'s',"x"); }
    } else if (!strcmp(member,"Subscribe")) {
        assert(!strcmp(dest,":1.42") && !strcmp(path,"/org/freedesktop/systemd1") && !strcmp(iface,"org.freedesktop.systemd1.Manager") && !strcmp(types,""));
        if (hit("Subscribe")) rc=-EACCES; else { r=msg(REPLY); if (hit("Subscribe-trailing")) put_s(r,'s',"x"); }
    } else if (!strcmp(member,"ResetFailed")) {
        /* only from a reset handle, only on the invocation path, typed (no
         * arguments), only after the durable RESET line */
        assert(cur && cur->reset_mode && las_status(cur)==LAS_UNCERTAIN && las_reset(cur)==-1 &&
            !strcmp(dest,":1.42") && !strcmp(path,INV_PATH) &&
            !strcmp(iface,"org.freedesktop.systemd1.Unit") && !strcmp(types,"") && e && !e->name);
        assert(!strcmp(stop_journal(),RESETL) && synced>0);
        resets_sent++; slow("slow:ResetFailed");
        if (hit("ResetFailed-replaced")) { e->name="org.freedesktop.systemd1.NoUnitForInvocationID"; rc=-ENXIO; }
        else if (hit("ResetFailed")) { e->name="org.freedesktop.DBus.Error.AccessDenied"; rc=-EACCES; }
        else { reset_done=!reset_noop; r=msg(REPLY); if (hit("ResetFailed-trailing")) put_s(r,'s',"x"); }
    } else {
        /* the only mutation besides Stop: Unit.Kill("all", SIGKILL) on the invocation path */
        assert(cur && !cur->reset_mode);
        assert(!strcmp(member,"Kill") && !strcmp(dest,":1.42") && !strcmp(path,INV_PATH) && !strcmp(iface,"org.freedesktop.systemd1.Unit") && !strcmp(types,"si"));
        const char *whom=va_arg(a,const char *); int sig=va_arg(a,int); assert(!strcmp(whom,"all") && sig==9);
        assert(!strcmp(stop_journal(),STOPL) && synced>0); /* durable STOP before the first mutation */
        kills++; slow("slow:Kill");
        if (hit("Kill")) rc=-EIO; else { killed=1; r=msg(REPLY); if (hit("Kill-trailing")) put_s(r,'s',"x"); }
    }
    va_end(a); *out=r; return rc;
}
/* --- the unit's properties, read only through the invocation path --- */
int sd_bus_get_property(sd_bus *b,const char *dest,const char *path,const char *iface,const char *key,sd_bus_error *e,sd_bus_message **out,const char *type) {
    assert(b==&bus && !e && out && !strcmp(dest,":1.42") && !strcmp(path,INV_PATH)); bounded(call_timeout_now);
    static const char *const keys[][3]={{"org.freedesktop.systemd1.Unit","Id","s"},{"org.freedesktop.systemd1.Unit","InvocationID","ay"},
        {"org.freedesktop.systemd1.Service","ControlGroup","s"},{"org.freedesktop.systemd1.Unit","ActiveState","s"},{"org.freedesktop.systemd1.Unit","Job","(uo)"}};
    size_t k=0; for (;k<5 && strcmp(keys[k][1],key);k++) {}
    assert(k<5 && !strcmp(iface,keys[k][0]) && !strcmp(type,keys[k][2]));
    record("Get:%s;",key);
    char site[96];
    (void)snprintf(site,sizeof site,"slow:%s",key); slow(site);
    (void)snprintf(site,sizeof site,"fail:%s",key); if (hit(site)) return -EIO;
    (void)snprintf(site,sizeof site,"prop:%s",key); int v=hit(site) ? variant:0;
    sd_bus_message *m=msg(PROP); open_(m,'v',keys[k][2]);
    if (k==0) put_s(m,'s',v==1 ? "other.service":UNIT);
    else if (k==1) put_y(m,v==2 ? inv_other:inv_ok,v==1 ? 15:16);
    else if (k==2) put_s(m,'s',v==1 ? "/system.slice/other.service":v==2 ? "":v==3 ? CGROUP:v==4 ? long_text:killed ? after_cgroup:CGROUP);
    else if (k==3) put_s(m,'s',v==1 ? "deactivating":v==2 ? "active":v==3 ? "inactive":v==4 ? "":reset_done ? "inactive":killed ? after_state:"active");
    else { open_(m,'r',"uo"); put_n(m,'u',v==1 || v==3 ? 9:0); put_s(m,'o',v==1 ? JOB9:v==2 ? "/org/freedesktop/systemd1/job/0":"/"); close_(m); }
    close_(m);
    (void)snprintf(site,sizeof site,"trail:%s",key); if (hit(site)) put_s(m,'s',"x");
    m->pos=1; m->depth=1; *out=m; return 1;
}
/* --- incoming FIFO, dispatched only by sd_bus_process --- */
static void enqueue(sd_bus_message *m) { assert(qt<sizeof queue/sizeof *queue); queue[qt++]=m; }
static void q_reply(const char *path,int error,int trailing) {
    /* an error reply still carries an 'o' body: only is_method_error rejects it */
    sd_bus_message *m=msg(REPLY); m->error=error; put_s(m,'o',path); if (trailing) put_s(m,'s',"x"); enqueue(m);
}
static void q_signal(const char *sender,unsigned job,const char *path,const char *unit,const char *result) {
    sd_bus_message *m=msg(SIGNAL); m->sender=sender; put_n(m,'u',job); put_s(m,'o',path); put_s(m,'s',unit); put_s(m,'s',result); enqueue(m);
}
static void q_event(void) { q_signal(":1.42",9,JOB9,UNIT,"done"); }
int sd_bus_process(sd_bus *b,sd_bus_message **r) {
    assert(b==&bus && bus_live && !r);
    if (!bus.unused) { bus.unused=1; if (hit("ready-delay")) clock_us+=4000000; return 1; }
    process_calls++; assert(process_calls<100000);
    if (process_fail) return -EIO;
    if (endless && qh==qt) { qh=qt=0; q_signal(":1.42",99,"/org/freedesktop/systemd1/job/99","other.service","done"); clock_us+=100000; }
    if (qh==qt) return 0;
    sd_bus_message *m=queue[qh++];
    if (m->kind==REPLY) { if (call_slot.alive && !reply_delivered) { reply_delivered=1; method_cb(m,method_ctx,NULL); } }
    else if (match_slot.alive && !strcmp(m->sender,":1.42") && m->n>=3 && (bypass_arg2 || !strcmp(m->t[2].str,UNIT))) signal_cb(m,signal_ctx,NULL);
    m->pos=0; sd_bus_message_unref(m); return 1;
}
/* --- scenario plumbing --- */
static int authority(void *ctx,const struct lc_entry *e) { assert(ctx==&auth_token && e->slot==1 && e->state==LC_RUNNING); return hit("exclusive") ? 0:1; }
static char create_path[600], stop_path[600];
static void reset(const char *f,int n,int v) {
    snprintf(fault,sizeof fault,"%s",f ? f:""); nth=n; variant=v; ncounts=0;
    kills=stops=synced=bus_live=timeout_fail=process_fail=bypass_arg2=endless=reply_delivered=killed=0; bus_events=1; bus_timeout=UINT64_MAX;
    clock_us=1000000; call_timeout_now=call_timeout_max=call_timeouts=0; slow_to_deadline=0; slow_by=0; method_ctx=signal_ctx=NULL; cur=NULL;
    process_calls=0; trace_n=0; trace[0]=0; qh=qt=0; call_slot.alive=match_slot.alive=0; method_cb=signal_cb=NULL;
    after_state="failed"; after_cgroup="";
    resets_sent=reset_done=reset_gone=reset_noop=0;
}
static int file(char *path,const char *name,const char *content,int flags) {
    snprintf(path,600,"%s/%s",scratch,name); (void)unlink(path);
    int fd=open(path,O_CREAT|O_EXCL|O_RDWR|O_CLOEXEC,0600); assert(fd>=0 && fchmod(fd,0600)==0);
    size_t n=strlen(content); assert(write(fd,content,n)==(ssize_t)n); close(fd);
    fd=open(path,flags|O_CLOEXEC); assert(fd>=0); return fd;
}
struct fds { int create, stop; };
static struct fds journals(void) { return (struct fds){file(create_path,"create",CREATE_JOURNAL,O_RDONLY),file(stop_path,"stop","",O_RDWR)}; }
static struct las_config config(struct fds f) {
    struct las_config c; memset(&c,0,sizeof c); c.create_fd=f.create; c.stop_fd=f.stop; c.context=&auth_token; c.exclusive=authority;
    c.entry.slot=1; c.entry.principal=1000; c.entry.state=LC_RUNNING;
    strcpy(c.entry.epoch,EPOCH); strcpy(c.entry.launch,LAUNCH); strcpy(c.entry.boot,UUID); strcpy(c.entry.user,UUID); strcpy(c.entry.workspace,UUID);
    strcpy(c.entry.container,"step-lc-" EPOCH "-0000000000000001"); strcpy(c.bus_id,EPOCH); strcpy(c.manager,":1.42"); strcpy(c.invocation,INV); c.job=7;
    return c;
}
static void journal_is(int fd,const char *want) {
    char buf[2048]={0}; ssize_t n=pread(fd,buf,sizeof buf-1,0); assert(n>=0);
    if (strcmp(buf,want)) { fprintf(stderr,"stop journal mismatch (fault %s nth %d variant %d):\n%s\nwant:\n%s\n",fault,nth,variant,buf,want); assert(0); }
}
static void create_intact(void) {
    char buf[2048]={0}; int fd=open(create_path,O_RDONLY|O_CLOEXEC); assert(fd>=0 && pread(fd,buf,sizeof buf-1,0)>=0); close(fd);
    assert(!strcmp(buf,CREATE_JOURNAL)); /* stop never writes the create journal */
}
static void finish(struct las *s,struct fds f) {
    las_close(s); cur=NULL; while (qh<qt) sd_bus_message_unref(queue[qh++]);
    assert(!bus_live && !call_slot.alive && !match_slot.alive && live()==0);
    create_intact(); close(f.create); close(f.stop);
}
static struct las *opened(struct fds f) { struct las_config c=config(f); struct las *s=NULL; assert(las_open(&c,&s)==0 && s); cur=s; return s; }
static void reason_is(struct las *s,enum las_reason want) {
    if (las_reason(s)!=want) { fprintf(stderr,"reason %d, want %d (fault %s nth %d variant %d)\n",las_reason(s),want,fault,nth,variant); assert(0); }
}
/* Stages, by what the stop journal and the fake systemd saw. */
enum outcome { O_OPEN, O_PRE, O_INTENT, O_KILLED, O_SENT, O_JOB, O_STOPPED_LINE, O_STOPPED };
static const char *const JOURNAL_AT[]={"","",STOPL,STOPL KILLL,STOPL KILLL,STOPL KILLL JOBL,STOPL KILLL JOBL STOPPEDL,STOPL KILLL JOBL STOPPEDL};
static void standard(enum outcome want,enum las_reason why) {
    struct fds f=journals(); struct las_config c=config(f); struct las *s=NULL;
    int rc=las_open(&c,&s);
    if (want==O_OPEN) { assert(rc==-1 && !s && kills==0 && stops==0); journal_is(f.stop,""); create_intact(); close(f.create); close(f.stop); return; }
    assert(rc==0 && s && las_status(s)==LAS_NEW && las_reason(s)==LAS_R_NONE); cur=s;
    rc=las_begin(s); assert(las_begin(s)==-1);
    if (want<=O_KILLED) {
        assert(rc==-1 && las_status(s)==LAS_UNCERTAIN && las_poll(s)==-1 && stops==0);
        assert(kills==(want==O_KILLED));
    } else {
        assert(rc==0 && kills==1 && stops==1 && las_status(s)==LAS_PENDING);
        q_reply(JOB9,0,0); q_event();
        for (int i=0;i<4 && las_status(s)==LAS_PENDING;i++) (void)las_poll(s);
    }
    struct las_receipt r;
    if (want==O_STOPPED) {
        if (las_status(s)!=LAS_STOPPED) fprintf(stderr,"not stopped (fault %s nth %d variant %d reason %d)\n",fault,nth,variant,las_reason(s));
        assert(las_status(s)==LAS_STOPPED && las_receipt(s,&r)==0 && r.job==9 && !strcmp(r.invocation,INV) && !strcmp(r.state,after_state));
    } else {
        assert(las_status(s)==LAS_UNCERTAIN && las_receipt(s,&r)==-1);
    }
    reason_is(s,why);
    journal_is(f.stop,want==O_STOPPED && strcmp(after_state,"failed") ? STOPL KILLL JOBL "STOPPED 9 " INV " inactive\n":JOURNAL_AT[want]);
    finish(s,f);
}
static const char *const EXPECTED_TRACE=
    "GetNameOwner;GetConnectionUnixUser;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;"
    "AddMatch;Subscribe;fsync;"
    "GetNameOwner;GetConnectionUnixUser;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;"
    "Kill;fsync;GetNameOwner;GetConnectionUnixUser;Stop;"
    "fsync;GetNameOwner;GetConnectionUnixUser;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;"
    "GetNameOwner;GetConnectionUnixUser;fsync;";
static void test_success(void) {
    reset(NULL,0,0); standard(O_STOPPED,LAS_R_NONE);
    if (strcmp(trace,EXPECTED_TRACE)) { fprintf(stderr,"trace mismatch:\n%s\n",trace); assert(0); }
    /* exact re-check counts: open, begin, after STOP, before Stop, poll, readback x2, after STOPPED */
    assert(count("exclusive")==8);
    assert(count("peer")==5 && count("busid")==5 && count("GetNameOwner")==5 && count("GetConnectionUnixUser")==5);
    assert(process_calls==3 && synced==4);
    /* cleanly inactive (not failed) and a still-reported cgroup are accepted afterwards too */
    reset(NULL,0,0); after_state="inactive"; standard(O_STOPPED,LAS_R_NONE);
    reset(NULL,0,0); after_cgroup=CGROUP; standard(O_STOPPED,LAS_R_NONE);
}
static void test_authority_and_owner(void) {
    static const enum outcome excl[]={O_OPEN,O_PRE,O_INTENT,O_KILLED,O_SENT,O_JOB,O_JOB,O_STOPPED_LINE,O_STOPPED};
    for (int n=1;n<=9;n++) { reset("exclusive",n,0); standard(excl[n-1],n==9 ? LAS_R_NONE:LAS_R_AUTHORITY); }
    static const char *const facets[]={"peer","busid","GetNameOwner","GetConnectionUnixUser","GetNameOwner-trailing","GetConnectionUnixUser-trailing"};
    static const enum outcome own[]={O_PRE,O_INTENT,O_KILLED,O_JOB,O_JOB,O_STOPPED};
    for (size_t k=0;k<6;k++) for (int n=1;n<=6;n++) { reset(facets[k],n,0); standard(own[n-1],n==6 ? LAS_R_NONE:LAS_R_OWNER); }
}
/* Every property / lookup perturbation at each of the three verifications:
 * 1 before STOP (nothing attempted), 2 immediately before Kill (STOP only, no
 * Kill sent), 3 after the Stop job (uncertain, not STOPPED). */
static void test_incarnation(void) {
    static const enum outcome at[]={O_PRE,O_INTENT,O_JOB};
    static const struct { const char *site; int v; enum las_reason before, after; } t[]={
        {"ByInvocation-missing",0,LAS_R_REPLACED,LAS_R_REPLACED}, {"ByInvocation-error",0,LAS_R_QUERY,LAS_R_QUERY},
        {"ByInvocation",1,LAS_R_REPLACED,LAS_R_REPLACED}, {"ByInvocation",2,LAS_R_REPLACED,LAS_R_REPLACED}, {"ByInvocation",3,LAS_R_QUERY,LAS_R_QUERY},
        {"prop:Id",1,LAS_R_REPLACED,LAS_R_REPLACED}, {"prop:InvocationID",1,LAS_R_QUERY,LAS_R_QUERY}, {"prop:InvocationID",2,LAS_R_REPLACED,LAS_R_REPLACED},
        {"prop:ControlGroup",1,LAS_R_REPLACED,LAS_R_REPLACED}, {"prop:ControlGroup",2,LAS_R_REPLACED,LAS_R_NONE}, {"prop:ControlGroup",3,LAS_R_NONE,LAS_R_NONE},
        {"prop:ControlGroup",4,LAS_R_QUERY,LAS_R_QUERY},
        {"prop:ActiveState",1,LAS_R_STATE,LAS_R_STATE}, {"prop:ActiveState",2,LAS_R_NONE,LAS_R_STATE},
        {"prop:ActiveState",3,LAS_R_STATE,LAS_R_NONE}, {"prop:ActiveState",4,LAS_R_STATE,LAS_R_STATE},
        {"prop:Job",1,LAS_R_JOB,LAS_R_JOB}, {"prop:Job",2,LAS_R_JOB,LAS_R_JOB}, {"prop:Job",3,LAS_R_JOB,LAS_R_JOB},
    };
    for (size_t i=0;i<sizeof t/sizeof *t;i++) for (int n=1;n<=3;n++) {
        reset(t[i].site,n,t[i].v);
        enum las_reason want=n<3 ? t[i].before:t[i].after;
        if (want!=LAS_R_NONE) { standard(at[n-1],want); continue; }
        if (n==3 && !strcmp(t[i].site,"prop:ActiveState")) after_state="inactive"; /* variant 3 read afterwards */
        standard(O_STOPPED,LAS_R_NONE);
    }
    /* malformed replies and failed Gets of every property */
    static const char *const keys[]={"Id","InvocationID","ControlGroup","ActiveState","Job"};
    for (size_t k=0;k<5;k++) for (int n=1;n<=3;n++) {
        char site[96];
        snprintf(site,sizeof site,"trail:%s",keys[k]); reset(site,n,0); standard(at[n-1],LAS_R_QUERY);
        snprintf(site,sizeof site,"fail:%s",keys[k]); reset(site,n,0); standard(at[n-1],LAS_R_QUERY);
    }
    /* replacement between the first check and the action: Kill is never sent */
    reset("ByInvocation-missing",2,0); standard(O_INTENT,LAS_R_REPLACED); assert(kills==0 && count("ByInvocation-missing")==2);
    /* a pending start job (drain policy: refuse, never cancel) */
    reset("prop:Job",1,1); standard(O_PRE,LAS_R_JOB); assert(kills==0);
}
static void test_begin_faults(void) {
    static const struct { const char *f; int n; enum outcome o; enum las_reason r; } t[]={
        {"new",1,O_PRE,LAS_R_BUS}, {"start",1,O_PRE,LAS_R_BUS}, {"match",1,O_PRE,LAS_R_BUS}, {"Subscribe",1,O_PRE,LAS_R_BUS},
        {"Subscribe-trailing",1,O_PRE,LAS_R_BUS}, {"clock",1,O_PRE,LAS_R_DEADLINE}, {"fsync",2,O_KILLED,LAS_R_JOURNAL},
        {"Kill-trailing",1,O_KILLED,LAS_R_KILL}, {"fsync",3,O_JOB,LAS_R_JOURNAL}, {"fsync",4,O_STOPPED_LINE,LAS_R_JOURNAL},
    };
    for (size_t i=0;i<sizeof t/sizeof *t;i++) {
        reset(t[i].f,t[i].n,0);
        if (t[i].o==O_KILLED && !strcmp(t[i].f,"fsync")) {
            /* KILL line written but not durable: Stop is never sent */
            struct fds f=journals(); struct las *s=opened(f);
            assert(las_begin(s)==-1 && kills==1 && stops==0); reason_is(s,LAS_R_JOURNAL); journal_is(f.stop,STOPL KILLL); finish(s,f); continue;
        }
        if (t[i].o==O_KILLED) {
            struct fds f=journals(); struct las *s=opened(f);
            assert(las_begin(s)==-1 && kills==1 && stops==0); reason_is(s,t[i].r); journal_is(f.stop,STOPL); finish(s,f); continue;
        }
        standard(t[i].o,t[i].r);
    }
    /* Kill error: the call reached systemd, outcome unknown; Stop never sent */
    reset("Kill",1,0); struct fds f=journals(); struct las *s=opened(f);
    assert(las_begin(s)==-1 && kills==1 && stops==0); reason_is(s,LAS_R_KILL); journal_is(f.stop,STOPL); finish(s,f);
    /* failed STOP fsync: bytes written, Kill never sent, journal never reusable */
    reset("fsync",1,0); f=journals(); s=opened(f);
    assert(las_begin(s)==-1 && kills==0); reason_is(s,LAS_R_JOURNAL); journal_is(f.stop,STOPL);
    struct las_config c=config(f); struct las *again=NULL; las_close(s); cur=NULL;
    assert(las_open(&c,&again)==-1 && !again); create_intact(); close(f.create); close(f.stop);
    /* async enqueue failure after durable KILL */
    reset("async",1,0); f=journals(); s=opened(f);
    assert(las_begin(s)==-1 && kills==1 && stops==1 && las_status(s)==LAS_UNCERTAIN); reason_is(s,LAS_R_STOP); journal_is(f.stop,STOPL KILLL); finish(s,f);
    /* a slow Kill consumes the budget: the Stop is never sent */
    reset("slow:Kill",1,0); f=journals(); s=opened(f);
    assert(las_begin(s)==-1 && kills==1 && stops==0); reason_is(s,LAS_R_DEADLINE); journal_is(f.stop,STOPL KILLL); finish(s,f);
    /* clock fails at each later point of begin */
    for (int n=2;n<=4;n++) { reset("clock",n,0); f=journals(); s=opened(f); assert(las_begin(s)==-1); reason_is(s,LAS_R_DEADLINE); finish(s,f); }
}
static struct las *pending(struct fds f) { struct las *s=opened(f); assert(las_begin(s)==0 && las_status(s)==LAS_PENDING); return s; }
static void expect(struct las *s,struct fds f,enum las_status st,enum las_reason r,const char *journal) {
    assert(las_status(s)==st); reason_is(s,r); journal_is(f.stop,journal); finish(s,f);
}
static void test_events(void) {
    static const struct { unsigned job; const char *path, *result; } bad[]={
        {8,"/org/freedesktop/systemd1/job/8","done"},   /* consistent event for another job on our unit */
        {9,"/org/freedesktop/systemd1/job/8","done"},   /* id/path disagree */
        {9,JOB9,"failed"}, {9,JOB9,"canceled"}, {9,JOB9,"timeout"}, {9,"/org/freedesktop/systemd1/job/09","done"},
    };
    for (size_t i=0;i<sizeof bad/sizeof *bad;i++) {
        reset(NULL,0,0); struct fds f=journals(); struct las *s=pending(f);
        q_reply(JOB9,0,0); q_signal(":1.42",bad[i].job,bad[i].path,UNIT,bad[i].result);
        assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_EVENT,STOPL KILLL JOBL);
    }
    /* a foreign job's event before our reply: stored, then mismatched */
    reset(NULL,0,0); struct fds f=journals(); struct las *s=pending(f);
    q_signal(":1.42",8,"/org/freedesktop/systemd1/job/8",UNIT,"done"); q_reply(JOB9,0,0);
    assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_EVENT,STOPL KILLL JOBL);
    /* duplicate successful event */
    reset(NULL,0,0); f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event(); q_event();
    assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_EVENT,STOPL KILLL JOBL);
    /* other unit (bus filter bypassed) is ignored, then ours stops */
    reset(NULL,0,0); bypass_arg2=1; f=journals(); s=pending(f);
    q_reply(JOB9,0,0); q_signal(":1.42",9,JOB9,"other.service","failed"); q_event(); assert(las_poll(s)==1);
    expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* malformed signal body */
    reset(NULL,0,0); f=journals(); s=pending(f);
    { sd_bus_message *m=msg(SIGNAL); m->sender=":1.42"; put_n(m,'u',9); put_s(m,'o',JOB9); put_s(m,'s',UNIT); put_s(m,'s',"done"); put_s(m,'s',"x"); enqueue(m); }
    q_reply(JOB9,0,0); /* dispatch stops at the terminal state: this reply is never handled */
    assert(las_poll(s)==-1 && qt-qh==1); expect(s,f,LAS_UNCERTAIN,LAS_R_EVENT,STOPL KILLL);
    /* Stop reply: method error (e.g. mode fail refused by a conflicting job), trailing, bad job paths
     * (zero, leading zero, 2^32+9 which would truncate to our job 9, non-digit, other prefix) */
    static const char *const paths[]={JOB9,JOB9,"/org/freedesktop/systemd1/job/0","/org/freedesktop/systemd1/job/09",
        "/org/freedesktop/systemd1/job/4294967305","/org/freedesktop/systemd1/job/9x","/org/freedesktop/systemd1/xyz/9"};
    for (int k=0;k<7;k++) {
        reset(NULL,0,0); f=journals(); s=pending(f);
        q_reply(paths[k],k==0,k==1); q_event();
        assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_STOP,STOPL KILLL);
    }
    /* reply fsync fault: JOB written, not durable */
    reset("fsync",3,0); f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event();
    assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_JOURNAL,STOPL KILLL JOBL);
}
static void test_dispatch(void) {
    /* flood of other-unit signals that bypass the bus arg2 filter: 32 per poll */
    reset(NULL,0,0); bypass_arg2=1; struct fds f=journals(); struct las *s=pending(f);
    for (int i=0;i<40;i++) q_signal(":1.42",(unsigned)(100+i),"/org/freedesktop/systemd1/job/100","other.service","failed");
    q_reply(JOB9,0,0); q_event();
    assert(las_poll(s)==0 && process_calls==32 && las_status(s)==LAS_PENDING && qt-qh==10);
    assert(las_poll(s)==1 && process_calls==32+11); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* endless flood: bounded per poll, terminal at the deadline */
    reset(NULL,0,0); endless=1; f=journals(); s=pending(f);
    int polls=0; while (las_status(s)==LAS_PENDING) { assert(las_poll(s)<=0); polls++; assert(polls<100); }
    assert(polls>1); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL);
    /* Stop reply never arrives (bus timeout or lost): terminal at the deadline */
    reset(NULL,0,0); f=journals(); s=pending(f); q_event();
    assert(las_poll(s)==0 && process_calls==2); clock_us+=5000000; assert(las_poll(s)==-1 && process_calls==2); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL);
    /* JobRemoved never arrives */
    reset(NULL,0,0); f=journals(); s=pending(f); q_reply(JOB9,0,0);
    assert(las_poll(s)==0); clock_us+=5000000; assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL JOBL);
    /* event before reply, one poll */
    reset(NULL,0,0); f=journals(); s=pending(f); q_event(); q_reply(JOB9,0,0);
    assert(las_poll(s)==1); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* event and reply in separate polls, both orders */
    for (int order=0;order<2;order++) {
        reset(NULL,0,0); f=journals(); s=pending(f);
        if (order) q_event(); else q_reply(JOB9,0,0);
        assert(las_poll(s)==0 && las_status(s)==LAS_PENDING && las_poll(s)==0);
        if (order) q_reply(JOB9,0,0); else q_event();
        assert(las_poll(s)==1); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    }
    /* spoofed sender is dropped by the match; our real event still stops */
    reset(NULL,0,0); f=journals(); s=pending(f);
    q_signal(":1.99",9,JOB9,UNIT,"failed"); q_reply(JOB9,0,0); assert(las_poll(s)==0); q_event(); assert(las_poll(s)==1);
    expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* dispatch error */
    reset(NULL,0,0); f=journals(); s=pending(f); process_fail=1; assert(las_poll(s)==-1); expect(s,f,LAS_UNCERTAIN,LAS_R_DISPATCH,STOPL KILLL);
    /* deadline expired before dispatch, or poll entered exactly at it: nothing dispatched */
    for (int exact=0;exact<2;exact++) {
        reset(NULL,0,0); f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event(); if (exact) clock_us=s->deadline; else clock_us+=5000000;
        assert(las_poll(s)==-1 && process_calls==0); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL);
    }
    /* slow calls: each blocking call is budgeted, the next call is never made */
    for (int exact=0;exact<2;exact++) {
        /* 4th GetNameOwner = readback entry */
        reset("slow:GetNameOwner",4,0); slow_to_deadline=exact; f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event();
        assert(las_poll(s)==-1 && count("GetConnectionUnixUser")==3 && count("ByInvocation")==2); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL JOBL);
        reset("slow:ActiveState",3,0); slow_to_deadline=exact; f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event();
        assert(las_poll(s)==-1 && count("prop:Job")==2); expect(s,f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL JOBL);
        /* in begin: slow first lookup stops everything before STOP */
        reset("slow:ByInvocation",1,0); slow_to_deadline=exact; f=journals(); s=opened(f);
        assert(las_begin(s)==-1 && count("prop:Id")==0 && kills==0); reason_is(s,LAS_R_DEADLINE); journal_is(f.stop,""); finish(s,f);
        /* slow pre-Kill Job read: Kill never sent */
        reset("slow:Job",2,0); slow_to_deadline=exact; f=journals(); s=opened(f);
        assert(las_begin(s)==-1 && kills==0); reason_is(s,LAS_R_DEADLINE); journal_is(f.stop,STOPL); finish(s,f);
        /* slow GetConnectionUnixUser right before the Stop send */
        reset("slow:GetConnectionUnixUser",3,0); slow_to_deadline=exact; f=journals(); s=opened(f);
        assert(las_begin(s)==-1 && kills==1 && stops==0); reason_is(s,LAS_R_DEADLINE); journal_is(f.stop,STOPL KILLL); finish(s,f);
    }
    /* the first verification ends on a slow Job read: Subscribe is never called */
    reset("slow:Job",1,0); standard(O_PRE,LAS_R_DEADLINE); assert(count("Subscribe")==0);
    /* 0.5 s left when the Stop is sent: its reply timeout is capped at that */
    reset("slow:GetConnectionUnixUser",3,0); slow_by=4500000; f=journals(); s=opened(f);
    assert(las_begin(s)==0 && stops==1 && clock_us==s->deadline-500000); q_reply(JOB9,0,0); q_event();
    assert(las_poll(s)==1); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* the stop journal descriptor's offset is not trusted: lines start at 0 */
    reset(NULL,0,0); f=journals(); assert(lseek(f.stop,5,SEEK_SET)==5); s=pending(f); q_reply(JOB9,0,0); q_event();
    assert(las_poll(s)==1); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* the last readback call is slow: only the post-readback deadline check sees it */
    reset("slow:GetConnectionUnixUser",5,0); standard(O_JOB,LAS_R_DEADLINE);
    reset("slow:GetConnectionUnixUser",5,0); slow_to_deadline=1; standard(O_JOB,LAS_R_DEADLINE);
    /* per-call timeouts are capped at the time left: 300 ms left at readback */
    reset(NULL,0,0); f=journals(); s=pending(f); q_reply(JOB9,0,0); q_event(); clock_us=s->deadline-300000; call_timeout_max=0;
    assert(las_poll(s)==1 && call_timeout_max==300000); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    /* clock failures in poll: entry, post-readback */
    reset(NULL,0,0); f=journals(); s=pending(f); int in_begin=count("clock"); q_reply(JOB9,0,0); q_event();
    assert(las_poll(s)==1); int total=count("clock"); expect(s,f,LAS_STOPPED,LAS_R_NONE,STOPL KILLL JOBL STOPPEDL);
    assert(in_begin==26 && total==in_begin+12); /* every blocking call reads the clock for its budget */
    reset("clock",in_begin+1,0); standard(O_SENT,LAS_R_DEADLINE);
    reset("clock",total,0); standard(O_JOB,LAS_R_DEADLINE);
    /* a clock failure at ANY read is terminal DEADLINE, never STOPPED */
    for (int n=1;n<=total;n++) {
        reset("clock",n,0); f=journals(); s=opened(f);
        if (las_begin(s)==0) { q_reply(JOB9,0,0); q_event(); for (int i=0;i<4 && las_status(s)==LAS_PENDING;i++) (void)las_poll(s); }
        assert(las_status(s)==LAS_UNCERTAIN); reason_is(s,LAS_R_DEADLINE); assert(n>in_begin || stops==0); finish(s,f);
    }
}
static void test_api(void) {
    reset("ready-delay",1,0); struct fds delayed_f=journals(); struct las *delayed=pending(delayed_f);
    assert(delayed->deadline==6000000 && clock_us==5000000 && count("ready-delay")==1);
    clock_us+=1000000; assert(las_poll(delayed)==-1); expect(delayed,delayed_f,LAS_UNCERTAIN,LAS_R_DEADLINE,STOPL KILLL);
    reset(NULL,0,0); struct fds f=journals(); struct las *s=opened(f); uint64_t us=1;
    assert(las_fd(NULL)==-1 && las_events(NULL)==-1 && las_timeout(NULL,&us)==-1 && las_status(NULL)==LAS_UNCERTAIN && las_reason(NULL)==LAS_R_NONE);
    assert(las_fd(s)==-1 && las_events(s)==-1 && las_timeout(s,&us)==-1 && las_poll(s)==-1 && las_status(s)==LAS_NEW);
    assert(las_begin(s)==0 && las_fd(s)==42 && las_timeout(s,NULL)==-1);
    bus_events=5; assert(las_events(s)==5);
    assert(las_timeout(s,&us)==0 && us==5000000);
    clock_us+=1500000; assert(las_timeout(s,&us)==0 && us==3500000);
    bus_timeout=clock_us+700; assert(las_timeout(s,&us)==0 && us==700);
    bus_timeout=clock_us-1; assert(las_timeout(s,&us)==0 && us==0);
    bus_timeout=UINT64_MAX; clock_us+=4000000; assert(las_timeout(s,&us)==0 && us==0);
    timeout_fail=1; assert(las_timeout(s,&us)==-1); timeout_fail=0;
    clock_us-=4000000; q_reply(JOB9,0,0); q_event(); assert(las_poll(s)==1);
    assert(las_fd(s)==-1 && las_events(s)==-1 && las_timeout(s,&us)==-1 && las_poll(s)==-1 && las_begin(s)==-1);
    las_close(NULL); finish(s,f);
}
static void denied(const struct las_config *c) { struct las *s=NULL; assert(las_open(c,&s)==-1 && !s); }
static void rewrite(const char *content);
/* Render the create journal exactly from *bad (container derived from its own
 * epoch+slot), so a refusal can only come from field validation. */
static void consistent_denied(struct las_config *bad) {
    char unit[200], journal[2048]; size_t n=0; struct fds f=journals();
    (void)snprintf(bad->entry.container,sizeof bad->entry.container,"step-lc-%.32s-%016llx",bad->entry.epoch,(unsigned long long)bad->entry.slot);
    (void)snprintf(unit,sizeof unit,"%s.service",bad->entry.container);
    assert(render_create(bad,unit,journal,sizeof journal,&n)); rewrite(journal);
    bad->create_fd=f.create; bad->stop_fd=f.stop; denied(bad); close(f.create); close(f.stop);
}
static void rewrite(const char *content) { int fd=open(create_path,O_WRONLY|O_TRUNC|O_CLOEXEC); size_t n=strlen(content); assert(fd>=0 && write(fd,content,n)==(ssize_t)n); close(fd); }
static void test_open(void) {
    reset(NULL,0,0); struct fds f=journals(); struct las_config c=config(f), bad;
    assert(las_open(&c,NULL)==-1 && las_open(NULL,(struct las **)&bad)==-1);
    static const char *names[]={":1.42'bad","1.42","11.42",":1",":1.",":12.",":.42",":1..42",":1.42.7",":1.4a",":1a2",":1'2",":1.42,x",":",":1.42 "};
    for (size_t k=0;k<sizeof names/sizeof *names;k++) { bad=c; strcpy(bad.manager,names[k]); denied(&bad); }
    static const enum lc_state states[]={LC_RESERVED,LC_RELEASED,0,7};
    for (size_t k=0;k<4;k++) { bad=c; bad.entry.state=states[k]; denied(&bad); }
    bad=c; bad.exclusive=NULL; denied(&bad);
    bad=c; bad.entry.slot=0; denied(&bad);
    bad=c; bad.job=0; denied(&bad);
    bad=c; strcpy(bad.entry.container,"arbitrary"); denied(&bad);
    bad=c; strcpy(bad.invocation,"00000000000000000000000000000000"); denied(&bad);
    bad=c; strcpy(bad.invocation,"0100000000000000000000000000000G"); denied(&bad);
    bad=c; strcpy(bad.bus_id,"1111111111111111111111111111111"); denied(&bad);
    bad=c; strcpy(bad.entry.launch,"/bin/sh"); denied(&bad);
    bad=c; strcpy(bad.entry.epoch,"x"); denied(&bad);
    bad=c; strcpy(bad.entry.boot,"x"); denied(&bad);
    bad=c; strcpy(bad.entry.user,"x"); denied(&bad);
    bad=c; strcpy(bad.entry.workspace,"x"); denied(&bad);
    /* the create journal must equal create.c's exact rendering of these inputs */
    bad=c; strcpy(bad.invocation,"03000000000000000000000000000000"); denied(&bad);
    bad=c; bad.job=8; denied(&bad);
    bad=c; strcpy(bad.manager,":1.43"); denied(&bad);
    bad=c; strcpy(bad.bus_id,"21111111111111111111111111111111"); denied(&bad);
    bad=c; bad.entry.principal=1001; denied(&bad);
    bad=c; strcpy(bad.entry.launch,"32222222222222222222222222222222"); denied(&bad);
    bad=c; strcpy(bad.entry.boot,"21111111-1111-1111-1111-111111111111"); denied(&bad);
    bad=c; strcpy(bad.entry.user,"21111111-1111-1111-1111-111111111111"); denied(&bad);
    bad=c; strcpy(bad.entry.workspace,"21111111-1111-1111-1111-111111111111"); denied(&bad);
    assert(kills==0 && count("exclusive")==0);
    close(f.create); close(f.stop);
    /* each validator alone: the create journal is rendered consistently with
     * the bad input, so only the field check can refuse it */
    struct las_config v=config(f);
    #define CONSISTENT(stmt) do { bad=v; stmt; consistent_denied(&bad); } while (0)
    CONSISTENT(bad.entry.slot=0);
    CONSISTENT(bad.job=0);
    CONSISTENT(strcpy(bad.invocation,"00000000000000000000000000000000"));
    CONSISTENT(strcpy(bad.invocation,"0100000000000000000000000000000A"));
    CONSISTENT(strcpy(bad.invocation,"0100000000000000000000000000000"));
    CONSISTENT(strcpy(bad.bus_id,"1111111111111111111111111111111g"));
    CONSISTENT(strcpy(bad.entry.epoch,"1111111111111111111111111111111G"));
    CONSISTENT(strcpy(bad.entry.launch,"2222222222222222222222222222222"));
    CONSISTENT(strcpy(bad.entry.boot,"11111111-1111-1111-1111-11111111111"));
    CONSISTENT(strcpy(bad.entry.user,"11111111x1111-1111-1111-111111111111"));
    CONSISTENT(strcpy(bad.entry.workspace,"11111111-1111-1111-1111-11111111111g"));
    for (size_t k=0;k<sizeof names/sizeof *names;k++) CONSISTENT(strcpy(bad.manager,names[k]));
    CONSISTENT(memset(bad.manager,'1',sizeof bad.manager); memcpy(bad.manager,":1.",3)); /* no terminator */
    CONSISTENT(memset(bad.invocation,'1',sizeof bad.invocation));                         /* 33 hex, no terminator */
    CONSISTENT(memcpy(bad.entry.boot,UUID "1",sizeof bad.entry.boot));                    /* 37 bytes, no terminator */
    #undef CONSISTENT
    static const char *const journals_bad[]={"",
        "INTENT v1 1 1000 " EPOCH " " UUID " " UUID " " UUID " " LAUNCH " " UNIT " " EPOCH " :1.42\n",
        "INTENT v1 1 1000 " EPOCH " " UUID " " UUID " " UUID " " LAUNCH " " UNIT " " EPOCH " :1.42\nJOB 7 /org/freedesktop/systemd1/job/7\n",
        CREATE_JOURNAL "x", CREATE_JOURNAL "\n", "x" CREATE_JOURNAL};
    for (size_t k=0;k<sizeof journals_bad/sizeof *journals_bad;k++) { f=journals(); rewrite(journals_bad[k]); c=config(f); denied(&c); close(f.create); close(f.stop); }
    /* create journal attributes */
    f=journals(); c=config(f);
    assert(chmod(create_path,0640)==0); denied(&c); assert(chmod(create_path,0400)==0); denied(&c); assert(chmod(create_path,0600)==0);
    char link2[600]; snprintf(link2,sizeof link2,"%s/create-link",scratch); (void)unlink(link2);
    assert(link(create_path,link2)==0); denied(&c); assert(unlink(link2)==0);
    lsc_test_create_uid=getuid()+1; denied(&c); lsc_test_create_uid=getuid();
    close(f.create); c.create_fd=open(create_path,O_WRONLY|O_CLOEXEC); assert(c.create_fd>=0); denied(&c); close(c.create_fd);
    c.create_fd=open(create_path,O_RDWR|O_CLOEXEC); assert(c.create_fd>=0); { struct las *s=NULL; assert(las_open(&c,&s)==0); las_close(s); } close(c.create_fd);
    char fifo[600]; snprintf(fifo,sizeof fifo,"%s/fifo",scratch); (void)unlink(fifo); assert(mkfifo(fifo,0600)==0);
    c.create_fd=open(fifo,O_RDWR|O_NONBLOCK|O_CLOEXEC); assert(c.create_fd>=0); denied(&c); close(c.create_fd);
    /* stop journal attributes */
    c.create_fd=open(create_path,O_RDONLY|O_CLOEXEC); assert(c.create_fd>=0);
    assert(chmod(stop_path,0640)==0); denied(&c); assert(chmod(stop_path,0660)==0); denied(&c); assert(chmod(stop_path,0600)==0);
    snprintf(link2,sizeof link2,"%s/stop-link",scratch); (void)unlink(link2); assert(link(stop_path,link2)==0); denied(&c); assert(unlink(link2)==0);
    close(f.stop); c.stop_fd=open(stop_path,O_RDONLY|O_CLOEXEC); denied(&c); close(c.stop_fd);
    c.stop_fd=open(stop_path,O_WRONLY|O_CLOEXEC); denied(&c); close(c.stop_fd);
    c.stop_fd=open(fifo,O_RDWR|O_NONBLOCK|O_CLOEXEC); denied(&c); close(c.stop_fd); assert(unlink(fifo)==0);
    c.stop_fd=open(stop_path,O_RDWR|O_CLOEXEC); assert(c.stop_fd>=0 && write(c.stop_fd,"x",1)==1); denied(&c); close(c.stop_fd);   /* nonempty */
    c.stop_fd=file(stop_path,"stop","",O_RDWR); assert(unlink(stop_path)==0); denied(&c); close(c.stop_fd);                       /* nlink 0 */
    c.stop_fd=file(stop_path,"stop","",O_RDWR); lsc_test_journal_uid=getuid()+1; denied(&c); lsc_test_journal_uid=getuid();
    /* a refused open after its flock leaves the lock on the caller's open file
     * descriptions (as lsc_open/lcr_open): only closing them releases it */
    { int probe=open(create_path,O_RDONLY|O_CLOEXEC); assert(probe>=0 && flock(probe,LOCK_EX|LOCK_NB)==-1 && errno==EWOULDBLOCK); close(probe); }
    close(c.create_fd); c.create_fd=open(create_path,O_RDONLY|O_CLOEXEC); assert(c.create_fd>=0);
    close(c.stop_fd); c.stop_fd=file(stop_path,"stop","",O_RDWR);
    /* flock: an in-flight creator / reconciler on the create journal, or another stopper, excludes open */
    int other=open(create_path,O_RDONLY|O_CLOEXEC); assert(other>=0 && flock(other,LOCK_EX|LOCK_NB)==0); denied(&c); close(other);
    other=open(stop_path,O_RDWR|O_CLOEXEC); assert(other>=0 && flock(other,LOCK_EX|LOCK_NB)==0); denied(&c); close(other);
    { struct las *s=NULL, *t=NULL; assert(las_open(&c,&s)==0); struct las_config c2=c;
      c2.create_fd=open(create_path,O_RDONLY|O_CLOEXEC); assert(c2.create_fd>=0); denied(&c2); /* held by s */
      /* the lock lives on the open file description: released only once the
       * caller's own descriptor of it is closed too */
      las_close(s); denied(&c2); close(c.create_fd); assert(las_open(&c2,&t)==0); las_close(t); close(c2.create_fd); }
    close(c.stop_fd);
    /* the create journal changes between open and begin: nothing is attempted */
    reset(NULL,0,0); f=journals(); { struct las *s=opened(f); rewrite(CREATE_JOURNAL); int fd=open(create_path,O_WRONLY|O_APPEND|O_CLOEXEC);
      assert(fd>=0 && write(fd,"x",1)==1); close(fd);
      assert(las_begin(s)==-1 && !bus_live && kills==0); reason_is(s,LAS_R_CREATE); journal_is(f.stop,""); las_close(s); cur=NULL; rewrite(CREATE_JOURNAL); }
    close(f.create); close(f.stop);
    /* a stop journal written by someone between open and begin: refused before STOP */
    reset(NULL,0,0); f=journals(); { struct las *s=opened(f); assert(write(f.stop,"x",1)==1);
      assert(las_begin(s)==-1 && kills==0); reason_is(s,LAS_R_JOURNAL); journal_is(f.stop,"x"); las_close(s); cur=NULL; }
    close(f.create); close(f.stop);
}
/* Create journal modified by another actor after STOP but before the pre-Kill
 * check: exercised through the authority callback, which runs right after the
 * STOP fsync (3rd exclusive call) and mutates the create journal there. */
static int mutate_on;
static int authority_mutating(void *ctx,const struct lc_entry *e) {
    int r=authority(ctx,e);
    if (mutate_on && count("exclusive")==3) { int fd=open(create_path,O_WRONLY|O_APPEND|O_CLOEXEC); assert(fd>=0 && write(fd,"x",1)==1); close(fd); }
    return r;
}
static void test_create_changed_before_kill(void) {
    reset(NULL,0,0); struct fds f=journals(); struct las_config c=config(f); c.exclusive=authority_mutating; struct las *s=NULL;
    mutate_on=1; assert(las_open(&c,&s)==0); cur=s;
    assert(las_begin(s)==-1 && kills==0); mutate_on=0; reason_is(s,LAS_R_CREATE); journal_is(f.stop,STOPL);
    las_close(s); cur=NULL; rewrite(CREATE_JOURNAL); close(f.create); close(f.stop);
}

/* ---------------- post-absence reset (las_reset_open / las_reset) ---------------- */
static int absence_token;
static int absence_gate(void *ctx,const struct lc_entry *e) {
    assert(ctx==&absence_token && e->slot==1 && e->state==LC_RUNNING && !strcmp(e->launch,LAUNCH)); return hit("absent") ? 0:1;
}
/* A stopped anchor: failed (SIGKILL), still loaded, ControlGroup "" (pruned). */
static void stopped_unit(const char *f,int n,int v) { reset(f,n,v); killed=1; }
static struct las *reset_opened(struct fds f) {
    struct las_config c=config(f); struct las *s=NULL; assert(las_reset_open(&c,absence_gate,&absence_token,&s)==0 && s); cur=s; return s;
}
enum r_outcome { R_OPEN, R_NOTHING, R_INTENT, R_SENT, R_DONE_LINE, R_RESET };
/* Stages by what the reset record and the fake systemd saw. */
static void r_standard(enum r_outcome want,enum las_reason why) {
    struct fds f=journals(); struct las_config c=config(f); struct las *s=NULL;
    int rc=las_reset_open(&c,absence_gate,&absence_token,&s);
    if (want==R_OPEN) { assert(rc==-1 && !s && resets_sent==0); journal_is(f.stop,""); create_intact(); close(f.create); close(f.stop); return; }
    assert(rc==0 && s && las_status(s)==LAS_NEW); cur=s;
    rc=las_reset(s); assert(las_reset(s)==-1 && las_begin(s)==-1 && las_poll(s)==-1);
    assert(kills==0 && stops==0);
    struct las_receipt r;
    if (want==R_RESET) {
        if (rc!=1) fprintf(stderr,"not reset (fault %s nth %d variant %d reason %d)\n",fault,nth,variant,las_reason(s));
        assert(rc==1 && las_status(s)==LAS_RESET && las_receipt(s,&r)==0 && r.job==0 && !strcmp(r.invocation,INV));
        int gone=reset_gone || (!strcmp(fault,"ByInvocation-missing") && nth==3);
        if (strcmp(r.state,gone ? "collected":"inactive")) fprintf(stderr,"receipt %s (fault %s nth %d)\n",r.state,fault,nth);
        assert(!strcmp(r.state,gone ? "collected":"inactive") && resets_sent==1);
        journal_is(f.stop,gone ? RESETL DONEGCL:RESETL DONEL);
    } else {
        assert(rc==-1 && las_status(s)==LAS_UNCERTAIN && las_receipt(s,&r)==-1);
        assert(resets_sent==(want>=R_SENT));
        journal_is(f.stop,want==R_NOTHING ? "":want==R_DONE_LINE ? RESETL DONEL:RESETL);
    }
    reason_is(s,why); finish(s,f);
}
static const char *const RESET_TRACE=
    "GetNameOwner;GetConnectionUnixUser;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;fsync;"
    "GetNameOwner;GetConnectionUnixUser;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;"
    "ResetFailed;GetUnitByInvocationID;GetUnitByInvocationID;Get:Id;Get:InvocationID;Get:ControlGroup;Get:ActiveState;Get:Job;"
    "GetNameOwner;GetConnectionUnixUser;fsync;";
static void test_reset_success(void) {
    stopped_unit(NULL,0,0); r_standard(R_RESET,LAS_R_NONE);
    if (strcmp(trace,RESET_TRACE)) { fprintf(stderr,"reset trace mismatch:\n%s\n",trace); assert(0); }
    /* rechecks: open, entry, after RESET, after readback, after RESET-DONE; absence: open, entry, after RESET */
    assert(count("exclusive")==5 && count("absent")==3 && count("GetNameOwner")==3 && count("peer")==3 && synced==2);
    /* garbage-collected right after the reset: the invocation is gone */
    stopped_unit(NULL,0,0); reset_gone=1; r_standard(R_RESET,LAS_R_NONE);
    assert(strstr(trace,"ResetFailed;GetUnitByInvocationID;GetNameOwner;GetConnectionUnixUser;fsync;"));
    /* inactive (not failed) before, and a still-reported cgroup, are stopped too */
    stopped_unit(NULL,0,0); after_state="inactive"; r_standard(R_RESET,LAS_R_NONE);
    stopped_unit(NULL,0,0); after_cgroup=CGROUP; r_standard(R_RESET,LAS_R_NONE);
}
static void test_reset_gates(void) {
    /* authority: open, entry, after RESET (not sent), after readback (sent), after RESET-DONE */
    static const enum r_outcome excl[]={R_OPEN,R_NOTHING,R_INTENT,R_SENT,R_DONE_LINE,R_RESET};
    for (int n=1;n<=6;n++) { stopped_unit("exclusive",n,0); r_standard(excl[n-1],n==6 ? LAS_R_NONE:LAS_R_AUTHORITY); }
    /* absence receipt: open, entry, immediately before the call */
    static const enum r_outcome abs_[]={R_OPEN,R_NOTHING,R_INTENT,R_RESET};
    for (int n=1;n<=4;n++) { stopped_unit("absent",n,0); r_standard(abs_[n-1],n==4 ? LAS_R_NONE:LAS_R_ABSENCE); }
    /* owner bracket: before RESET, before the call, after the readback */
    static const char *const facets[]={"peer","busid","GetNameOwner","GetConnectionUnixUser","GetNameOwner-trailing","GetConnectionUnixUser-trailing"};
    static const enum r_outcome own[]={R_NOTHING,R_INTENT,R_SENT,R_RESET};
    for (size_t k=0;k<6;k++) for (int n=1;n<=4;n++) { stopped_unit(facets[k],n,0); r_standard(own[n-1],n==4 ? LAS_R_NONE:LAS_R_OWNER); }
    /* never without a gate */
    stopped_unit(NULL,0,0); struct fds f=journals(); struct las_config c=config(f); struct las *s=(struct las *)1;
    assert(las_reset_open(&c,NULL,&absence_token,&s)==-1 && !s); assert(las_reset_open(&c,absence_gate,&absence_token,NULL)==-1);
    close(f.create); close(f.stop);
}
/* The exact stopped incarnation, checked before RESET (1) and immediately
 * before the call (2); post-call readback (3: first lookup, 4: verify). */
static void test_reset_incarnation(void) {
    static const struct { const char *site; int v; enum las_reason why; } t[]={
        {"ByInvocation-missing",0,LAS_R_REPLACED}, {"ByInvocation-error",0,LAS_R_QUERY},
        {"ByInvocation",1,LAS_R_REPLACED}, {"ByInvocation",2,LAS_R_REPLACED}, {"ByInvocation",3,LAS_R_QUERY},
        {"prop:Id",1,LAS_R_REPLACED}, {"prop:InvocationID",1,LAS_R_QUERY}, {"prop:InvocationID",2,LAS_R_REPLACED},
        {"prop:ControlGroup",1,LAS_R_REPLACED}, {"prop:ControlGroup",2,LAS_R_NONE}, {"prop:ControlGroup",3,LAS_R_NONE},
        {"prop:ControlGroup",4,LAS_R_QUERY},
        {"prop:ActiveState",1,LAS_R_STATE}, {"prop:ActiveState",2,LAS_R_STATE}, {"prop:ActiveState",3,LAS_R_NONE},
        {"prop:ActiveState",4,LAS_R_STATE},
        {"prop:Job",1,LAS_R_JOB}, {"prop:Job",2,LAS_R_JOB}, {"prop:Job",3,LAS_R_JOB},
    };
    for (size_t i=0;i<sizeof t/sizeof *t;i++) for (int n=1;n<=2;n++) {
        stopped_unit(t[i].site,n,t[i].v);
        if (t[i].why==LAS_R_NONE) r_standard(R_RESET,LAS_R_NONE); else r_standard(n==1 ? R_NOTHING:R_INTENT,t[i].why);
    }
    static const char *const keys[]={"Id","InvocationID","ControlGroup","ActiveState","Job"};
    for (size_t k=0;k<5;k++) for (int n=1;n<=3;n++) {
        static const enum r_outcome at[]={R_NOTHING,R_INTENT,R_SENT};
        char site[96];
        snprintf(site,sizeof site,"trail:%s",keys[k]); stopped_unit(site,n,0); r_standard(at[n-1],LAS_R_QUERY);
        snprintf(site,sizeof site,"fail:%s",keys[k]); stopped_unit(site,n,0); r_standard(at[n-1],LAS_R_QUERY);
    }
    /* post-call readback: the reply is not the outcome; this invocation must be
     * gone or exactly ours and inactive */
    stopped_unit("ByInvocation-missing",3,0); r_standard(R_RESET,LAS_R_NONE); /* gone at once = collected */
    stopped_unit("ByInvocation-missing",4,0); r_standard(R_SENT,LAS_R_REPLACED); /* gone between lookups */
    stopped_unit("ByInvocation-error",3,0); r_standard(R_SENT,LAS_R_QUERY);
    stopped_unit("ByInvocation",3,1); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("ByInvocation",3,2); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("ByInvocation",3,3); r_standard(R_SENT,LAS_R_QUERY);
    stopped_unit("ByInvocation",4,1); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("prop:Id",3,1); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("prop:InvocationID",3,2); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("prop:ControlGroup",3,1); r_standard(R_SENT,LAS_R_REPLACED);
    stopped_unit("prop:ActiveState",3,1); r_standard(R_SENT,LAS_R_STATE);
    stopped_unit("prop:ActiveState",3,2); r_standard(R_SENT,LAS_R_STATE);
    stopped_unit("prop:Job",3,1); r_standard(R_SENT,LAS_R_JOB);
    stopped_unit(NULL,0,0); reset_noop=1; r_standard(R_SENT,LAS_R_STATE); /* still failed after the reply */
    /* an active (not stopped) unit is never reset */
    reset(NULL,0,0); r_standard(R_NOTHING,LAS_R_STATE);
}
static void test_reset_faults(void) {
    static const struct { const char *f; int n; enum r_outcome o; enum las_reason r; } t[]={
        {"new",1,R_NOTHING,LAS_R_BUS}, {"start",1,R_NOTHING,LAS_R_BUS}, {"clock",1,R_NOTHING,LAS_R_DEADLINE},
        {"fsync",1,R_INTENT,LAS_R_JOURNAL}, {"fsync",2,R_DONE_LINE,LAS_R_JOURNAL},
        {"ResetFailed",1,R_SENT,LAS_R_RESET}, {"ResetFailed-trailing",1,R_SENT,LAS_R_RESET},
        {"ResetFailed-replaced",1,R_SENT,LAS_R_REPLACED}, /* replacement at the call: path no longer resolves */
        {"slow:ResetFailed",1,R_SENT,LAS_R_DEADLINE},
        {"slow:Job",2,R_INTENT,LAS_R_DEADLINE},
        {"slow:GetConnectionUnixUser",3,R_SENT,LAS_R_DEADLINE}, /* last call: only the post-readback check sees it */
    };
    for (size_t i=0;i<sizeof t/sizeof *t;i++) { stopped_unit(t[i].f,t[i].n,0); r_standard(t[i].o,t[i].r); }
    stopped_unit("slow:GetConnectionUnixUser",3,0); slow_to_deadline=1; r_standard(R_SENT,LAS_R_DEADLINE);
    /* failed RESET fsync: the record is never reusable */
    stopped_unit("fsync",1,0); struct fds f=journals(); struct las *s=reset_opened(f);
    assert(las_reset(s)==-1 && resets_sent==0); reason_is(s,LAS_R_JOURNAL); journal_is(f.stop,RESETL); las_close(s); cur=NULL;
    { struct las_config c=config(f); struct las *again=NULL; assert(las_reset_open(&c,absence_gate,&absence_token,&again)==-1 && !again); }
    create_intact(); close(f.create); close(f.stop);
    /* a clock failure at ANY read is DEADLINE, never RESET */
    stopped_unit(NULL,0,0); r_standard(R_RESET,LAS_R_NONE); int total=count("clock"); assert(total>10);
    for (int n=1;n<=total;n++) {
        stopped_unit("clock",n,0); f=journals(); s=reset_opened(f);
        assert(las_reset(s)==-1 && las_status(s)==LAS_UNCERTAIN); reason_is(s,LAS_R_DEADLINE); finish(s,f);
    }
    /* create journal changed / reset record written between open and reset: nothing attempted */
    stopped_unit(NULL,0,0); f=journals(); s=reset_opened(f);
    { int fd=open(create_path,O_WRONLY|O_APPEND|O_CLOEXEC); assert(fd>=0 && write(fd,"x",1)==1); close(fd); }
    assert(las_reset(s)==-1 && !bus_live && resets_sent==0); reason_is(s,LAS_R_CREATE); journal_is(f.stop,""); las_close(s); cur=NULL;
    rewrite(CREATE_JOURNAL); close(f.create); close(f.stop);
    stopped_unit(NULL,0,0); f=journals(); s=reset_opened(f); assert(write(f.stop,"x",1)==1);
    assert(las_reset(s)==-1 && resets_sent==0); reason_is(s,LAS_R_JOURNAL); journal_is(f.stop,"x"); las_close(s); cur=NULL;
    close(f.create); close(f.stop);
}
/* create journal changed after the durable RESET line (3rd exclusive call):
 * the pre-call check refuses, ResetFailed is never sent */
static void test_reset_create_changed(void) {
    stopped_unit(NULL,0,0); struct fds f=journals(); struct las_config c=config(f); c.exclusive=authority_mutating; struct las *s=NULL;
    mutate_on=1; assert(las_reset_open(&c,absence_gate,&absence_token,&s)==0); cur=s;
    assert(las_reset(s)==-1 && resets_sent==0); mutate_on=0; reason_is(s,LAS_R_CREATE); journal_is(f.stop,RESETL);
    las_close(s); cur=NULL; rewrite(CREATE_JOURNAL); close(f.create); close(f.stop);
}
static void test_reset_api(void) {
    /* a stop handle never resets; a reset handle never stops/kills */
    stopped_unit(NULL,0,0); struct fds f=journals(); struct las *s=opened(f);
    assert(las_reset(s)==-1 && las_status(s)==LAS_NEW && resets_sent==0); finish(s,f);
    stopped_unit(NULL,0,0); f=journals(); s=reset_opened(f);
    assert(las_begin(s)==-1 && las_status(s)==LAS_NEW && !bus_live && kills==0);
    assert(las_fd(s)==-1 && las_poll(s)==-1);
    assert(las_reset(s)==1 && las_fd(s)==-1 && las_events(s)==-1 && las_poll(s)==-1 && las_reset(s)==-1);
    finish(s,f);
    assert(las_reset(NULL)==-1);
}
static void setup(void) {
    assert(lsc_test_journal_uid==0 && lsc_test_create_uid==0); /* the fixture defaults match the production pins */
    assert(getcwd(scratch,sizeof scratch-32)); strcat(scratch,"/fixture-stop-XXXXXX"); assert(mkdtemp(scratch)); assert(chmod(scratch,0700)==0);
    lsc_test_journal_uid=lsc_test_create_uid=getuid();
    memset(long_text,'a',sizeof long_text-1);
    char out[200]; assert(object_path(INV,out,sizeof out) && !strcmp(out,INV_PATH));
    /* the live format of GetUnitByInvocationID on systemd 259 (host-probe) */
    assert(object_path("067be8db4fdd4b38bec02aac600edbfd",out,sizeof out) && !strcmp(out,"/org/freedesktop/systemd1/unit/_3067be8db4fdd4b38bec02aac600edbfd"));
}
static void teardown(void) { (void)unlink(create_path); (void)unlink(stop_path); assert(rmdir(scratch)==0); }
int main(void) {
    setup();
    void (*tests[])(void)={test_open,test_success,test_authority_and_owner,test_incarnation,test_begin_faults,test_events,test_dispatch,test_api,test_create_changed_before_kill,
        test_reset_success,test_reset_gates,test_reset_incarnation,test_reset_faults,test_reset_api,test_reset_create_changed};
    for (size_t i=0;i<sizeof tests/sizeof *tests;i++) tests[i]();
    teardown();
    puts("stop: fake-bus incarnation, authority/owner sweeps, journal, event, dispatch and budget tests passed");
    puts("reset: post-absence ResetFailed gates, incarnation, readback, faults and API tests passed");
    return 0;
}
