#define _GNU_SOURCE
#include "stop.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
/* Public stable libsystemd ABI only (same declarations as create.c). */
typedef struct sd_bus sd_bus;
typedef struct sd_bus_message sd_bus_message;
typedef struct sd_bus_slot sd_bus_slot;
typedef union { uint8_t bytes[16]; uint64_t qwords[2]; } sd_id128_t;
typedef struct { const char *name, *message; int _need_free; } sd_bus_error;
typedef int (*sd_bus_message_handler_t)(sd_bus_message *, void *, sd_bus_error *);
extern int sd_bus_get_fd(sd_bus *);
extern int sd_bus_get_events(sd_bus *);
extern int sd_bus_get_timeout(sd_bus *,uint64_t *);
extern int sd_bus_new(sd_bus **);
extern int sd_bus_set_address(sd_bus *,const char *);
extern int sd_bus_set_bus_client(sd_bus *,int);
extern int sd_bus_start(sd_bus *);
extern int sd_bus_get_bus_id(sd_bus *,sd_id128_t *);
extern int sd_bus_set_method_call_timeout(sd_bus *,uint64_t);
extern sd_bus *sd_bus_unref(sd_bus *);
extern sd_bus_slot *sd_bus_slot_unref(sd_bus_slot *);
extern sd_bus_message *sd_bus_message_unref(sd_bus_message *);
extern int sd_bus_message_new_method_call(sd_bus *,sd_bus_message **,const char *,const char *,const char *,const char *);
extern int sd_bus_message_append(sd_bus_message *,const char *,...);
extern int sd_bus_message_append_array(sd_bus_message *,char,const void *,size_t);
extern int sd_bus_call(sd_bus *,sd_bus_message *,uint64_t,sd_bus_error *,sd_bus_message **);
extern int sd_bus_call_async(sd_bus *,sd_bus_slot **,sd_bus_message *,sd_bus_message_handler_t,void *,uint64_t);
extern int sd_bus_add_match(sd_bus *,sd_bus_slot **,const char *,sd_bus_message_handler_t,void *);
extern int sd_bus_call_method(sd_bus *,const char *,const char *,const char *,const char *,sd_bus_error *,sd_bus_message **,const char *,...);
extern int sd_bus_message_read(sd_bus_message *,const char *,...);
extern int sd_bus_message_read_array(sd_bus_message *,char,const void **,size_t *);
extern int sd_bus_message_at_end(sd_bus_message *,int);
extern int sd_bus_message_exit_container(sd_bus_message *);
extern int sd_bus_message_is_method_error(sd_bus_message *,const char *);
extern int sd_bus_get_property(sd_bus *,const char *,const char *,const char *,const char *,sd_bus_error *,sd_bus_message **,const char *);
extern int sd_bus_process(sd_bus *,sd_bus_message **);
extern void sd_bus_error_free(sd_bus_error *);
#define MANAGER "/org/freedesktop/systemd1"
#define UNIT_PREFIX "/org/freedesktop/systemd1/unit/"
#define JOB_PREFIX "/org/freedesktop/systemd1/job/"
#define MI "org.freedesktop.systemd1.Manager"
#define UI "org.freedesktop.systemd1.Unit"
#define SI "org.freedesktop.systemd1.Service"
#define NO_INVOCATION "org.freedesktop.systemd1.NoUnitForInvocationID"
#define DISPATCH_BOUND 32U
#define ATTEMPT_US 5000000ULL
#define CALL_CEILING_US 2000000ULL
#define CREATE_MAX 1024
/* Required owner of both journals (create, stop). Only the fake-bus fixture (LSC_TESTING,
 * same hook rules as create.c) may redirect it to its own uid; the archive
 * object pins 0 and pin-check refuses an object carrying the hook. */
