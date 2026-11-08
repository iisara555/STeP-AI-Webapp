#define _GNU_SOURCE
#define LSC_TESTING 1
#define LSC_FIXTURE_INCLUDE 1
#define fsync fixture_fsync
#define getsockopt fixture_getsockopt
#define clock_gettime fixture_clock_gettime
#include "create.c"
#undef fsync
#undef getsockopt
#undef clock_gettime
extern int fsync(int);
#include <assert.h>
#include <stdarg.h>
#include <sys/stat.h>
/* Fake bus. No real bus symbols are linked. Every request argument is asserted;
 * replies and signals are typed token streams with sd-bus cursor semantics
 * (strict exit_container, variant-entered property replies); incoming traffic
 * is a FIFO delivered only through sd_bus_process, one message per call. */
#define UNIT "step-lc-11111111111111111111111111111111-0000000000000001.service"
#define UNIT_PATH "/org/freedesktop/systemd1/unit/step_2dlc_2d11111111111111111111111111111111_2d0000000000000001_2eservice"
#define CGROUP "/system.slice/" UNIT
#define RULE "type='signal',sender=':1.42',path='/org/freedesktop/systemd1',interface='org.freedesktop.systemd1.Manager',member='JobRemoved',arg2='" UNIT "'"
#define JOB7 "/org/freedesktop/systemd1/job/7"
#define EPOCH "11111111111111111111111111111111"
#define UUID "11111111-1111-1111-1111-111111111111"
#define INTENT "INTENT v1 1 1000 " EPOCH " " UUID " " UUID " " UUID " 22222222222222222222222222222222 " UNIT " " EPOCH " :1.42\n"
#define JOBLINE "JOB 7 " JOB7 "\n"
#define ANCHOR "ANCHOR 7 01000000000000000000000000000000 " CGROUP "\n"
enum { REQ=1, REPLY, SIGNAL, PROP };
struct tok { char k, ct; const char *sig, *str; uint64_t n; const void *p; size_t len; };
struct sd_bus { int unused; };
struct sd_bus_slot { int alive; };
/* room for the oversized SystemCallFilter reply (1100 names + framing) */
#define MSG_TOKENS 1200
struct sd_bus_message { int refs, kind, error, depth; size_t n, pos; struct tok t[MSG_TOKENS]; const char *sender; };
static struct sd_bus bus;
static struct sd_bus_slot call_slot, match_slot;
static struct sd_bus_message pool[512];
static sd_bus_message_handler_t method_cb, signal_cb;
static void *method_ctx, *signal_ctx;
static int sent, synced, bus_live, bus_events, timeout_fail, process_fail, bypass_arg2, endless, reply_delivered, variant, nth;
static uint64_t clock_us, bus_timeout;
static unsigned process_calls;
static char fault[96], trace[32768], scratch[512]; static size_t trace_n;
static int auth_token;
static struct { char site[96]; int n; } counts[256]; static size_t ncounts;
static sd_bus_message *queue[256]; static size_t qh, qt;
static int hit(const char *site) {
    size_t i=0; for (;i<ncounts && strcmp(counts[i].site,site);i++) {}
    if (i==ncounts) { assert(ncounts<256 && strlen(site)<96); strcpy(counts[ncounts++].site,site); counts[i].n=0; }
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
static void strv_(sd_bus_message *m,const char *const *v,size_t n) { open_(m,'a',"s"); for (size_t i=0;i<n;i++) put_s(m,'s',v[i]); close_(m); }
/* --- sd-bus cursor semantics --- */
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
        else if (*p=='b') *va_arg(a,int *)=(int)t->n;
        else if (*p=='u') *va_arg(a,uint32_t *)=(uint32_t)t->n;
        else if (*p=='i') *va_arg(a,int32_t *)=(int32_t)t->n;
        else if (*p=='t') *va_arg(a,uint64_t *)=t->n;
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
int sd_bus_message_enter_container(sd_bus_message *m,char type,const char *contents) {
    assert(m && m->kind!=REQ && contents);
    if (m->pos>=m->n || m->t[m->pos].k=='>') return 0;
    struct tok *t=&m->t[m->pos];
    if (t->k!='<' || t->ct!=type || strcmp(t->sig,contents)) return -ENXIO;
    m->pos++; m->depth++; return 1;
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
int fixture_fsync(int fd) { if (hit("fsync")) { errno=EIO; return -1; } synced++; return fsync(fd); }
int sd_bus_new(sd_bus **b) { assert(!bus_live); if (hit("new")) return -ENOMEM; *b=&bus; bus_live=1; return 0; }
int sd_bus_set_address(sd_bus *b,const char *a) { assert(b==&bus && !strcmp(a,"unix:path=/run/dbus/system_bus_socket")); return 0; }
int sd_bus_set_bus_client(sd_bus *b,int x) { assert(b==&bus && x==1); return 0; }
int sd_bus_start(sd_bus *b) { assert(b==&bus); return hit("start") ? -ECONNREFUSED:0; }
int sd_bus_get_bus_id(sd_bus *b,sd_id128_t *id) { assert(b==&bus); memset(id->bytes,hit("busid") ? 0x12:0x11,16); return 0; }
static uint64_t call_timeout_max, call_timeout_calls;
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t t) {
    assert(b==&bus && t>0 && t<=2000000);
    call_timeout_calls++; if (call_timeout_calls>1 && t>call_timeout_max) call_timeout_max=t; return 0;
}
sd_bus *sd_bus_unref(sd_bus *b) { if (b) { assert(b==&bus && bus_live); bus_live=0; } return NULL; }
sd_bus_slot *sd_bus_slot_unref(sd_bus_slot *s) { if (s) { assert(s==&call_slot || s==&match_slot); s->alive=0; } return NULL; }
/* --- request serialization --- */
int sd_bus_message_new_method_call(sd_bus *b,sd_bus_message **m,const char *dest,const char *path,const char *iface,const char *member) {
    assert(b==&bus && !strcmp(dest,":1.42") && !strcmp(path,"/org/freedesktop/systemd1") && !strcmp(iface,"org.freedesktop.systemd1.Manager") && !strcmp(member,"StartTransientUnit"));
    *m=msg(REQ); return 0;
}
int sd_bus_message_open_container(sd_bus_message *m,char t,const char *s) { assert(m->kind==REQ); record("<%c:%s>",t,s); return 0; }
int sd_bus_message_close_container(sd_bus_message *m) { assert(m->kind==REQ); record("</>"); return 0; }
int sd_bus_message_append(sd_bus_message *m,const char *types,...) {
    assert(m->kind==REQ); va_list a; va_start(a,types); record("[%s:",types);
    for (const char *p=types;*p;p++) {
        if (*p=='s') record("%s;",va_arg(a,const char *));
        else if (*p=='b' || *p=='i') record("%d;",va_arg(a,int));
        else if (*p=='u') record("%u;",va_arg(a,unsigned));
        else if (*p=='t') record("%llu;",(unsigned long long)va_arg(a,uint64_t));
        else assert(0);
    }
    record("]"); va_end(a); return 0;
}
int sd_bus_message_append_array(sd_bus_message *m,char type,const void *p,size_t n) {
    assert(m->kind==REQ && type=='y'); record("[ay:");
    for (size_t i=0;i<n;i++) record("%02x",((const unsigned char *)p)[i]);
    record("]"); return 0;
}
int sd_bus_call_async(sd_bus *b,sd_bus_slot **s,sd_bus_message *m,sd_bus_message_handler_t cb,void *ctx,uint64_t timeout) {
    assert(b==&bus && m && m->kind==REQ && m->refs==1 && timeout==2000000 && cb && ctx);
    char buf[2048]={0}; assert(pread(((struct lsc *)ctx)->fd,buf,sizeof buf-1,0)>0 && !strcmp(buf,INTENT) && synced>0);
    sent++; if (hit("async")) return -EIO;
    call_slot.alive=1; *s=&call_slot; method_cb=cb; method_ctx=ctx; return 0;
}
int sd_bus_add_match(sd_bus *b,sd_bus_slot **s,const char *rule,sd_bus_message_handler_t cb,void *ctx) {
    assert(b==&bus && !strcmp(rule,RULE) && cb && ctx);
    if (hit("match")) return -ENOMEM;
    match_slot.alive=1; *s=&match_slot; signal_cb=cb; signal_ctx=ctx; return 0;
}
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *member,sd_bus_error *e,sd_bus_message **out,const char *types,...) {
    assert(b==&bus && !e && out); va_list a; va_start(a,types); sd_bus_message *r=NULL; int rc=1;
    if (!strcmp(member,"GetNameOwner") || !strcmp(member,"GetConnectionUnixUser")) {
        assert(!strcmp(dest,"org.freedesktop.DBus") && !strcmp(path,"/org/freedesktop/DBus") && !strcmp(iface,"org.freedesktop.DBus") && !strcmp(types,"s"));
        const char *arg=va_arg(a,const char *); r=msg(REPLY);
        if (member[3]=='N') { assert(!strcmp(arg,"org.freedesktop.systemd1")); put_s(r,'s',hit("GetNameOwner") ? ":1.99":":1.42"); }
        else { assert(!strcmp(arg,":1.42")); if (hit("slow:GetConnectionUnixUser")) clock_us+=6000000; put_n(r,'u',hit("GetConnectionUnixUser") ? 1000:0); }
    } else {
        assert(!strcmp(dest,":1.42") && !strcmp(path,"/org/freedesktop/systemd1") && !strcmp(iface,"org.freedesktop.systemd1.Manager"));
        if (!strcmp(member,"Subscribe")) {
            assert(!strcmp(types,"")); if (hit("Subscribe")) rc=-EACCES; else { r=msg(REPLY); if (hit("Subscribe-trailing")) put_s(r,'s',"x"); }
        } else {
            assert(!strcmp(member,"GetUnit") && !strcmp(types,"s") && !strcmp(va_arg(a,const char *),UNIT)); r=msg(REPLY);
            int v=hit("GetUnit") ? variant:0;
            put_s(r,'o',v==1 ? "/org/freedesktop/systemd1/unitstep_2dlc_2d11111111111111111111111111111111_2d0000000000000001_2eservice":
                        v==2 ? "/org/freedesktop/systemd1/unit/other_2eservice":UNIT_PATH);
            if (v==3) put_s(r,'s',"x");
        }
    }
    va_end(a); *out=r; return rc;
}
/* --- effective properties (independent literal view of systemd) --- */
static const unsigned char zero16[16], inv_ok[16]={1}, ten[4]={10};
static void b_exec(sd_bus_message *m,int v) {
    open_(m,'a',"(sasbttttuii)");
    for (int e=0;e<(v==4 ? 2:1);e++) {
        static const char *const one[]={"/usr/libexec/step-container-keeper"}, *const two[]={"/usr/libexec/step-container-keeper","-x"};
        open_(m,'r',"sasbttttuii"); put_s(m,'s',v==1 ? "/bin/sh":"/usr/libexec/step-container-keeper"); strv_(m,v==2 ? two:one,v==2 ? 2:1);
        put_n(m,'b',v==3); for (int k=1;k<=4;k++) put_n(m,'t',(uint64_t)k);
        put_n(m,'u',4242); put_n(m,'i',0); put_n(m,'i',0); close_(m);
    }
    close_(m);
}
static void entry(sd_bus_message *m,int family,const void *addr,size_t len,uint64_t prefix) {
    open_(m,'r',"iayu"); put_n(m,'i',(uint64_t)family); put_y(m,addr,len); put_n(m,'u',prefix); close_(m);
}
static void b_deny(sd_bus_message *m,int v) {
    open_(m,'a',"(iayu)");
    entry(m,AF_INET,v==3 ? ten:zero16,4,v==2 ? 8:0);
    if (v==4) entry(m,AF_INET,zero16,4,0);
    else if (v!=1) entry(m,AF_INET6,zero16,16,0);
    if (v==5) entry(m,AF_INET6,zero16,16,0);
    close_(m);
}
static void b_families(sd_bus_message *m,int v) { static const char *const unix_[]={"AF_UNIX"}; open_(m,'r',"bas"); put_n(m,'b',v!=1); strv_(m,unix_,v==2 ? 1:0); close_(m); }
static void b_filter(sd_bus_message *m,int v) {
    static const char *const ok[]={"close","execve","exit_group","pause","read"}, *const nopause[]={"close","execve","read"}, *const sock[]={"pause","socket"};
    open_(m,'r',"bas"); put_n(m,'b',v!=1);
    static const char *big[1100];
    if (v==5) { for (size_t i=0;i<1100;i++) big[i]=i==7 ? "pause":"read"; strv_(m,big,1100); }
    else if (v==2) strv_(m,nopause,3); else if (v==3) strv_(m,sock,2); else if (v==4) strv_(m,NULL,0); else strv_(m,ok,5);
    close_(m);
}
static void b_archs(sd_bus_message *m,int v) { static const char *const n[]={"native","x32"}, *const x[]={"x86-64"}; strv_(m,v==1 ? x:n,v==3 ? 0:v==2 ? 2:1); }
static void b_dropins(sd_bus_message *m,int v) { static const char *const d[]={"/etc/systemd/system/service.d/10-x.conf"}; strv_(m,d,v ? 1:0); }
static void b_invocation(sd_bus_message *m,int v) { put_y(m,v==2 ? zero16:inv_ok,v==1 ? 15:16); }
static void b_job(sd_bus_message *m,int v) { open_(m,'r',"uo"); put_n(m,'u',v ? 9:0); put_s(m,'o',v ? "/org/freedesktop/systemd1/job/9":"/"); close_(m); }
#define U "org.freedesktop.systemd1.Unit"
#define S "org.freedesktop.systemd1.Service"
struct fprop { const char *iface, *name, *sig; const char *s; uint64_t n; int nvar; void (*build)(sd_bus_message *,int); int queried; };
static struct fprop props[]={
    {U,"ActiveState","s","active",0,1,NULL,0}, {U,"SubState","s","running",0,1,NULL,0}, {U,"Transient","b",NULL,1,1,NULL,0},
    {U,"CollectMode","s","inactive",0,1,NULL,0}, {U,"DropInPaths","as",NULL,0,1,b_dropins,0},
    {U,"InvocationID","ay",NULL,0,2,b_invocation,0}, {U,"Job","(uo)",NULL,0,1,b_job,0},
    {S,"Type","s","exec",0,1,NULL,0}, {S,"Restart","s","no",0,1,NULL,0}, {S,"Delegate","b",NULL,0,1,NULL,0},
    {S,"KillMode","s","control-group",0,1,NULL,0}, {S,"OOMPolicy","s","kill",0,1,NULL,0},
    {S,"MemoryMax","t",NULL,536870912,1,NULL,0}, {S,"MemorySwapMax","t",NULL,0,1,NULL,0}, {S,"TasksMax","t",NULL,64,1,NULL,0},
    {S,"CPUQuotaPerSecUSec","t",NULL,1000000,1,NULL,0}, {S,"NoNewPrivileges","b",NULL,1,1,NULL,0},
    {S,"User","s","root",0,1,NULL,0}, {S,"Group","s","root",0,1,NULL,0},
    {S,"StandardInput","s","null",0,1,NULL,0}, {S,"StandardOutput","s","null",0,1,NULL,0}, {S,"StandardError","s","null",0,1,NULL,0},
    {S,"CapabilityBoundingSet","t",NULL,0,1,NULL,0}, {S,"AmbientCapabilities","t",NULL,0,1,NULL,0},
    {S,"PrivateNetwork","b",NULL,1,1,NULL,0}, {S,"PrivateTmp","b",NULL,1,1,NULL,0}, {S,"PrivateDevices","b",NULL,1,1,NULL,0},
    {S,"PrivateIPC","b",NULL,1,1,NULL,0}, {S,"ProtectSystem","s","strict",0,1,NULL,0}, {S,"ProtectHome","s","yes",0,1,NULL,0},
    {S,"ProtectProc","s","invisible",0,1,NULL,0}, {S,"ProcSubset","s","pid",0,1,NULL,0},
    {S,"ProtectKernelTunables","b",NULL,1,1,NULL,0}, {S,"ProtectKernelModules","b",NULL,1,1,NULL,0}, {S,"ProtectKernelLogs","b",NULL,1,1,NULL,0},
    {S,"ProtectControlGroups","b",NULL,1,1,NULL,0}, {S,"ProtectClock","b",NULL,1,1,NULL,0}, {S,"ProtectHostname","b",NULL,1,1,NULL,0},
    {S,"RestrictNamespaces","t",NULL,0,1,NULL,0}, {S,"LockPersonality","b",NULL,1,1,NULL,0}, {S,"MemoryDenyWriteExecute","b",NULL,1,1,NULL,0},
    {S,"RestrictSUIDSGID","b",NULL,1,1,NULL,0}, {S,"RestrictRealtime","b",NULL,1,1,NULL,0}, {S,"UMask","u",NULL,63,1,NULL,0},
    {S,"LimitNOFILE","t",NULL,64,1,NULL,0}, {S,"LimitNOFILESoft","t",NULL,64,1,NULL,0}, {S,"MainPID","u",NULL,4242,2,NULL,0},
    {S,"ControlGroup","s",CGROUP,0,1,NULL,0}, {S,"ExecStart","a(sasbttttuii)",NULL,0,4,b_exec,0},
    {S,"IPAddressDeny","a(iayu)",NULL,0,5,b_deny,0}, {S,"RestrictAddressFamilies","(bas)",NULL,0,2,b_families,0},
    {S,"SystemCallFilter","(bas)",NULL,0,5,b_filter,0}, {S,"SystemCallArchitectures","as",NULL,0,3,b_archs,0},
};
#define NPROPS (sizeof props/sizeof *props)
int sd_bus_get_property(sd_bus *b,const char *dest,const char *path,const char *iface,const char *key,sd_bus_error *e,sd_bus_message **out,const char *type) {
    assert(b==&bus && !e && out && !strcmp(dest,":1.42") && !strcmp(path,UNIT_PATH));
    struct fprop *f=NULL; for (size_t i=0;i<NPROPS;i++) if (!strcmp(props[i].iface,iface) && !strcmp(props[i].name,key)) f=&props[i];
    assert(f && !strcmp(type,f->sig)); f->queried++;
    char site[96];
    (void)snprintf(site,sizeof site,"slow:%s",key); if (hit(site)) clock_us+=6000000;
    (void)snprintf(site,sizeof site,"fail:%s",key); if (hit(site)) return -EIO;
    (void)snprintf(site,sizeof site,"prop:%s",key); int v=hit(site) ? variant:0;
    sd_bus_message *m=msg(PROP); open_(m,'v',f->sig);
    if (f->build) f->build(m,v);
    else if (*f->sig=='s') put_s(m,'s',v ? "x-wrong":f->s);
    else if (!strcmp(key,"MainPID")) put_n(m,'u',v==1 ? 0:v==2 ? 1:f->n);
    else put_n(m,*f->sig,*f->sig=='b' ? (uint64_t)(v ? !f->n:f->n):f->n+(uint64_t)v);
    close_(m);
    (void)snprintf(site,sizeof site,"trail:%s",key); if (hit(site)) put_s(m,'s',"x");
    m->pos=1; m->depth=1; *out=m; return 1;
}
/* --- incoming FIFO, dispatched only by sd_bus_process --- */
static void enqueue(sd_bus_message *m) { assert(qt<sizeof queue/sizeof *queue); queue[qt++]=m; }
static void q_reply(const char *path,int error,int trailing) {
    sd_bus_message *m=msg(REPLY); m->error=error; if (!error) put_s(m,'o',path); if (trailing) put_s(m,'s',"x"); enqueue(m);
}
static void q_signal(const char *sender,unsigned job,const char *path,const char *unit,const char *result) {
    sd_bus_message *m=msg(SIGNAL); m->sender=sender; put_n(m,'u',job); put_s(m,'o',path); put_s(m,'s',unit); put_s(m,'s',result); enqueue(m);
}
static void q_event(void) { q_signal(":1.42",7,JOB7,UNIT,"done"); }
int sd_bus_process(sd_bus *b,sd_bus_message **r) {
    assert(b==&bus && bus_live && !r); process_calls++; assert(process_calls<100000);
    if (process_fail) return -EIO;
    if (endless && qh==qt) { qh=qt=0; q_signal(":1.42",99,"/org/freedesktop/systemd1/job/99","other.service","done"); clock_us+=100000; }
    if (qh==qt) return 0;
    sd_bus_message *m=queue[qh++];
    if (m->kind==REPLY) { if (call_slot.alive && !reply_delivered) { reply_delivered=1; method_cb(m,method_ctx,NULL); } }
    else if (match_slot.alive && !strcmp(m->sender,":1.42") && m->n>=3 && (bypass_arg2 || !strcmp(m->t[2].str,UNIT))) signal_cb(m,signal_ctx,NULL);
    m->pos=0; sd_bus_message_unref(m); return 1;
}
/* --- scenario plumbing --- */
static int authority(void *ctx,const struct lc_entry *e) { assert(ctx==&auth_token && e->slot==1 && e->state==LC_STARTING); return hit("exclusive") ? 0:1; }
static char last_path[600];
static int prop_queried(const char *name) {
    for (size_t i=0;i<NPROPS;i++) if (!strcmp(props[i].name,name)) return props[i].queried;
    assert(0); return -1;
}
static void reset(const char *f,int n,int v) {
    snprintf(fault,sizeof fault,"%s",f ? f:""); nth=n; variant=v; ncounts=0;
    sent=synced=bus_live=timeout_fail=process_fail=bypass_arg2=endless=reply_delivered=0; bus_events=1; bus_timeout=UINT64_MAX;
    clock_us=1000000; call_timeout_max=call_timeout_calls=0; process_calls=0; trace_n=0; trace[0]=0; qh=qt=0; call_slot.alive=match_slot.alive=0; method_cb=signal_cb=NULL;
    for (size_t i=0;i<NPROPS;i++) props[i].queried=0;
}
static int journal_file(int flags,const char *name) {
    snprintf(last_path,sizeof last_path,"%s/%s",scratch,name); (void)unlink(last_path);
    int fd=open(last_path,O_CREAT|O_EXCL|O_CLOEXEC|flags,0600); assert(fd>=0 && fchmod(fd,0600)==0); return fd;
}
static struct lsc_config config(int fd) {
    struct lsc_config c; memset(&c,0,sizeof c); c.journal_fd=fd; c.context=&auth_token; c.exclusive=authority;
    c.entry.slot=1; c.entry.principal=1000; c.entry.state=LC_STARTING;
    strcpy(c.entry.epoch,EPOCH); strcpy(c.entry.launch,"22222222222222222222222222222222");
    strcpy(c.entry.boot,UUID); strcpy(c.entry.user,UUID); strcpy(c.entry.workspace,UUID);
    strcpy(c.entry.container,"step-lc-" EPOCH "-0000000000000001"); strcpy(c.bus_id,EPOCH); strcpy(c.manager,":1.42");
    return c;
}
static void journal_is(int fd,const char *want) {
    char buf[4096]={0}; ssize_t n=pread(fd,buf,sizeof buf-1,0); assert(n>=0);
    if (strcmp(buf,want)) { fprintf(stderr,"journal mismatch (fault %s nth %d variant %d):\n%s\nwant:\n%s\n",fault,nth,variant,buf,want); assert(0); }
}
static void finish(struct lsc *s) { lsc_close(s); while (qh<qt) sd_bus_message_unref(queue[qh++]); assert(!bus_live && !call_slot.alive && !match_slot.alive && live()==0); }
enum outcome { O_OPEN, O_PRE, O_INTENT, O_POLL0, O_JOB, O_ANCHOR_LINE, O_ANCHORED };
/* Open, begin, reply+event, pump; assert the exact stage reached. */
static void standard(enum outcome want) {
    int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd); struct lsc *s=NULL;
    int rc=lsc_open(&c,&s);
    if (want==O_OPEN) { assert(rc==-1 && !s && sent==0); journal_is(fd,""); close(fd); return; }
    assert(rc==0 && s && lsc_status(s)==LSC_NEW);
    rc=lsc_begin(s); assert(lsc_begin(s)==-1);
    if (want==O_PRE || want==O_INTENT) {
        assert(rc==-1 && sent==0 && lsc_status(s)==LSC_UNCERTAIN && lsc_poll(s)==-1); journal_is(fd,want==O_PRE ? "":INTENT);
        finish(s); close(fd); return;
    }
    assert(rc==0 && sent==1 && lsc_status(s)==LSC_PENDING);
    q_reply(JOB7,0,0); q_event();
    for (int i=0;i<4 && lsc_status(s)==LSC_PENDING;i++) (void)lsc_poll(s);
    if (want==O_ANCHORED) {
        assert(lsc_status(s)==LSC_ANCHORED); struct lsc_receipt r; assert(lsc_receipt(s,&r)==0);
        assert(r.job==7 && !strcmp(r.invocation,"01000000000000000000000000000000") && !strcmp(r.cgroup,CGROUP));
        journal_is(fd,INTENT JOBLINE ANCHOR);
    } else {
        assert(lsc_status(s)==LSC_UNCERTAIN); struct lsc_receipt r; assert(lsc_receipt(s,&r)==-1);
        journal_is(fd,want==O_POLL0 ? INTENT:want==O_JOB ? INTENT JOBLINE:INTENT JOBLINE ANCHOR);
    }
    finish(s); close(fd);
}
static const char *const EXPECTED_TRACE=
#include "test-create.trace"
;
static void test_success(void) {
    reset(NULL,0,0); standard(O_ANCHORED);
    if (strcmp(trace,EXPECTED_TRACE)) { fprintf(stderr,"trace mismatch:\n%s\n",trace); assert(0); }
    for (size_t i=0;i<NPROPS;i++) { if (props[i].queried!=1) fprintf(stderr,"property %s queried %d\n",props[i].name,props[i].queried); assert(props[i].queried==1); }
    /* exact re-check counts: open, begin x2, poll, readback x2, post-ANCHOR */
    assert(count("exclusive")==7);
    assert(count("peer")==4 && count("busid")==4 && count("GetNameOwner")==4 && count("GetConnectionUnixUser")==4);
    assert(process_calls==3);
}
static void test_authority_and_owner(void) {
    static const enum outcome excl[]={O_OPEN,O_PRE,O_INTENT,O_POLL0,O_JOB,O_JOB,O_ANCHOR_LINE,O_ANCHORED};
    for (int n=1;n<=8;n++) { reset("exclusive",n,0); standard(excl[n-1]); }
    static const char *const facets[]={"peer","busid","GetNameOwner","GetConnectionUnixUser"};
    static const enum outcome own[]={O_PRE,O_INTENT,O_JOB,O_JOB,O_ANCHORED};
    for (size_t f=0;f<4;f++) for (int n=1;n<=5;n++) { reset(facets[f],n,0); standard(own[n-1]); }
}
static void test_begin_faults(void) {
    static const struct { const char *f; int n; enum outcome o; } t[]={
        {"new",1,O_PRE}, {"start",1,O_PRE}, {"match",1,O_PRE}, {"Subscribe",1,O_PRE}, {"Subscribe-trailing",1,O_PRE},
        {"fsync",1,O_PRE}, {"clock",1,O_INTENT}, {"fsync",2,O_JOB}, {"fsync",3,O_ANCHOR_LINE},
    };
    for (size_t i=0;i<sizeof t/sizeof *t;i++) {
        reset(t[i].f,t[i].n,0);
        if (!strcmp(t[i].f,"fsync") && t[i].n==1) { /* failed INTENT fsync still wrote bytes: never reopenable */
            int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd); struct lsc *s=NULL;
            assert(lsc_open(&c,&s)==0 && lsc_begin(s)==-1 && sent==0); journal_is(fd,INTENT); finish(s);
            struct lsc *again=NULL; assert(lsc_open(&c,&again)==-1 && !again); close(fd); continue;
        }
        standard(t[i].o);
    }
    /* async enqueue failure after durable INTENT: attempted once, uncertain */
    reset("async",1,0); int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd); struct lsc *s=NULL;
    assert(lsc_open(&c,&s)==0 && lsc_begin(s)==-1 && sent==1 && lsc_status(s)==LSC_UNCERTAIN); journal_is(fd,INTENT); finish(s); close(fd);
}
static struct lsc *pending(int fd) {
    struct lsc_config c=config(fd); struct lsc *s=NULL; assert(lsc_open(&c,&s)==0 && lsc_begin(s)==0 && lsc_status(s)==LSC_PENDING); return s;
}
static void expect(struct lsc *s,int fd,enum lsc_status st,const char *journal) { assert(lsc_status(s)==st); journal_is(fd,journal); finish(s); close(fd); }
static void test_dispatch(void) {
    /* flood of other-unit signals that bypass the bus arg2 filter: 32 per poll */
    reset(NULL,0,0); bypass_arg2=1; int fd=journal_file(O_RDWR,"j"); struct lsc *s=pending(fd);
    for (int i=0;i<40;i++) q_signal(":1.42",(unsigned)(100+i),"/org/freedesktop/systemd1/job/100","other.service","failed");
    q_reply(JOB7,0,0); q_event();
    assert(lsc_poll(s)==0 && process_calls==32 && lsc_status(s)==LSC_PENDING && qt-qh==10);
    assert(lsc_poll(s)==1 && process_calls==32+11); expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    /* same flood filtered by the bus still costs one dispatch each */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd);
    for (int i=0;i<40;i++) q_signal(":1.42",(unsigned)(100+i),"/org/freedesktop/systemd1/job/100","other.service","failed");
    q_reply(JOB7,0,0); q_event();
    assert(lsc_poll(s)==0 && process_calls==32); assert(lsc_poll(s)==1); expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    /* endless flood: bounded per poll, terminal at the deadline */
    reset(NULL,0,0); endless=1; fd=journal_file(O_RDWR,"j"); s=pending(fd);
    int polls=0; while (lsc_status(s)==LSC_PENDING) { assert(lsc_poll(s)<=0); polls++; assert(polls<100); }
    assert(polls>1); expect(s,fd,LSC_UNCERTAIN,INTENT);
    /* event before reply, one poll */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd); q_event(); q_reply(JOB7,0,0);
    assert(lsc_poll(s)==1); expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    /* event and reply in separate polls, both orders */
    for (int order=0;order<2;order++) {
        reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd);
        if (order) q_event(); else q_reply(JOB7,0,0);
        assert(lsc_poll(s)==0 && lsc_status(s)==LSC_PENDING && lsc_poll(s)==0);
        if (order) q_reply(JOB7,0,0); else q_event();
        assert(lsc_poll(s)==1); expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    }
    /* spoofed sender is dropped by the match; our real event still anchors */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd);
    q_signal(":1.99",7,JOB7,UNIT,"failed"); q_reply(JOB7,0,0); assert(lsc_poll(s)==0); q_event(); assert(lsc_poll(s)==1);
    expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    /* dispatch error */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd); process_fail=1; assert(lsc_poll(s)==-1); expect(s,fd,LSC_UNCERTAIN,INTENT);
    /* deadline: expired before dispatch (nothing dispatched), and during synchronous readback */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd); q_reply(JOB7,0,0); q_event(); clock_us+=5000000;
    assert(lsc_poll(s)==-1 && process_calls==0); expect(s,fd,LSC_UNCERTAIN,INTENT);
    reset("slow:Job",1,0); standard(O_JOB);
    /* the final owner() call of the readback is slow: only the post-readback deadline check sees it */
    reset("slow:GetConnectionUnixUser",4,0); standard(O_JOB);
    /* a slow Get mid-readback stops further blocking calls: nothing after it is queried */
    reset("slow:MainPID",1,0); fd=journal_file(O_RDWR,"j"); s=pending(fd); q_reply(JOB7,0,0); q_event();
    assert(lsc_poll(s)==-1 && prop_queried("DropInPaths")==0 && prop_queried("Job")==0); expect(s,fd,LSC_UNCERTAIN,INTENT JOBLINE);
    /* per-call timeout is capped at the time left: 300 ms left -> no call may wait longer */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd); q_reply(JOB7,0,0); q_event(); clock_us+=4700000;
    assert(lsc_poll(s)==1 && call_timeout_calls>50 && call_timeout_max==300000); expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    reset("clock",2,0); standard(O_POLL0);
    reset("clock",3,0); standard(O_JOB);
}
static void test_events(void) {
    static const struct { unsigned job; const char *path, *unit, *result; } bad[]={
        {8,"/org/freedesktop/systemd1/job/8",UNIT,"done"},   /* consistent event for another job of ours */
        {7,"/org/freedesktop/systemd1/job/8",UNIT,"done"},   /* id/path disagree */
        {7,JOB7,UNIT,"failed"}, {7,JOB7,UNIT,"canceled"}, {7,"/org/freedesktop/systemd1/job/07",UNIT,"done"},
    };
    for (size_t i=0;i<sizeof bad/sizeof *bad;i++) {
        reset(NULL,0,0); int fd=journal_file(O_RDWR,"j"); struct lsc *s=pending(fd);
        q_reply(JOB7,0,0); q_signal(":1.42",bad[i].job,bad[i].path,bad[i].unit,bad[i].result);
        assert(lsc_poll(s)==-1); expect(s,fd,LSC_UNCERTAIN,INTENT JOBLINE);
    }
    /* duplicate successful event */
    reset(NULL,0,0); int fd=journal_file(O_RDWR,"j"); struct lsc *s=pending(fd);
    q_reply(JOB7,0,0); q_event(); q_event(); assert(lsc_poll(s)==-1); expect(s,fd,LSC_UNCERTAIN,INTENT JOBLINE);
    /* other unit (bus filter bypassed) is ignored, then ours anchors */
    reset(NULL,0,0); bypass_arg2=1; fd=journal_file(O_RDWR,"j"); s=pending(fd);
    q_reply(JOB7,0,0); q_signal(":1.42",7,JOB7,"other.service","failed"); q_event(); assert(lsc_poll(s)==1);
    expect(s,fd,LSC_ANCHORED,INTENT JOBLINE ANCHOR);
    /* malformed signal body */
    reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd);
    { sd_bus_message *m=msg(SIGNAL); m->sender=":1.42"; put_n(m,'u',7); put_s(m,'o',JOB7); put_s(m,'s',UNIT); put_s(m,'s',"done"); put_s(m,'s',"x"); enqueue(m); }
    assert(lsc_poll(s)==-1); expect(s,fd,LSC_UNCERTAIN,INTENT);
    /* reply: method error, trailing argument, malformed job path */
    for (int k=0;k<3;k++) {
        reset(NULL,0,0); fd=journal_file(O_RDWR,"j"); s=pending(fd);
        q_reply(k==2 ? "/org/freedesktop/systemd1/job/0":JOB7,k==0,k==1); q_event();
        assert(lsc_poll(s)==-1); expect(s,fd,LSC_UNCERTAIN,INTENT);
    }
}
static void test_readback(void) {
    for (size_t i=0;i<NPROPS;i++) {
        char site[96];
        for (int v=1;v<=props[i].nvar;v++) { snprintf(site,sizeof site,"prop:%s",props[i].name); reset(site,1,v); standard(O_JOB); }
        snprintf(site,sizeof site,"trail:%s",props[i].name); reset(site,1,0); standard(O_JOB);
        snprintf(site,sizeof site,"fail:%s",props[i].name); reset(site,1,0); standard(O_JOB);
    }
    for (int v=1;v<=3;v++) { reset("GetUnit",1,v); standard(O_JOB); }
}
static void test_api(void) {
    reset(NULL,0,0); int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd); struct lsc *s=NULL; uint64_t us=1;
    assert(lsc_fd(NULL)==-1 && lsc_events(NULL)==-1 && lsc_timeout(NULL,&us)==-1);
    assert(lsc_open(&c,&s)==0 && lsc_fd(s)==-1 && lsc_events(s)==-1 && lsc_timeout(s,&us)==-1);
    assert(lsc_begin(s)==0 && lsc_fd(s)==42 && lsc_timeout(s,NULL)==-1);
    bus_events=5; assert(lsc_events(s)==5);
    assert(lsc_timeout(s,&us)==0 && us==5000000);           /* no bus timeout: attempt deadline */
    clock_us+=1500000; assert(lsc_timeout(s,&us)==0 && us==3500000);
    bus_timeout=clock_us+700; assert(lsc_timeout(s,&us)==0 && us==700);   /* earlier sd-bus timeout */
    bus_timeout=clock_us-1; assert(lsc_timeout(s,&us)==0 && us==0);
    bus_timeout=UINT64_MAX; clock_us+=4000000; assert(lsc_timeout(s,&us)==0 && us==0);
    timeout_fail=1; assert(lsc_timeout(s,&us)==-1); timeout_fail=0;
    clock_us-=4000000; q_reply(JOB7,0,0); q_event(); assert(lsc_poll(s)==1);
    assert(lsc_fd(s)==-1 && lsc_events(s)==-1 && lsc_timeout(s,&us)==-1);
    finish(s); close(fd);
}
static void test_names(void) {
    reset(NULL,0,0); int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd), bad; struct lsc *denied=NULL;
    static const char *names[]={":1.42'bad","1.42",":1",":1.",":.42",":1..42",":1.42.7",":1.4a",":1.42,x",":",":1.42 "};
    for (size_t k=0;k<sizeof names/sizeof *names;k++) { bad=c; strcpy(bad.manager,names[k]); assert(lsc_open(&bad,&denied)==-1 && !denied); }
    bad=c; strcpy(bad.entry.container,"arbitrary.service"); assert(lsc_open(&bad,&denied)==-1 && !denied);
    bad=c; bad.entry.state=LC_RUNNING; assert(lsc_open(&bad,&denied)==-1 && !denied);
    bad=c; strcpy(bad.entry.launch,"/bin/sh"); assert(lsc_open(&bad,&denied)==-1 && !denied);
    assert(sent==0 && count("exclusive")==0); close(fd);
    char out[200]; assert(unit_object_path("dbus.service",out,sizeof out) && !strcmp(out,"/org/freedesktop/systemd1/unit/dbus_2eservice"));
    assert(unit_object_path("1a-b",out,sizeof out) && !strcmp(out,"/org/freedesktop/systemd1/unit/_31a_2db"));
}
static void test_journal(void) {
    struct lsc *s=NULL, *t=NULL; struct lsc_config c;
    reset(NULL,0,0);
    static const int flags[]={O_WRONLY,O_RDONLY};
    for (int k=0;k<2;k++) { int fd=journal_file(flags[k],"j"); c=config(fd); assert(lsc_open(&c,&s)==-1 && !s); close(fd); }
    int fd=journal_file(O_RDWR,"j"); c=config(fd);
    assert(fchmod(fd,0640)==0 && lsc_open(&c,&s)==-1); assert(fchmod(fd,0660)==0 && lsc_open(&c,&s)==-1); assert(fchmod(fd,0600)==0);
    char second[600]; snprintf(second,sizeof second,"%s/j-link",scratch); (void)unlink(second);
    assert(link(last_path,second)==0 && lsc_open(&c,&s)==-1 && !s); assert(unlink(second)==0);   /* nlink 2 */
    lsc_test_journal_uid=getuid()+1; assert(lsc_open(&c,&s)==-1 && !s); lsc_test_journal_uid=getuid();     /* owner */
    assert(write(fd,"x",1)==1 && lsc_open(&c,&s)==-1 && !s); close(fd);                                   /* nonempty */
    fd=journal_file(O_RDWR,"j"); c=config(fd); assert(unlink(last_path)==0 && lsc_open(&c,&s)==-1 && !s); close(fd); /* nlink 0 */
    char fifo[600]; snprintf(fifo,sizeof fifo,"%s/fifo",scratch); (void)unlink(fifo); assert(mkfifo(fifo,0600)==0);
    fd=open(fifo,O_RDWR|O_NONBLOCK|O_CLOEXEC); assert(fd>=0); c=config(fd); assert(lsc_open(&c,&s)==-1 && !s); close(fd); assert(unlink(fifo)==0);
    /* flock: another open file description of the same journal is excluded... */
    fd=journal_file(O_RDWR,"j"); c=config(fd); assert(lsc_open(&c,&s)==0);
    int other=open(last_path,O_RDWR|O_CLOEXEC); assert(other>=0);
    struct lsc_config c2=config(other); assert(lsc_open(&c2,&t)==-1 && !t);
    /* ...but a second handle on the SAME description is not; only the size check
     * stops its begin from sending once the first has written INTENT. */
    assert(lsc_open(&c,&t)==0 && t);
    assert(lsc_begin(s)==0 && sent==1); lsc_close(s);
    assert(lsc_begin(t)==-1 && sent==1); finish(t); journal_is(fd,INTENT);
    struct lsc *u=NULL; assert(lsc_open(&c2,&u)==-1 && !u); /* nonempty: never reopenable */
    close(other); close(fd);
    /* a pre-INTENT failure leaves the journal empty and therefore reopenable */
    reset("start",1,0); fd=journal_file(O_RDWR,"j"); c=config(fd);
    assert(lsc_open(&c,&s)==0 && lsc_begin(s)==-1 && sent==0); finish(s); journal_is(fd,"");
    reset(NULL,0,0); assert(lsc_open(&c,&s)==0 && lsc_begin(s)==0 && sent==1); finish(s); close(fd);
}
static char keeper_path[600], libexec_path[600], usr_path[600], aside[600], real_libexec[600], root_link[600];
static const char *const KEEPER_CASES[]={"missing","symlink","group-writable","other-writable","not-exec","hardlink",
    "directory","libexec-writable","usr-writable","libexec-symlink","root-symlink","owner"};
