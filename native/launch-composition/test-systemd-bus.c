/* Compile the actual sd-bus reader against a strict public-ABI fixture. */
#include "systemd-observer.c"
#include <assert.h>
#include <stdarg.h>
struct sd_bus { int unused; };
struct sd_bus_message { int kind; };
static struct sd_bus connection;
static struct sd_bus_message reply;
static unsigned owners, mode;
static int freed;
/* Connection is driven the production way: new + fixed address + client +
 * start, then nonblocking readiness. mode 1: start fails; modes 12-14 below. */
static unsigned started, ready_polls, processed;
int sd_bus_new(sd_bus **out) { *out=&connection; started=0; ready_polls=0; processed=0; return 0; }
int sd_bus_set_address(sd_bus *b,const char *a) { assert(b==&connection && !strcmp(a,"unix:path=/run/dbus/system_bus_socket")); return 0; }
int sd_bus_set_bus_client(sd_bus *b,int x) { assert(b==&connection && x==1); return 0; }
int sd_bus_start(sd_bus *b) { assert(b==&connection && !started); started=1; return mode==1 ? -EIO:0; }
/* mode 12: ready only after 40 buffered process() steps (exceeds one dispatch
 * bound, must yield and continue); mode 13: readiness reports an error;
 * mode 14: process() fails. */
int sd_bus_is_ready(sd_bus *b) {
    assert(b==&connection && started); ready_polls++;
    if (mode==13) return -EIO;
    if ((mode==12 && processed<40) || mode==14) return 0;
    return 1;
}
static unsigned process_calls;
int sd_bus_process(sd_bus *b,sd_bus_message **m) {
    assert(b==&connection && !m); process_calls++;
    if (mode==14) return -EIO;
    processed++; return 1;
}
int sd_bus_get_events(sd_bus *b) { assert(b==&connection); return 1; }
int sd_bus_get_timeout(sd_bus *b,uint64_t *t) { assert(b==&connection); *t=UINT64_MAX; return 0; }
int ppoll(struct pollfd *p,nfds_t n,const struct timespec *ts,const sigset_t *mask) {
    assert(p && n==1 && p->fd==123 && ts && !mask);
    /* buffered work must yield with a zero timeout, never sleep */
    assert(ts->tv_sec==0 && ts->tv_nsec==0); p->revents=0; return 0;
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
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t timeout) {
    /* every blocking call is budgeted: min(left, 2 s); a fast fixture always has >2 s left */
    assert(b==&connection && timeout==2000000); budgets++; return 0;
}
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *method,sd_bus_error *error,sd_bus_message **out,const char *types,...) {
    assert(b==&connection && !strcmp(types,"s"));
    assert(ready_polls>0 && sd_bus_is_ready(b)==1); /* never before readiness */
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
    reply.kind=3; *out=&reply; return 0;
}
int sd_bus_get_property_string(sd_bus *b,const char *dest,const char *path,const char *iface,const char *property,sd_bus_error *error,char **out) {
    (void)b; (void)dest; (void)path; (void)error;
    assert(!strcmp(iface,!strcmp(property,"ControlGroup") ? "org.freedesktop.systemd1.Service":"org.freedesktop.systemd1.Unit"));
    assert(!strcmp(property,"ControlGroup") || !strcmp(property,"ActiveState"));
    /* mode 11: systemd 259 reports "" for a stopped unit whose cgroup was pruned */
    *out=strdup(!strcmp(property,"ControlGroup") ? (mode==11 ? "":"/protected.slice/original.service"):"inactive"); assert(*out);
    return mode==6 ? -EIO:0;
}
int main(void) {
    for (mode=0;mode<15;mode++) {
        owners=0; budgets=0; process_calls=0; struct lso_snapshot s;
        int r=snapshot(NULL,"fixed.service",":1.42",&s);
        if (mode==0) assert(budgets==11); /* start; owner x2; GetUnit; 2 strings; InvocationID; Job; closing owner x2; final check */
        if (mode==12) assert(r==0 && processed==40 && ready_polls>LSO_DISPATCH_BOUND);
        /* errors end readiness at once, not by running into the deadline */
        if (mode==13) assert(r<0 && process_calls==0 && ready_polls==1);
        if (mode==14) assert(r<0 && process_calls==1);
        if (mode==0 || mode==7) {
            assert(r==0 && !s.missing && !strcmp(s.invocation,"cccccccccccccccccccccccccccccccc"));
            assert(s.job==(mode==7 ? 42u:0u));
        } else if (mode==2) assert(r==0 && s.missing==1);
        else if (mode==11) assert(r==0 && !s.missing && s.cgroup[0]==0 && !strcmp(s.state,"inactive"));
        else if (mode==12) assert(!s.missing && !strcmp(s.invocation,"cccccccccccccccccccccccccccccccc"));
        else assert(r<0);
        printf("ok - sd-bus ABI fixture %u\n",mode);
    }
    assert(freed==15); return 0;
}
