#define _GNU_SOURCE
#include "systemd-observer.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>
/* Minimal public stable sd-bus ABI declarations. Runtime library is installed
 * on minimal hosts without libsystemd-dev; no private structs or ABI guesses.
 * Link directly with -l:libsystemd.so.0, not dlopen/searching writable paths.
 */
typedef struct sd_bus sd_bus;
typedef struct sd_bus_message sd_bus_message;
typedef union { uint8_t bytes[16]; uint64_t qwords[2]; } sd_id128_t;
typedef struct { const char *name, *message; int _need_free; } sd_bus_error;
extern int sd_bus_open_system(sd_bus **);
extern int sd_bus_get_fd(sd_bus *);
extern int sd_bus_get_bus_id(sd_bus *, sd_id128_t *);
extern sd_bus *sd_bus_unref(sd_bus *);
extern sd_bus_message *sd_bus_message_unref(sd_bus_message *);
extern void sd_bus_error_free(sd_bus_error *);
extern int sd_bus_set_method_call_timeout(sd_bus *, uint64_t);
extern int sd_bus_call_method(sd_bus *, const char *, const char *, const char *, const char *, sd_bus_error *, sd_bus_message **, const char *, ...);
extern int sd_bus_message_read(sd_bus_message *, const char *, ...);
extern int sd_bus_message_read_array(sd_bus_message *, char, const void **, size_t *);
extern int sd_bus_get_property(sd_bus *, const char *, const char *, const char *, const char *, sd_bus_error *, sd_bus_message **, const char *);
extern int sd_bus_get_property_string(sd_bus *, const char *, const char *, const char *, const char *, sd_bus_error *, char **);
struct lso {
    struct lso_config c;
    struct lso_ops ops;
    void *ops_context;
    int boot, group, absent;
    char unit[100];
};
static int copy(char *to, size_t n, const char *from) {
    if (!from || strlen(from)>=n) return -1;
    memcpy(to,from,strlen(from)+1); return 0;
}
static int hex(const char *s) {
    if (strnlen(s,33)!=32) return 0;
    int nonzero=0;
    for (size_t i=0;i<32;i++) {
        if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
        nonzero |= s[i]!='0';
    }
    return nonzero;
}
static int exact(const struct lc_entry *a, const struct lc_entry *b) {
    return a->slot==b->slot && a->principal==b->principal &&
        !memcmp(a->epoch,b->epoch,sizeof a->epoch) && !memcmp(a->boot,b->boot,sizeof a->boot) &&
        !memcmp(a->user,b->user,sizeof a->user) && !memcmp(a->workspace,b->workspace,sizeof a->workspace) &&
        !memcmp(a->launch,b->launch,sizeof a->launch) && !memcmp(a->container,b->container,sizeof a->container);
}
static int owner(sd_bus *b, const char *expected) {
    sd_bus_message *m=NULL; const char *s=NULL;
    int r=sd_bus_call_method(b,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetNameOwner",NULL,&m,"s","org.freedesktop.systemd1");
    int ok=r>=0 && sd_bus_message_read(m,"s",&s)>0 && s && !strcmp(s,expected);
    sd_bus_message_unref(m); m=NULL;
    if (!ok) return 0;
    unsigned uid=1;
    r=sd_bus_call_method(b,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetConnectionUnixUser",NULL,&m,"s",expected);
    ok=r>=0 && sd_bus_message_read(m,"u",&uid)>0 && uid==0;
    sd_bus_message_unref(m); return ok;
}
static int string_property(sd_bus *b,const char *manager,const char *path,const char *key,char *out,size_t n) {
    char *s=NULL;
    int r=sd_bus_get_property_string(b,manager,path,!strcmp(key,"ControlGroup") ? "org.freedesktop.systemd1.Service":"org.freedesktop.systemd1.Unit",key,NULL,&s);
    int ok=r>=0 && copy(out,n,s)==0;
    free(s); return ok;
}
static int snapshot(void *ctx,const char *unit,const char *manager,struct lso_snapshot *out) {
    (void)ctx; sd_bus *b=NULL; sd_bus_message *m=NULL; sd_bus_error error={0};
    int result=-1; const char *path=NULL;
    memset(out,0,sizeof *out);
    if (sd_bus_open_system(&b)<0) goto done;
    /* Reject environment-directed/user buses. Pin kernel-authenticated root
     * bus peer for this connection; expected systemd name owner must be root too. */
    struct ucred peer; socklen_t peer_length=sizeof peer;
    int bus_fd=sd_bus_get_fd(b);
    if (bus_fd<0 || getsockopt(bus_fd,SOL_SOCKET,SO_PEERCRED,&peer,&peer_length)<0 ||
        peer_length!=sizeof peer || peer.uid!=0) goto done;
    if (sd_bus_set_method_call_timeout(b,2000000)<0 || !owner(b,manager)) goto done;
    sd_id128_t bus_id;
    if (sd_bus_get_bus_id(b,&bus_id)<0) goto done;
    for (size_t i=0;i<16;i++) (void)snprintf(out->bus_id+i*2,3,"%02x",(unsigned)bus_id.bytes[i]);
    int r=sd_bus_call_method(b,manager,"/org/freedesktop/systemd1","org.freedesktop.systemd1.Manager","GetUnit",&error,&m,"s",unit);
    if (r<0) {
        if (error.name && !strcmp(error.name,"org.freedesktop.systemd1.NoSuchUnit")) {
            out->missing=1; result=0;
        }
        goto done;
    }
    if (sd_bus_message_read(m,"o",&path)<=0 || !path) goto done;
    char object[1024]; if (copy(object,sizeof object,path)<0) goto done;
    sd_bus_message_unref(m); m=NULL;
    if (!string_property(b,manager,object,"ControlGroup",out->cgroup,sizeof out->cgroup) ||
        !string_property(b,manager,object,"ActiveState",out->state,sizeof out->state)) goto done;
    if (sd_bus_get_property(b,manager,object,"org.freedesktop.systemd1.Unit","InvocationID",NULL,&m,"ay")<0) goto done;
    const void *bytes=NULL; size_t length=0;
    if (sd_bus_message_read_array(m,'y',&bytes,&length)<0 || length!=16 || !bytes) goto done;
    const unsigned char *id=bytes;
    for (size_t i=0;i<16;i++) (void)snprintf(out->invocation+i*2,3,"%02x",(unsigned)id[i]);
    sd_bus_message_unref(m); m=NULL;
    if (sd_bus_get_property(b,manager,object,"org.freedesktop.systemd1.Unit","Job",NULL,&m,"(uo)")<0 ||
        sd_bus_message_read(m,"(uo)",&out->job,&path)<=0) goto done;
    result=0;
done:
    if (result==0 && (!owner(b,manager) || copy(out->manager,sizeof out->manager,manager)<0)) result=-1;
    sd_bus_error_free(&error); sd_bus_message_unref(m); sd_bus_unref(b); return result;
}
int lso_bus_snapshot(void *ctx,const char *unit,const char *manager,struct lso_snapshot *out) {
    return snapshot(ctx,unit,manager,out);
}
static int events(void *ctx,int group,int *populated) {
    (void)ctx;
    int fd=openat(group,"cgroup.events",O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
    if (fd<0) return -1;
    char buf[4096]; ssize_t n=pread(fd,buf,sizeof buf-1,0); close(fd);
    if (n<=0 || n==(ssize_t)sizeof buf-1 || memchr(buf,0,(size_t)n)) return -1;
    buf[n]=0;
    int found=0;
    char *save=NULL;
    for (char *line=strtok_r(buf,"\n",&save);line;line=strtok_r(NULL,"\n",&save)) {
        if (!strncmp(line,"populated",9)) {
            if (found++ || (strcmp(line,"populated 0") && strcmp(line,"populated 1"))) return -1;
            *populated=line[10]-'0';
        }
    }
    return found==1 ? 0:-1;
}
/* The held original directory was rmdir'd: the VFS marks a removed directory
 * dead (S_DEAD) and getdents on ANY descriptor of it fails with ENOENT, which a
 * live directory never does (the dead check precedes the offset). st_nlink is NOT usable: kernfs (cgroupfs)
 * recomputes it as subdirs+2 on every stat, even after removal. A cgroup v2
 * rmdir succeeds only while unpopulated and without live children. This check
 * is used for post-absence metadata cleanup only, not to replace populated 0.
 * Any other result,
 * including other errors (O_PATH: EBADF), is not proof. */
static int removed(void *ctx,int group) {
    (void)ctx; char buf[512];
    long n=syscall(SYS_getdents64,group,buf,sizeof buf);
    return n<0 && errno==ENOENT;
}
int lso_removed(void *ctx,int group) { return removed(ctx,group); }
static int valid(struct lso *o,const struct lc_entry *e) {
    if (!e || !exact(e,&o->c.entry) || !o->c.lifetime_fenced || o->c.lifetime_fenced(o->c.context,e)!=1) return 0;
    struct stat st; char boot[38]={0};
    if (fstat(o->boot,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=o->c.trusted_uid || (st.st_mode&022)) return 0;
    if (pread(o->boot,boot,sizeof boot-1,0)!=37 || boot[36]!='\n' || memcmp(boot,e->boot,36)) return 0;
    if (fstat(o->group,&st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=o->c.trusted_uid || (st.st_mode&022) ||
        st.st_dev!=o->c.cgroup_device || st.st_ino!=o->c.cgroup_inode) return 0;
    return 1;
}
int lso_open_with_ops(const struct lso_config *c,const struct lso_ops *ops,void *ctx,struct lso **out) {
    if (!out) { errno=EINVAL; return -1; } *out=NULL;
    if (!c || !ops || !ops->snapshot ||
        !hex(c->entry.epoch) || !hex(c->entry.launch) || !hex(c->invocation) || !hex(c->bus_id) ||
        strnlen(c->entry.boot,37)!=36 || strnlen(c->manager,128)>=128 || c->manager[0]!=':' ||
        strnlen(c->cgroup,512)>=512 || c->cgroup[0]!='/' || !c->cgroup[1]) { errno=EINVAL; return -1; }
    char container[90];
    (void)snprintf(container,sizeof container,"step-lc-%s-%016llx",c->entry.epoch,(unsigned long long)c->entry.slot);
    if (strnlen(c->entry.container,90)>=90 || strcmp(container,c->entry.container)) { errno=EINVAL; return -1; }
    struct lso *o=calloc(1,sizeof *o); if (!o) return -1;
    o->c=*c; o->ops=*ops; o->ops_context=ctx;
    if (!o->ops.events) o->ops.events=events;
    if (!o->ops.removed) o->ops.removed=removed;
    o->boot=fcntl(c->boot_fd,F_DUPFD_CLOEXEC,3); o->group=fcntl(c->cgroup_fd,F_DUPFD_CLOEXEC,3);
    if (o->boot<0 || o->group<0) { lso_close(o); return -1; }
    (void)snprintf(o->unit,sizeof o->unit,"%s.service",container);
    *out=o; return 0;
}
int lso_open(const struct lso_config *c,struct lso **out) {
    const struct lso_ops ops={snapshot,events,removed};
    if (!out) { errno=EINVAL; return -1; } *out=NULL;
    struct statfs fs;
    if (!c || c->trusted_uid!=0 || fstatfs(c->cgroup_fd,&fs)<0 || fs.f_type!=CGROUP2_SUPER_MAGIC) { errno=EPERM; return -1; }
    return lso_open_with_ops(c,&ops,NULL,out);
}
static int read_snapshot(struct lso *o,struct lso_snapshot *s) {
    memset(s,0,sizeof *s);
    if (o->ops.snapshot(o->ops_context,o->unit,o->c.manager,s)<0 ||
        !memchr(s->bus_id,0,sizeof s->bus_id) || strcmp(s->bus_id,o->c.bus_id) ||
        !memchr(s->manager,0,sizeof s->manager) || strcmp(s->manager,o->c.manager) ||
        !memchr(s->invocation,0,sizeof s->invocation) || !memchr(s->cgroup,0,sizeof s->cgroup) ||
        !memchr(s->state,0,sizeof s->state)) return 0;
    return s->missing==0 || s->missing==1;
}
int lso_absent(void *ctx,const struct lc_entry *e) {
    struct lso *o=ctx; struct lso_snapshot before,after;
    if (!o || !valid(o,e)) return 0;
    if (o->absent) return 1; /* same fenced lifetime; cleanup retry, not new observation */
    /* ControlGroup: the launch-time path, or "" once systemd pruned the stopped
     * unit's cgroup (systemd 259 reports "" after unit_release_cgroup). Never
     * evidence by itself: absence rests on the pinned descriptor below. Any
     * other nonempty path is a different cgroup. */
    if (!read_snapshot(o,&before) || before.missing || before.job ||
        strcmp(before.invocation,o->c.invocation) || (strcmp(before.cgroup,o->c.cgroup) && before.cgroup[0]) ||
        (strcmp(before.state,"inactive") && strcmp(before.state,"failed"))) return 0;
    /* The original pinned subtree must still yield populated 0 (including
     * descendants). Removal is cleanup evidence only, never a substitute for
     * a missed emptiness observation. */
    int populated=-1;
    if (o->ops.events(o->ops_context,o->group,&populated)<0 || populated!=0) return 0;
    if (!read_snapshot(o,&after) || after.missing || after.job ||
        strcmp(after.invocation,before.invocation) || strcmp(after.cgroup,before.cgroup) ||
        strcmp(after.state,before.state) || !valid(o,e)) return 0;
    o->absent=1; return 1;
}
int lso_clean(void *ctx,const struct lc_entry *e) {
    struct lso *o=ctx; struct lso_snapshot s;
    if (!o || !o->absent || !valid(o,e) || !read_snapshot(o,&s) || !s.missing ||
        o->ops.removed(o->ops_context,o->group)!=1 || !valid(o,e)) return 0;
    return 1;
}
int lso_reconcile(struct lso *o,struct lco *owner_handle,uint64_t slot) {
    return lco_reconcile(owner_handle,slot,lso_absent,lso_clean,o);
}
void lso_close(struct lso *o) {
    if (o) { if (o->boot>=0) close(o->boot); if (o->group>=0) close(o->group); free(o); }
}