static void keeper_defect(const char *w,int on) {
    if (!strcmp(w,"missing")) assert(on ? rename(keeper_path,aside)==0:rename(aside,keeper_path)==0);
    else if (!strcmp(w,"symlink")) assert(on ? rename(keeper_path,aside)==0 && symlink(aside,keeper_path)==0:unlink(keeper_path)==0 && rename(aside,keeper_path)==0);
    else if (!strcmp(w,"group-writable")) assert(chmod(keeper_path,on ? 0775:0755)==0);
    else if (!strcmp(w,"other-writable")) assert(chmod(keeper_path,on ? 0757:0755)==0);
    else if (!strcmp(w,"not-exec")) assert(chmod(keeper_path,on ? 0644:0755)==0);
    else if (!strcmp(w,"hardlink")) assert(on ? link(keeper_path,aside)==0:unlink(aside)==0);
    else if (!strcmp(w,"directory")) assert(on ? rename(keeper_path,aside)==0 && mkdir(keeper_path,0755)==0:rmdir(keeper_path)==0 && rename(aside,keeper_path)==0);
    else if (!strcmp(w,"libexec-writable")) assert(chmod(libexec_path,on ? 0775:0755)==0);
    else if (!strcmp(w,"usr-writable")) assert(chmod(usr_path,on ? 0757:0755)==0);
    else if (!strcmp(w,"libexec-symlink")) assert(on ? rename(libexec_path,real_libexec)==0 && symlink(real_libexec,libexec_path)==0:unlink(libexec_path)==0 && rename(real_libexec,libexec_path)==0);
    else if (!strcmp(w,"root-symlink")) { if (on) { assert(symlink(scratch,root_link)==0); lsc_test_root=root_link; } else { assert(unlink(root_link)==0); lsc_test_root=scratch; } }
    else { assert(!strcmp(w,"owner")); lsc_test_keeper_uid=on ? getuid()+1:getuid(); }
}
static void test_keeper(void) {
    /* scratch root tree owned by us, exercised by the production keeper_safe */
    for (size_t k=0;k<sizeof KEEPER_CASES/sizeof *KEEPER_CASES;k++) {
        reset(NULL,0,0); keeper_defect(KEEPER_CASES[k],1); standard(O_OPEN);
        keeper_defect(KEEPER_CASES[k],0); reset(NULL,0,0); standard(O_ANCHORED);
        /* the same defect appearing between open and begin stops begin before any send */
        reset(NULL,0,0); int fd=journal_file(O_RDWR,"j"); struct lsc_config c=config(fd); struct lsc *s=NULL; assert(lsc_open(&c,&s)==0);
        keeper_defect(KEEPER_CASES[k],1);
        assert(lsc_begin(s)==-1 && sent==0 && !bus_live && count("exclusive")==2); journal_is(fd,""); finish(s); close(fd);
        keeper_defect(KEEPER_CASES[k],0);
    }
}
static void setup_root(void) {
    /* defaults compiled into the fixture match the production pins */
    assert(!strcmp(lsc_test_root,"/") && lsc_test_keeper_uid==0 && lsc_test_journal_uid==0);
    assert(getcwd(scratch,sizeof scratch-32)); strcat(scratch,"/fixture-XXXXXX"); assert(mkdtemp(scratch)); assert(chmod(scratch,0755)==0);
    snprintf(aside,sizeof aside,"%s/aside",scratch); snprintf(real_libexec,sizeof real_libexec,"%s/libexec-real",scratch);
    snprintf(root_link,sizeof root_link,"%s/root-link",scratch);
    snprintf(usr_path,sizeof usr_path,"%s/usr",scratch); snprintf(libexec_path,sizeof libexec_path,"%s/usr/libexec",scratch);
    snprintf(keeper_path,sizeof keeper_path,"%s/usr/libexec/step-container-keeper",scratch);
    assert(mkdir(usr_path,0755)==0 && mkdir(libexec_path,0755)==0);
    int k=open(keeper_path,O_CREAT|O_EXCL|O_WRONLY|O_CLOEXEC,0755); assert(k>=0 && write(k,"\177ELF",4)==4 && fchmod(k,0755)==0); close(k);
    lsc_test_root=scratch; lsc_test_keeper_uid=lsc_test_journal_uid=getuid();
}
static void teardown_root(void) {
    (void)unlink(last_path);
    assert(unlink(keeper_path)==0 && rmdir(libexec_path)==0 && rmdir(usr_path)==0 && rmdir(scratch)==0);
}
int main(void) {
    setup_root();
    void (*tests[])(void)={test_names,test_success,test_authority_and_owner,test_begin_faults,test_dispatch,test_events,test_readback,test_api,test_journal,test_keeper};
    for (size_t i=0;i<sizeof tests/sizeof *tests;i++) { tests[i](); }
    teardown_root();
    puts("create: fake-bus queue, authority/owner sweeps, readback, journal and scratch-root keeper tests passed");
    return 0;
}
