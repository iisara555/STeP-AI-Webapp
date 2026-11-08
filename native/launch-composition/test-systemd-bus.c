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
int sd_bus_open_system(sd_bus **out) { *out=&connection; return mode==1 ? -EIO:0; }
int sd_bus_get_fd(sd_bus *b) { assert(b==&connection); return 123; }
int sd_bus_get_bus_id(sd_bus *b,sd_id128_t *id) { assert(b==&connection); memset(id,0xdd,sizeof *id); return 0; }
int getsockopt(int fd,int level,int opt,void *value,socklen_t *length) {
    assert(fd==123 && level==SOL_SOCKET && opt==SO_PEERCRED && *length==sizeof(struct ucred));
    struct ucred p={.pid=1,.uid=mode==9 ? 1000u:0u,.gid=0}; memcpy(value,&p,sizeof p); return 0;
}
sd_bus *sd_bus_unref(sd_bus *b) { (void)b; return NULL; }
sd_bus_message *sd_bus_message_unref(sd_bus_message *m) { (void)m; return NULL; }
void sd_bus_error_free(sd_bus_error *e) { (void)e; freed++; }
int sd_bus_set_method_call_timeout(sd_bus *b,uint64_t timeout) { assert(b==&connection && timeout==2000000); return 0; }
int sd_bus_call_method(sd_bus *b,const char *dest,const char *path,const char *iface,const char *method,sd_bus_error *error,sd_bus_message **out,const char *types,...) {
    assert(b==&connection && !strcmp(types,"s"));
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
    for (mode=0;mode<12;mode++) {
        owners=0; struct lso_snapshot s;
        int r=snapshot(NULL,"fixed.service",":1.42",&s);
        if (mode==0 || mode==7) {
            assert(r==0 && !s.missing && !strcmp(s.invocation,"cccccccccccccccccccccccccccccccc"));
            assert(s.job==(mode==7 ? 42u:0u));
        } else if (mode==2) assert(r==0 && s.missing==1);
        else if (mode==11) assert(r==0 && !s.missing && s.cgroup[0]==0 && !strcmp(s.state,"inactive"));
        else assert(r<0);
        printf("ok - sd-bus ABI fixture %u\n",mode);
    }
    assert(freed==12); return 0;
}