#ifdef LSC_TESTING
#ifndef LSC_FIXTURE_INCLUDE
#error "LSC_TESTING is only valid when stop.c is #included by test-stop.c"
#endif
__attribute__((used)) static const char lsc_test_hook_marker[]="lsc_test_hook_marker";
static uid_t lsc_test_journal_uid=0, lsc_test_create_uid=0;
#define JOURNAL_UID lsc_test_journal_uid
#define CREATE_UID lsc_test_create_uid
#else
#define JOURNAL_UID ((uid_t)0)
#define CREATE_UID ((uid_t)0)
#endif
struct las {
    struct las_config c;
    int create, fd; /* dup'd create journal (read) and stop journal (append) */
    enum las_status state;
    enum las_reason reason;
    sd_bus *bus;
    sd_bus_slot *call, *match;
    char unit[100], invocation_path[200], cgroup[512];
    unsigned char invocation[16];
    char create_bytes[CREATE_MAX];
    size_t create_length;
    unsigned job, event_job;
    int got_reply, got_event;
    uint64_t deadline;
    struct las_receipt receipt;
    int reset_mode; /* las_reset_open handle: las_begin refuses, las_reset only */
    int (*absent)(void *, const struct lc_entry *);
    void *absent_context;
};
static uint64_t now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC,&t)<0) return 0;
    return (uint64_t)t.tv_sec*1000000+(uint64_t)t.tv_nsec/1000;
}
/* Same validators as create.c / create-reconcile.c. */
static int hex(const char *p) {
    if (strnlen(p,33)!=32) return 0;
    int nz=0;
    for (size_t i=0;i<32;i++) { if (!((p[i]>='0' && p[i]<='9') || (p[i]>='a' && p[i]<='f'))) return 0; nz|=p[i]!='0'; }
    return nz;
}
static int uuid(const char *p) {
    if (strnlen(p,37)!=36) return 0;
    for (size_t i=0;i<36;i++) {
        if (i==8 || i==13 || i==18 || i==23) { if (p[i]!='-') return 0; }
        else if (!((p[i]>='0' && p[i]<='9') || (p[i]>='a' && p[i]<='f'))) return 0;
    }
    return 1;
}
/* ":<digits>.<digits>": interpolated into the JobRemoved match rule. */
static int unique_name(const char *p,size_t max) {
    size_t n=strnlen(p,max);
    if (n>=max || p[0]!=':') return 0; /* shortest valid ":1.2" needs no length floor */
    size_t dots=0, run=0;
    for (size_t i=1;i<n;i++) {
        if (p[i]>='0' && p[i]<='9') { run++; continue; }
        if (p[i]!='.' || !run) return 0;
        dots++; run=0;
    }
    return dots==1 && run>0;
}
/* sd_bus_path_encode(UNIT_PREFIX, name), as create.c. systemd resolves
 * UNIT_PREFIX + encode(<32-hex invocation id>) only while that invocation is
 * current (GetUnitByInvocationID returns exactly this path). */
static int object_path(const char *name,char *out,size_t n) {
    static const char digits[]="0123456789abcdef";
    size_t o=sizeof UNIT_PREFIX-1;
    if (!*name || o>=n) return 0;
    memcpy(out,UNIT_PREFIX,o);
    for (size_t i=0;name[i];i++) {
        unsigned char c=(unsigned char)name[i];
        if ((c>='a' && c<='z') || (c>='A' && c<='Z') || (i>0 && c>='0' && c<='9')) { if (o+1>=n) return 0; out[o++]=(char)c; }
        else { if (o+3>=n) return 0; out[o++]='_'; out[o++]=digits[c>>4]; out[o++]=digits[c&15]; }
    }
    out[o]=0; return 1;
}
static int job_number(const char *path,unsigned *out) {
    if (!path || strncmp(path,JOB_PREFIX,sizeof JOB_PREFIX-1)) return 0;
    const char *p=path+sizeof JOB_PREFIX-1; if (*p<'1' || *p>'9') return 0;
    uint64_t n=0;
    for (;*p;p++) { if (*p<'0' || *p>'9') return 0; n=n*10+(unsigned)(*p-'0'); if (n>UINT32_MAX) return 0; } /* checked every digit: no uint64 overflow */
    *out=(unsigned)n; return 1;
}
static int held(struct las *s) { return s->c.exclusive(s->c.context,&s->c.entry)==1; }
static int terminal(struct las *s,enum las_reason r) { s->state=LAS_UNCERTAIN; s->reason=r; return -1; }
static int journal(struct las *s,const char *line) {
    size_t n=strlen(line), off=0;
    while (off<n) { ssize_t r=write(s->fd,line+off,n-off); if (r<0 && errno==EINTR) continue; if (r<=0) return -1; off+=(size_t)r; }
    return fsync(s->fd);
}
/* The create journal must still be byte-identical to create.c's rendering of
 * this entry's INTENT/JOB/ANCHOR. Reading one byte past the maximum detects
 * any other length; a descriptor that cannot be pread (write-only, directory)
 * or reports another length (FIFO, socket) fails the same comparison, so no
 * separate type, size or access-mode check exists. */
