#define _GNU_SOURCE
#define LSC_TESTING 1
extern int fixture_fsync(int);
#define fsync fixture_fsync
#define getsockopt fixture_getsockopt
#include "create.c"
#undef fsync
#undef getsockopt
extern int fsync(int);
#include <assert.h>
#include <stdarg.h>
/* No real bus symbols are linked. The fixture checks every typed write. */
struct sd_bus { int unused; }; struct sd_bus_message { int kind; }; struct sd_bus_slot { int unused; };
static struct sd_bus bus;
static struct sd_bus_message request, reply={1}, signal_message={2}, property={3};
static struct sd_bus_slot slot;
static sd_bus_message_handler_t method_cb, signal_cb;
static void *method_ctx, *signal_ctx;
static int sent, mode, read_index, props, journal_fd, synced, property_depth;
int fixture_fsync(int fd) { if (mode==8 || (mode==16 && synced>=1) || (mode==17 && synced>=2)) { errno=EIO; return -1; } synced++; return fsync(fd); }
static char trace[16384]; static size_t trace_n;
static void record(const char *fmt, ...) {
    va_list a; va_start(a,fmt); int n=vsnprintf(trace+trace_n,sizeof trace-trace_n,fmt,a); va_end(a);
    assert(n>=0 && (size_t)n<sizeof trace-trace_n); trace_n+=(size_t)n;
}
int sd_bus_get_fd(sd_bus *b) { (void)b; return 42; }
int fixture_getsockopt(int fd,int level,int opt,void *v,socklen_t *n) { assert(fd==42 && level==SOL_SOCKET && opt==SO_PEERCRED); struct ucred *u=v; memset(u,0,sizeof *u); u->uid=mode==15 ? 1U:0U; *n=sizeof *u; return 0; }
int sd_bus_new(sd_bus **b) { *b=&bus; return 0; }
int sd_bus_set_address(sd_bus *b,const char *a) { (void)b; assert(!strcmp(a,"unix:path=/run/dbus/system_bus_socket")); return 0; }
int sd_bus_set_bus_client(sd_bus *b,int x) { (void)b; assert(x==1); return 0; }
int sd_bus_start(sd_bus *b) { (void)b; return 0; }
int sd_bus_get_bus_id(sd_bus *b,sd_id128_t *id) { (void)b; memset(id->bytes,mode==14 ? 0x12:0x11,16); return 0; }
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t t) { (void)b; assert(t==2000000); return 0; }
sd_bus *sd_bus_unref(sd_bus *b) { (void)b; return NULL; }
sd_bus_slot *sd_bus_slot_unref(sd_bus_slot *s) { (void)s; return NULL; }
sd_bus_message *sd_bus_message_unref(sd_bus_message *m) { (void)m; return NULL; }
int sd_bus_message_new_method_call(sd_bus *b,sd_bus_message **m,const char *dest,const char *path,const char *iface,const char *member) {
    (void)b; assert(!strcmp(dest,":1.42")); assert(!strcmp(path,"/org/freedesktop/systemd1")); assert(!strcmp(iface,"org.freedesktop.systemd1.Manager")); assert(!strcmp(member,"StartTransientUnit")); *m=&request; return 0;
}
int sd_bus_message_open_container(sd_bus_message *m,char t,const char *s) { assert(m==&request); record("<%c:%s>",t,s); return 0; }
int sd_bus_message_close_container(sd_bus_message *m) { assert(m==&request); record("</>"); return 0; }
int sd_bus_message_append(sd_bus_message *m,const char *types,...) {
    assert(m==&request); va_list a; va_start(a,types);
    record("[%s:",types);
    for (const char *p=types;*p;p++) {
        if (*p=='s') record("%s;",va_arg(a,const char *));
        else if (*p=='b') record("%d;",va_arg(a,int));
        else if (*p=='t') record("%llu;",(unsigned long long)va_arg(a,uint64_t));
        else assert(0);
    }
    record("]"); va_end(a); return 0;
}
int sd_bus_call_async(sd_bus *b,sd_bus_slot **s,sd_bus_message *m,sd_bus_message_handler_t cb,void *ctx,uint64_t timeout) {
    (void)b; assert(m==&request && timeout==2000000); struct stat st; assert(fstat(journal_fd,&st)==0 && st.st_size>0);
    char buf[2048]={0}; assert(pread(journal_fd,buf,sizeof buf-1,0)>0); assert(strstr(buf,"INTENT ") && synced>0); sent++; *s=&slot; method_cb=cb; method_ctx=ctx; return mode==1 ? -EIO:0;
}
int sd_bus_add_match(sd_bus *b,sd_bus_slot **s,const char *match,sd_bus_message_handler_t cb,void *ctx) {
    (void)b; assert(strstr(match,"sender=':1.42'") && strstr(match,"member='JobRemoved'")); *s=&slot; signal_cb=cb; signal_ctx=ctx; return 0;
}
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *member,sd_bus_error *e,sd_bus_message **m,const char *types,...) {
    (void)b;(void)path;(void)iface;(void)e;(void)types;
    assert(!strcmp(dest,"org.freedesktop.DBus") || !strcmp(dest,":1.42"));
    if (!strcmp(member,"GetNameOwner")) read_index=10;
    else if (!strcmp(member,"GetConnectionUnixUser")) read_index=11;
    else if (!strcmp(member,"GetUnit")) read_index=12;
    else assert(!strcmp(member,"Subscribe"));
    *m=&reply; return 0;
}
int sd_bus_message_is_method_error(sd_bus_message *m,const char *e) { (void)m;(void)e; return mode==2; }
int sd_bus_message_at_end(sd_bus_message *m,int complete) { if (m==&property && complete && property_depth) return 0; return mode==3 ? 0:1; }
int sd_bus_message_exit_container(sd_bus_message *m) { assert(m==&property && property_depth==1); property_depth=0; return 1; }
int sd_bus_message_read(sd_bus_message *m,const char *types,...) {
    va_list a; va_start(a,types);
    if (types[0]=='s' && types[1]==0) *va_arg(a,const char **)=read_index==10 ? (mode==13 ? ":1.99":":1.42"):props==1 ? "active":mode==12 ? "/wrong":"/system.slice/step-lc-11111111111111111111111111111111-0000000000000001.service";
    else if (types[0]=='u' && types[1]==0) *va_arg(a,unsigned *)=0;
    else if (types[0]=='o' && types[1]==0) *va_arg(a,const char **)=read_index==12 ? "/org/freedesktop/systemd1/unit/anchor":"/org/freedesktop/systemd1/job/7";
    else if (types[0]=='u' && types[1]=='o') {
        assert(m==&signal_message); *va_arg(a,unsigned *)=mode==10 ? 8U:7U; *va_arg(a,const char **)="/org/freedesktop/systemd1/job/7";
        *va_arg(a,const char **)="step-lc-11111111111111111111111111111111-0000000000000001.service";
        *va_arg(a,const char **)=mode==4 ? "failed":"done";
    } else if (types[0]=='(') { *va_arg(a,unsigned *)=mode==5 ? 9U:0U; *va_arg(a,const char **)="/"; }
    else assert(0);
    va_end(a); return 1;
}
int sd_bus_message_read_array(sd_bus_message *m,char type,const void **p,size_t *n) { (void)m; assert(type=='y'); static unsigned char id[16]; memset(id,0,sizeof id); id[0]=(unsigned char)(mode==11 ? 0:1); *p=id; *n=mode==6 ? 15U:16U; return 1; }
int sd_bus_get_property(sd_bus *b,const char *dest,const char *path,const char *iface,const char *key,sd_bus_error *e,sd_bus_message **m,const char *type) {
    (void)b;(void)path;(void)e;assert(!strcmp(dest,":1.42")); *m=&property; property_depth=1;
    if (!strcmp(key,"ControlGroup")) { assert(!strcmp(iface,"org.freedesktop.systemd1.Service") && !strcmp(type,"s")); props=2; }
    else { assert(!strcmp(iface,"org.freedesktop.systemd1.Unit"));
        assert((!strcmp(key,"ActiveState") && !strcmp(type,"s")) || (!strcmp(key,"InvocationID") && !strcmp(type,"ay")) || (!strcmp(key,"Job") && !strcmp(type,"(uo)"))); props=1; }
    return 0;
}
int sd_bus_process(sd_bus *b,sd_bus_message **m) { (void)b;(void)m; return 0; }
static int authority(void *ctx,const struct lc_entry *e) { (void)e; return *(int *)ctx; }
static void run(int scenario) {
    mode=(scenario==1 || scenario==8) ? scenario:0; synced=0; sent=0; trace_n=0; props=0; read_index=0;
    char path[]="./fixture-XXXXXX"; journal_fd=mkstemp(path); assert(journal_fd>=0); assert(unlink(path)==0);
    int held=1; struct lsc_config c={.journal_fd=journal_fd,.context=&held,.exclusive=authority};
    c.entry.slot=1; c.entry.principal=1000; c.entry.state=LC_STARTING;
    strcpy(c.entry.epoch,"11111111111111111111111111111111"); strcpy(c.entry.launch,"22222222222222222222222222222222");
    strcpy(c.entry.boot,"11111111-1111-1111-1111-111111111111"); strcpy(c.entry.user,c.entry.boot); strcpy(c.entry.workspace,c.entry.boot);
    strcpy(c.entry.container,"step-lc-11111111111111111111111111111111-0000000000000001"); strcpy(c.bus_id,c.entry.epoch); strcpy(c.manager,":1.42");
    if (scenario==0) {
        struct lsc_config bad=c; struct lsc *denied=NULL;
        strcpy(bad.manager,":1.42'bad"); assert(lsc_open(&bad,&denied)==-1 && !denied);
        /* Unique-name validation: interpolated into a match rule, so strict digits.digits only. */
        static const char *names[]={"1.42",":1",":1.",":.42",":1..42",":1.42.7",":1.4a",":1.42,x",":",":1.42 "};
        for (size_t k=0;k<sizeof names/sizeof *names;k++) { bad=c; strcpy(bad.manager,names[k]); assert(lsc_open(&bad,&denied)==-1 && !denied); }
        bad=c; strcpy(bad.entry.container,"arbitrary.service"); assert(lsc_open(&bad,&denied)==-1 && !denied);
        bad=c; bad.entry.state=LC_RUNNING; assert(lsc_open(&bad,&denied)==-1 && !denied);
        bad=c; strcpy(bad.entry.launch,"/bin/sh"); assert(lsc_open(&bad,&denied)==-1 && !denied);
        held=0; assert(lsc_open(&c,&denied)==-1 && !denied); held=1;
        assert(fchmod(journal_fd,0660)==0); assert(lsc_open(&c,&denied)==-1 && !denied); assert(fchmod(journal_fd,0600)==0);
    }
    struct lsc *s=NULL; assert(lsc_open(&c,&s)==0);
    assert(lsc_begin(s)==((mode==1 || mode==8) ? -1:0)); assert(sent==(mode==8 ? 0:1));
    int before=sent; assert(lsc_begin(s)==-1 && sent==before);
    mode=scenario;
    if (mode==7) s->deadline=1;
    if (mode==9) held=0;
    if (mode!=1 && mode!=8) { read_index=0; method_cb(&reply,method_ctx,NULL); signal_cb(&signal_message,signal_ctx,NULL); (void)lsc_poll(s); }
    assert(lsc_status(s)==(mode==0 ? LSC_ANCHORED:LSC_UNCERTAIN));
    if (mode==0) { struct lsc_receipt r; assert(lsc_receipt(s,&r)==0); assert(r.job==7 && !strcmp(r.invocation,"01000000000000000000000000000000")); }
    assert(strstr(trace,"[ss:step-lc-11111111111111111111111111111111-0000000000000001.service;fail;]"));
    assert(strstr(trace,"[s:ExecStart;]<v:a(sasb)><a:(sasb)><r:sasb>[s:/usr/libexec/step-container-keeper;]<a:s>[s:/usr/libexec/step-container-keeper;]</>[b:0;]</></></>"));
    assert(strstr(trace,"[s:Delegate;]<v:b>[b:0;]</></>"));
    const char *expected=
        "[ss:step-lc-11111111111111111111111111111111-0000000000000001.service;fail;]<a:(sv)>"
        "<r:sv>[s:Type;]<v:s>[s:exec;]</></>"
        "<r:sv>[s:Restart;]<v:s>[s:no;]</></>"
        "<r:sv>[s:Delegate;]<v:b>[b:0;]</></>"
        "<r:sv>[s:KillMode;]<v:s>[s:control-group;]</></>"
        "<r:sv>[s:MemoryMax;]<v:t>[t:536870912;]</></>"
        "<r:sv>[s:TasksMax;]<v:t>[t:64;]</></>"
        "<r:sv>[s:CPUQuotaPerSecUSec;]<v:t>[t:1000000;]</></>"
        "<r:sv>[s:NoNewPrivileges;]<v:b>[b:1;]</></>"
        "<r:sv>[s:User;]<v:s>[s:root;]</></>"
        "<r:sv>[s:Group;]<v:s>[s:root;]</></>"
        "<r:sv>[s:StandardInput;]<v:s>[s:null;]</></>"
        "<r:sv>[s:StandardOutput;]<v:s>[s:null;]</></>"
        "<r:sv>[s:StandardError;]<v:s>[s:null;]</></>"
        "<r:sv>[s:ExecStart;]<v:a(sasb)><a:(sasb)><r:sasb>[s:/usr/libexec/step-container-keeper;]<a:s>[s:/usr/libexec/step-container-keeper;]</>[b:0;]</></></></></><a:(sa(sv))></>";
    assert(!strcmp(trace,expected));
    lsc_close(s); held=1; s=NULL; assert(lsc_open(&c,&s)==-1 && !s); close(journal_fd);
}
int main(void) { for (int i=0;i<=17;i++) run(i); puts("create: 18 fake-bus scenarios passed"); return 0; }