static int create_unchanged(struct las *s) {
    struct stat st; char buf[CREATE_MAX+1];
    if (fstat(s->create,&st)<0 || st.st_uid!=CREATE_UID || (st.st_mode&07777)!=0600 || st.st_nlink!=1) return 0;
    ssize_t r=pread(s->create,buf,sizeof buf,0);
    return r==(ssize_t)s->create_length && !memcmp(buf,s->create_bytes,s->create_length);
}
/* Every blocking call is capped at the time left before the attempt deadline
 * (never above 2 s): 0 = no budget left (or clock failure). */
static int budget(struct las *s) {
    uint64_t t=now();
    if (!t || t>=s->deadline) return 0;
    uint64_t left=s->deadline-t;
    return sd_bus_set_method_call_timeout(s->bus,left<CALL_CEILING_US ? left:CALL_CEILING_US)>=0;
}
static enum las_reason owner(struct las *s) {
    struct ucred peer; socklen_t length=sizeof peer;
    int fd=sd_bus_get_fd(s->bus);
    if (fd<0 || getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length)<0 || length!=sizeof peer || peer.uid!=0) return LAS_R_OWNER;
    sd_id128_t id; char bus_id[33]; sd_bus_message *m=NULL; const char *name=NULL; uint32_t uid=1;
    if (sd_bus_get_bus_id(s->bus,&id)<0) return LAS_R_OWNER;
    for (size_t i=0;i<16;i++) (void)snprintf(bus_id+2*i,3,"%02x",(unsigned)id.bytes[i]);
    if (strcmp(bus_id,s->c.bus_id)) return LAS_R_OWNER;
    if (!budget(s)) return LAS_R_DEADLINE;
    int r=sd_bus_call_method(s->bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetNameOwner",NULL,&m,"s","org.freedesktop.systemd1");
    int ok=r>=0 && sd_bus_message_read(m,"s",&name)>0 && name && !strcmp(name,s->c.manager) && sd_bus_message_at_end(m,1)>0;
    sd_bus_message_unref(m); m=NULL;
    if (!ok) return LAS_R_OWNER;
    if (!budget(s)) return LAS_R_DEADLINE;
    r=sd_bus_call_method(s->bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetConnectionUnixUser",NULL,&m,"s",s->c.manager);
    ok=r>=0 && sd_bus_message_read(m,"u",&uid)>0 && uid==0 && sd_bus_message_at_end(m,1)>0;
    sd_bus_message_unref(m); return ok ? LAS_R_NONE:LAS_R_OWNER;
}
/* sd_bus_get_property leaves the cursor inside the variant (create.c rule).
 * exit_container itself refuses unread inner values (-EBUSY); then reject
 * trailing outer arguments. */
static int property_end(sd_bus_message *m) {
    return sd_bus_message_exit_container(m)>0 && sd_bus_message_at_end(m,1)>0;
}
/* All reads go to the invocation path: they fail once this invocation is gone. */
static enum las_reason get(struct las *s,const char *iface,const char *key,const char *type,sd_bus_message **m) {
    *m=NULL;
    if (!budget(s)) return LAS_R_DEADLINE;
    return sd_bus_get_property(s->bus,s->c.manager,s->invocation_path,iface,key,NULL,m,type)<0 ? LAS_R_QUERY:LAS_R_NONE;
}
static enum las_reason string_prop(struct las *s,const char *iface,const char *key,char *out,size_t n) {
    sd_bus_message *m=NULL; const char *v=NULL;
    enum las_reason r=get(s,iface,key,"s",&m);
    if (!r) r=sd_bus_message_read(m,"s",&v)>0 && v && strlen(v)<n && property_end(m) ? LAS_R_NONE:LAS_R_QUERY;
    if (!r) strcpy(out,v);
    sd_bus_message_unref(m); return r;
}
/* GetUnitByInvocationID(expected) must return exactly the invocation path. */
static enum las_reason by_invocation(struct las *s) {
    sd_bus_message *m=NULL, *reply=NULL; sd_bus_error e={0}; const char *p=NULL; enum las_reason r=LAS_R_QUERY;
    if (!budget(s)) return LAS_R_DEADLINE;
    if (sd_bus_message_new_method_call(s->bus,&m,s->c.manager,MANAGER,MI,"GetUnitByInvocationID")<0 ||
        sd_bus_message_append_array(m,'y',s->invocation,16)<0) goto out;
    if (sd_bus_call(s->bus,m,0,&e,&reply)<0) { if (e.name && !strcmp(e.name,NO_INVOCATION)) r=LAS_R_REPLACED; goto out; }
    if (sd_bus_message_read(reply,"o",&p)<=0 || !p || sd_bus_message_at_end(reply,1)<=0) goto out;
    r=strcmp(p,s->invocation_path) ? LAS_R_REPLACED:LAS_R_NONE;
out:
    sd_bus_error_free(&e); sd_bus_message_unref(reply); sd_bus_message_unref(m); return r;
}
enum phase { BEFORE, AFTER };
/* Exact incarnation: invocation path resolves, names our unit, carries our
 * InvocationID and ControlGroup ("" also accepted AFTER: systemd clears it
 * once the stopped unit's cgroup is pruned), state, and no pending job. */
static enum las_reason verify(struct las *s,enum phase ph) {
    enum las_reason r=by_invocation(s);
    char text[512];
    if (r || (r=string_prop(s,UI,"Id",text,sizeof text))) return r;
    if (strcmp(text,s->unit)) return LAS_R_REPLACED;
    sd_bus_message *m=NULL; const void *bytes=NULL; size_t n=0;
    if ((r=get(s,UI,"InvocationID","ay",&m))) { sd_bus_message_unref(m); return r; }
    r=sd_bus_message_read_array(m,'y',&bytes,&n)>0 && n==16 && bytes && property_end(m) ? LAS_R_NONE:LAS_R_QUERY;
    if (!r && memcmp(bytes,s->invocation,16)) r=LAS_R_REPLACED;
    sd_bus_message_unref(m); m=NULL;
    if (r || (r=string_prop(s,SI,"ControlGroup",text,sizeof text))) return r;
    if (strcmp(text,s->cgroup) && (ph==BEFORE || *text)) return LAS_R_REPLACED;
    if ((r=string_prop(s,UI,"ActiveState",text,sizeof text))) return r;
    if (ph==BEFORE ? strcmp(text,"active")!=0:strcmp(text,"inactive") && strcmp(text,"failed")) return LAS_R_STATE;
    if (ph==AFTER) strcpy(s->receipt.state,text);
    uint32_t job=1; const char *p=NULL;
    if ((r=get(s,UI,"Job","(uo)",&m))) { sd_bus_message_unref(m); return r; }
    r=sd_bus_message_read(m,"(uo)",&job,&p)>0 && p && property_end(m) ? LAS_R_NONE:LAS_R_QUERY;
    if (!r && (job!=0 || strcmp(p,"/"))) r=LAS_R_JOB;
    sd_bus_message_unref(m); return r;
}
/* Handlers run only from las_poll's dispatch loop, which stops at the first
 * terminal state; sd-bus delivers the async reply at most once. Job paths
 * accepted by job_number are at most 40 bytes. */
static int method_reply(sd_bus_message *m,void *ctx,sd_bus_error *err) {
    (void)err; struct las *s=ctx; const char *path=NULL;
    if (sd_bus_message_is_method_error(m,NULL)>0 || sd_bus_message_read(m,"o",&path)<=0 ||
        sd_bus_message_at_end(m,1)<=0 || !job_number(path,&s->job)) { terminal(s,LAS_R_STOP); return 0; }
    char line[180]; (void)snprintf(line,sizeof line,"JOB %u %s\n",s->job,path);
    if (journal(s,line)<0) terminal(s,LAS_R_JOURNAL); else s->got_reply=1;
    return 0;
}
static int removed(sd_bus_message *m,void *ctx,sd_bus_error *err) {
    (void)err; struct las *s=ctx; uint32_t job=0; unsigned parsed=0; const char *path=NULL,*unit=NULL,*result=NULL;
    if (sd_bus_message_read(m,"uoss",&job,&path,&unit,&result)<=0 || sd_bus_message_at_end(m,1)<=0) { terminal(s,LAS_R_EVENT); return 0; }
    if (strcmp(unit,s->unit)) return 0; /* the arg2 match filters on the bus; defense in depth */
    /* an invalid path leaves parsed 0, and job 0 never correlates (replies reject it) */
    (void)job_number(path,&parsed);
    if (parsed!=job || strcmp(result,"done") || s->got_event) { terminal(s,LAS_R_EVENT); return 0; }
    s->event_job=job; s->got_event=1; return 0;
}
static int render_create(const struct las_config *c,const char *unit,char *out,size_t n,size_t *length) {
    int a=snprintf(out,n,"INTENT v1 %llu %llu %s %s %s %s %s %s %s %s\nJOB %u " JOB_PREFIX "%u\nANCHOR %u %s /system.slice/%s\n",
        (unsigned long long)c->entry.slot,(unsigned long long)c->entry.principal,c->entry.epoch,c->entry.boot,c->entry.user,
        c->entry.workspace,c->entry.launch,unit,c->bus_id,c->manager,c->job,c->job,c->job,c->invocation,unit);
    if (a<0 || (size_t)a>=n) return 0;
    *length=(size_t)a; return 1;
}
/* The stop journal: an empty protected regular file (checked after flock). */
static int journal_empty(int fd) {
    struct stat st;
    return fstat(fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==JOURNAL_UID && (st.st_mode&07777)==0600 && st.st_nlink==1 && st.st_size==0;
}
int las_open(const struct las_config *c,struct las **out) {
    if (!out) return -1;
    *out=NULL;
    if (!c || !c->exclusive || !c->entry.slot || !c->job || (c->entry.state!=LC_STARTING && c->entry.state!=LC_RUNNING &&
        c->entry.state!=LC_STOPPING && c->entry.state!=LC_FENCED) || !hex(c->entry.epoch) || !hex(c->entry.launch) ||
        !hex(c->bus_id) || !hex(c->invocation) || !uuid(c->entry.boot) || !uuid(c->entry.user) || !uuid(c->entry.workspace) ||
        !unique_name(c->manager,sizeof c->manager)) return -1;
    char container[90]; (void)snprintf(container,sizeof container,"step-lc-%s-%016llx",c->entry.epoch,(unsigned long long)c->entry.slot);
    if (strcmp(container,c->entry.container)) return -1; /* equal to a 57-byte string: terminated */
    if ((fcntl(c->stop_fd,F_GETFL)&O_ACCMODE)!=O_RDWR) return -1;
    struct las *s=calloc(1,sizeof *s); if (!s) return -1;
    s->c=*c; s->create=s->fd=-1;
    (void)snprintf(s->unit,sizeof s->unit,"%s.service",container);
    (void)snprintf(s->cgroup,sizeof s->cgroup,"/system.slice/%s",s->unit);
    for (size_t i=0;i<16;i++) { unsigned v=0; (void)sscanf(c->invocation+2*i,"%2x",&v); s->invocation[i]=(unsigned char)v; }
    if (!render_create(c,s->unit,s->create_bytes,sizeof s->create_bytes,&s->create_length) ||
        !object_path(c->invocation,s->invocation_path,sizeof s->invocation_path)) goto fail;
    s->create=fcntl(c->create_fd,F_DUPFD_CLOEXEC,3); s->fd=fcntl(c->stop_fd,F_DUPFD_CLOEXEC,3);
    /* flock binds open file descriptions: excludes an in-flight creator or
     * create-reconcile handle (create journal) and a second stopper (stop
     * journal) on other descriptions; same-description callers serialize. */
    if (s->create<0 || s->fd<0 || flock(s->create,LOCK_EX|LOCK_NB)<0 || flock(s->fd,LOCK_EX|LOCK_NB)<0 ||
        !create_unchanged(s) || !journal_empty(s->fd) || lseek(s->fd,0,SEEK_SET)<0 || !held(s)) goto fail;
    *out=s; return 0;
fail:
    if (s->create>=0) close(s->create);
    if (s->fd>=0) close(s->fd);
    free(s); return -1;
}
int las_begin(struct las *s) {
    if (s && s->reset_mode) return -1;
    if (!s || s->state!=LAS_NEW) return -1;
    s->state=LAS_UNCERTAIN; /* consumed even by pre-STOP failures; no retry on this handle */
    enum las_reason r;
    sd_bus_message *sub=NULL, *kill=NULL, *stop=NULL;
    uint64_t t=now();
    if (!t) { r=LAS_R_DEADLINE; goto fail; }
    s->deadline=t+ATTEMPT_US;
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    if (!create_unchanged(s)) { r=LAS_R_CREATE; goto fail; }
    if (sd_bus_new(&s->bus)<0 || sd_bus_set_address(s->bus,"unix:path=/run/dbus/system_bus_socket")<0 ||
        sd_bus_set_bus_client(s->bus,1)<0 || sd_bus_start(s->bus)<0) { r=LAS_R_BUS; goto fail; }
    /* 1. Before anything durable: a replaced/inactive/busy unit is refused with
     *    an empty stop journal (provably nothing attempted). */
    if ((r=owner(s)) || (r=verify(s,BEFORE))) goto fail;
    char match[512]; (void)snprintf(match,sizeof match,"type='signal',sender='%s',path='%s',interface='%s',member='JobRemoved',arg2='%s'",s->c.manager,MANAGER,MI,s->unit);
    if (sd_bus_add_match(s->bus,&s->match,match,removed,s)<0) { r=LAS_R_BUS; goto fail; }
    if (!budget(s)) { r=LAS_R_DEADLINE; goto fail; }
    if (sd_bus_call_method(s->bus,s->c.manager,MANAGER,MI,"Subscribe",NULL,&sub,"")<0 || sd_bus_message_at_end(sub,1)<=0) { r=LAS_R_BUS; goto fail; }
    /* 2. Durable STOP intent before any mutation. */
    char line[512];
    (void)snprintf(line,sizeof line,"STOP v1 %llu %s %s %s %s %s %u\n",(unsigned long long)s->c.entry.slot,s->c.entry.launch,
        s->unit,s->c.bus_id,s->c.manager,s->c.invocation,s->c.job);
    if (!journal_empty(s->fd) || journal(s,line)<0) { r=LAS_R_JOURNAL; goto fail; }
    /* 3. Immediately before acting: authority, create evidence, bus/manager
     *    owner and the exact incarnation (identity, cgroup, active, no job). */
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    if (!create_unchanged(s)) { r=LAS_R_CREATE; goto fail; }
    if ((r=owner(s)) || (r=verify(s,BEFORE))) goto fail;
    /* 4. SIGKILL every process of this invocation's cgroup. Addressed to the
     *    invocation path, so a replacement incarnation is never signalled. */
    if (!budget(s)) { r=LAS_R_DEADLINE; goto fail; }
    if (sd_bus_call_method(s->bus,s->c.manager,s->invocation_path,UI,"Kill",NULL,&kill,"si","all",(int32_t)SIGKILL)<0 ||
        sd_bus_message_at_end(kill,1)<=0) { r=LAS_R_KILL; goto fail; }
    if (journal(s,"KILL all 9\n")<0) { r=LAS_R_JOURNAL; goto fail; }
    /* 5. Stop job (mode fail: never replaces/cancels another job) on the same
     *    invocation path; correlated with its exact JobRemoved in las_poll. */
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    if ((r=owner(s))) goto fail;
    t=now();
    if (!t || t>=s->deadline) { r=LAS_R_DEADLINE; goto fail; }
    uint64_t left=s->deadline-t;
    if (sd_bus_message_new_method_call(s->bus,&stop,s->c.manager,s->invocation_path,UI,"Stop")<0 ||
        sd_bus_message_append(stop,"s","fail")<0) { r=LAS_R_STOP; goto fail; }
    s->state=LAS_PENDING;
    if (sd_bus_call_async(s->bus,&s->call,stop,method_reply,s,left<CALL_CEILING_US ? left:CALL_CEILING_US)<0) { r=LAS_R_STOP; goto fail; }
    sd_bus_message_unref(stop); sd_bus_message_unref(kill); sd_bus_message_unref(sub); return 0;
fail:
    sd_bus_message_unref(stop); sd_bus_message_unref(kill); sd_bus_message_unref(sub); return terminal(s,r);
}
int las_poll(struct las *s) {
    if (!s || s->state!=LAS_PENDING) return -1;
    uint64_t t=now();
    if (!t || t>=s->deadline) return terminal(s,LAS_R_DEADLINE);
    if (!held(s)) return terminal(s,LAS_R_AUTHORITY);
    for (unsigned i=0;i<DISPATCH_BOUND;i++) { int r=sd_bus_process(s->bus,NULL); if (r<0) return terminal(s,LAS_R_DISPATCH); if (!r || s->state!=LAS_PENDING) break; }
    if (s->state!=LAS_PENDING) return -1;
    if (!s->got_reply || !s->got_event) return 0;
    if (s->job!=s->event_job) return terminal(s,LAS_R_EVENT); /* canonical paths: equal ids, equal paths */
    enum las_reason r;
    if (!held(s)) return terminal(s,LAS_R_AUTHORITY);
    if ((r=owner(s)) || (r=verify(s,AFTER)) || (r=owner(s))) return terminal(s,r);
    if (!held(s)) return terminal(s,LAS_R_AUTHORITY);
    t=now(); if (!t || t>=s->deadline) return terminal(s,LAS_R_DEADLINE); /* readback is synchronous */
    char line[128]; (void)snprintf(line,sizeof line,"STOPPED %u %s %s\n",s->job,s->c.invocation,s->receipt.state);
    if (journal(s,line)<0) return terminal(s,LAS_R_JOURNAL);
    if (!held(s)) return terminal(s,LAS_R_AUTHORITY);
    s->receipt.job=s->job; memcpy(s->receipt.invocation,s->c.invocation,sizeof s->receipt.invocation);
    s->state=LAS_STOPPED; return 1;
}
int las_fd(const struct las *s) { return s && s->state==LAS_PENDING ? sd_bus_get_fd(s->bus):-1; }
int las_events(const struct las *s) { return s && s->state==LAS_PENDING ? sd_bus_get_events(s->bus):-1; }
int las_timeout(const struct las *s,uint64_t *usec) {
    uint64_t t=now(), bus=0;
    if (!s || !usec || s->state!=LAS_PENDING || !t || sd_bus_get_timeout(s->bus,&bus)<0) return -1;
    uint64_t until=bus<s->deadline ? bus:s->deadline;
    *usec=until>t ? until-t:0; return 0;
}
enum las_status las_status(const struct las *s) { return s ? s->state:LAS_UNCERTAIN; }
enum las_reason las_reason(const struct las *s) { return s ? s->reason:LAS_R_NONE; }
int las_receipt(const struct las *s,struct las_receipt *r) { if (!s || !r || (s->state!=LAS_STOPPED && s->state!=LAS_RESET)) return -1; *r=s->receipt; return 0; }
void las_close(struct las *s) {
    if (!s) return;
    sd_bus_slot_unref(s->call); sd_bus_slot_unref(s->match); sd_bus_unref(s->bus); close(s->create); close(s->fd); free(s);
}
/* ---- Post-absence reset (README-STOP.md): Unit.ResetFailed on the
 * InvocationID path, only behind the caller's absence receipt. ---- */
static int absence(struct las *s) { return s->absent(s->absent_context,&s->c.entry)==1; }
int las_reset_open(const struct las_config *c,int (*absent)(void *,const struct lc_entry *),void *absent_context,struct las **out) {
    if (!out) return -1;
    *out=NULL;
    if (!absent || las_open(c,out)<0) return -1;
    struct las *s=*out;
    s->reset_mode=1; s->absent=absent; s->absent_context=absent_context;
    if (!absence(s)) { las_close(s); *out=NULL; return -1; }
    return 0;
}
/* After the call: the invocation is either gone (NoUnitForInvocationID: our
 * unit was garbage-collected; CollectMode=inactive collects it once reset) or
 * still exactly ours and now inactive. Anything else is UNCERTAIN. */
static enum las_reason reset_readback(struct las *s) {
    sd_bus_message *m=NULL, *reply=NULL; sd_bus_error e={0}; enum las_reason r=LAS_R_QUERY;
    if (!budget(s)) return LAS_R_DEADLINE;
    if (sd_bus_message_new_method_call(s->bus,&m,s->c.manager,MANAGER,MI,"GetUnitByInvocationID")<0 ||
        sd_bus_message_append_array(m,'y',s->invocation,16)<0) goto out;
    if (sd_bus_call(s->bus,m,0,&e,&reply)<0) {
        if (e.name && !strcmp(e.name,NO_INVOCATION)) { strcpy(s->receipt.state,"collected"); r=LAS_R_NONE; }
        goto out;
    }
    const char *p=NULL;
    if (sd_bus_message_read(reply,"o",&p)<=0 || !p || sd_bus_message_at_end(reply,1)<=0) goto out;
    r=strcmp(p,s->invocation_path) ? LAS_R_REPLACED:LAS_R_NONE;
out:
    sd_bus_error_free(&e); sd_bus_message_unref(reply); sd_bus_message_unref(m);
    if (r || !strcmp(s->receipt.state,"collected")) return r;
    if ((r=verify(s,AFTER))) return r; /* same path, Id, InvocationID, cgroup, no job */
    return strcmp(s->receipt.state,"inactive") ? LAS_R_STATE:LAS_R_NONE;
}
int las_reset(struct las *s) {
    if (!s || !s->reset_mode || s->state!=LAS_NEW) return -1;
    s->state=LAS_UNCERTAIN; /* consumed even by pre-RESET failures; one attempt per record */
    enum las_reason r; sd_bus_message *reply=NULL; sd_bus_error e={0};
    uint64_t t=now();
    if (!t) { r=LAS_R_DEADLINE; goto fail; }
    s->deadline=t+ATTEMPT_US;
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    if (!absence(s)) { r=LAS_R_ABSENCE; goto fail; }
    if (!create_unchanged(s)) { r=LAS_R_CREATE; goto fail; }
    if (sd_bus_new(&s->bus)<0 || sd_bus_set_address(s->bus,"unix:path=/run/dbus/system_bus_socket")<0 ||
        sd_bus_set_bus_client(s->bus,1)<0 || sd_bus_start(s->bus)<0) { r=LAS_R_BUS; goto fail; }
    /* 1. Before anything durable: still exactly our stopped incarnation. */
    if ((r=owner(s)) || (r=verify(s,AFTER))) goto fail;
    /* 2. Durable RESET intent in the reset record before the call. */
    char line[512];
    (void)snprintf(line,sizeof line,"RESET v1 %llu %s %s %s %s %s %u\n",(unsigned long long)s->c.entry.slot,s->c.entry.launch,
        s->unit,s->c.bus_id,s->c.manager,s->c.invocation,s->c.job);
    if (!journal_empty(s->fd) || journal(s,line)<0) { r=LAS_R_JOURNAL; goto fail; }
    /* 3. Immediately before acting: authority, absence receipt, create
     *    evidence, owner and the exact stopped incarnation. */
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    if (!absence(s)) { r=LAS_R_ABSENCE; goto fail; }
    if (!create_unchanged(s)) { r=LAS_R_CREATE; goto fail; }
    if ((r=owner(s)) || (r=verify(s,AFTER))) goto fail;
    /* 4. Typed Unit.ResetFailed() on the invocation path: systemd resolves it
     *    only while this invocation exists, so a replacement is never reset. */
    if (!budget(s)) { r=LAS_R_DEADLINE; goto fail; }
    if (sd_bus_call_method(s->bus,s->c.manager,s->invocation_path,UI,"ResetFailed",&e,&reply,"")<0) {
        r=e.name && !strcmp(e.name,NO_INVOCATION) ? LAS_R_REPLACED:LAS_R_RESET; goto fail;
    }
    if (sd_bus_message_at_end(reply,1)<=0) { r=LAS_R_RESET; goto fail; }
    /* 5. Correlated outcome for this invocation, bracketed by owner checks. */
    if ((r=reset_readback(s)) || (r=owner(s))) goto fail;
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    t=now(); if (!t || t>=s->deadline) { r=LAS_R_DEADLINE; goto fail; }
    (void)snprintf(line,sizeof line,"RESET-DONE %s %s\n",s->c.invocation,s->receipt.state);
    if (journal(s,line)<0) { r=LAS_R_JOURNAL; goto fail; }
    if (!held(s)) { r=LAS_R_AUTHORITY; goto fail; }
    memcpy(s->receipt.invocation,s->c.invocation,sizeof s->receipt.invocation);
    sd_bus_error_free(&e); sd_bus_message_unref(reply);
    s->state=LAS_RESET; return 1;
fail:
    sd_bus_error_free(&e); sd_bus_message_unref(reply);
    return terminal(s,r);
}
