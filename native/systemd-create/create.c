#define _GNU_SOURCE
#include "create.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
/* Public stable libsystemd ABI; no internal structs. */
typedef struct sd_bus sd_bus;
typedef struct sd_bus_message sd_bus_message;
typedef struct sd_bus_slot sd_bus_slot;
typedef union { uint8_t bytes[16]; uint64_t qwords[2]; } sd_id128_t;
typedef struct { const char *name, *message; int _need_free; } sd_bus_error;
typedef int (*sd_bus_message_handler_t)(sd_bus_message *, void *, sd_bus_error *);
extern int sd_bus_get_fd(sd_bus *);
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
extern int sd_bus_message_open_container(sd_bus_message *,char,const char *);
extern int sd_bus_message_close_container(sd_bus_message *);
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
#define MANAGER "/org/freedesktop/systemd1"
#define MI "org.freedesktop.systemd1.Manager"
#define UI "org.freedesktop.systemd1.Unit"
#define SI "org.freedesktop.systemd1.Service"
#define KEEPER "/usr/libexec/step-container-keeper"
struct lsc {
    struct lsc_config c;
    int fd;
    enum lsc_status state;
    sd_bus *bus;
    sd_bus_slot *call, *match;
    char unit[100], job_path[128], event_path[128];
    unsigned event_job;
    int got_reply, got_event;
    uint64_t deadline;
    struct lsc_receipt receipt;
};
static uint64_t now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC,&t)<0) return 0;
    return (uint64_t)t.tv_sec*1000000+(uint64_t)t.tv_nsec/1000;
}
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
static int held(struct lsc *s) { return s->c.exclusive(s->c.context,&s->c.entry)==1; }
/* Expected manager unique bus name, e.g. ":1.42". Strict digits-dot-digits only:
 * it is interpolated into a D-Bus match rule, so quotes/commas must never pass. */
static int unique_name(const char *p,size_t max) {
    size_t n=strnlen(p,max);
    if (n<4 || n>=max || p[0]!=':') return 0;
    size_t i=1, dots=0, run=0;
    for (;i<n;i++) {
        if (p[i]>='0' && p[i]<='9') { run++; continue; }
        if (p[i]!='.' || !run) return 0;
        dots++; run=0;
    }
    return dots==1 && run>0;
}
static int journal(struct lsc *s,const char *line) {
    size_t n=strlen(line), off=0;
    while (off<n) { ssize_t r=write(s->fd,line+off,n-off); if (r<0 && errno==EINTR) continue; if (r<=0) return -1; off+=(size_t)r; }
    return fsync(s->fd);
}
static int keeper_safe(void) {
#ifdef LSC_TESTING
    return 1; /* compiled ONLY into fake-bus fixture, never into archive */
#else
    int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    const char *parts[]={"usr","libexec","step-container-keeper"};
    struct stat st;
    if (fd<0) return 0;
    for (size_t i=0;i<4;i++) {
        if (fstat(fd,&st)<0 || st.st_uid!=0 || (st.st_mode&022) ||
            (i<3 ? !S_ISDIR(st.st_mode):(!S_ISREG(st.st_mode) || !(st.st_mode&0111) || st.st_nlink!=1))) { close(fd); return 0; }
        if (i==3) break;
        int next=openat(fd,parts[i],O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(i<2 ? O_DIRECTORY:0));
        close(fd); fd=next; if (fd<0) return 0;
    }
    close(fd); return 1;
#endif
}
static int owner(struct lsc *s) {
    struct ucred peer; socklen_t length=sizeof peer;
    int fd=sd_bus_get_fd(s->bus);
    if (fd<0 || getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length)<0 || length!=sizeof peer || peer.uid!=0) return 0;
    sd_id128_t id; char bus_id[33]; sd_bus_message *m=NULL; const char *name=NULL; unsigned uid=1;
    if (sd_bus_get_bus_id(s->bus,&id)<0) return 0;
    for (size_t i=0;i<16;i++) (void)snprintf(bus_id+2*i,3,"%02x",(unsigned)id.bytes[i]);
    if (strcmp(bus_id,s->c.bus_id)) return 0;
    int r=sd_bus_call_method(s->bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetNameOwner",NULL,&m,"s","org.freedesktop.systemd1");
    int ok=r>=0 && sd_bus_message_read(m,"s",&name)>0 && name && !strcmp(name,s->c.manager) && sd_bus_message_at_end(m,1)>0;
    sd_bus_message_unref(m); m=NULL; if (!ok) return 0;
    r=sd_bus_call_method(s->bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetConnectionUnixUser",NULL,&m,"s",s->c.manager);
    ok=r>=0 && sd_bus_message_read(m,"u",&uid)>0 && uid==0 && sd_bus_message_at_end(m,1)>0;
    sd_bus_message_unref(m); return ok;
}
static int job_number(const char *path,unsigned *out) {
    const char prefix[]="/org/freedesktop/systemd1/job/";
    if (!path || strncmp(path,prefix,sizeof prefix-1)) return 0;
    const char *p=path+sizeof prefix-1; if (*p<'1' || *p>'9') return 0;
    uint64_t n=0;
    for (;*p;p++) { if (*p<'0' || *p>'9' || n>429496729U) return 0; n=n*10+(unsigned)(*p-'0'); if (n>UINT32_MAX) return 0; }
    *out=(unsigned)n; return 1;
}
static int method_reply(sd_bus_message *m,void *ctx,sd_bus_error *err) {
    (void)err; struct lsc *s=ctx; const char *path=NULL;
    if (s->state!=LSC_PENDING) return 0;
    if (sd_bus_message_is_method_error(m,NULL)>0 || sd_bus_message_read(m,"o",&path)<=0 ||
        sd_bus_message_at_end(m,1)<=0 || !job_number(path,&s->receipt.job) || strlen(path)>=sizeof s->job_path) { s->state=LSC_UNCERTAIN; return 0; }
    strcpy(s->job_path,path); char line[180]; (void)snprintf(line,sizeof line,"JOB %u %s\n",s->receipt.job,path);
    if (journal(s,line)<0) s->state=LSC_UNCERTAIN; else s->got_reply=1;
    return 0;
}
static int removed(sd_bus_message *m,void *ctx,sd_bus_error *err) {
    (void)err; struct lsc *s=ctx; unsigned job=0, parsed=0; const char *path=NULL,*unit=NULL,*result=NULL;
    if (s->state!=LSC_PENDING) return 0;
    if (sd_bus_message_read(m,"uoss",&job,&path,&unit,&result)<=0 || sd_bus_message_at_end(m,1)<=0 || !unit) { s->state=LSC_UNCERTAIN; return 0; }
    if (strcmp(unit,s->unit)) return 0;
    if (!job_number(path,&parsed) || parsed!=job || strlen(path)>=sizeof s->event_path || !result || strcmp(result,"done") || s->got_event) { s->state=LSC_UNCERTAIN; return 0; }
    s->event_job=job; strcpy(s->event_path,path); s->got_event=1; return 0;
}
static int prop(sd_bus_message *m,const char *name,const char *type,const void *value) {
    if (sd_bus_message_open_container(m,'r',"sv")<0 || sd_bus_message_append(m,"s",name)<0 || sd_bus_message_open_container(m,'v',type)<0) return -1;
    int r=0;
    if (*type=='s') r=sd_bus_message_append(m,"s",(const char *)value);
    else if (*type=='b') r=sd_bus_message_append(m,"b",*(const int *)value);
    else r=sd_bus_message_append(m,"t",*(const uint64_t *)value);
    return r<0 || sd_bus_message_close_container(m)<0 || sd_bus_message_close_container(m)<0 ? -1:0;
}
static int build(struct lsc *s,sd_bus_message **out) {
    sd_bus_message *m=NULL; int no=0,yes=1; uint64_t memory=536870912,tasks=64,cpu=1000000;
    if (sd_bus_message_new_method_call(s->bus,&m,s->c.manager,MANAGER,MI,"StartTransientUnit")<0) return -1;
    *out=m;
    if (sd_bus_message_append(m,"ss",s->unit,"fail")<0 || sd_bus_message_open_container(m,'a',"(sv)")<0 ||
        prop(m,"Type","s","exec")<0 || prop(m,"Restart","s","no")<0 || prop(m,"Delegate","b",&no)<0 ||
        prop(m,"KillMode","s","control-group")<0 || prop(m,"MemoryMax","t",&memory)<0 ||
        prop(m,"TasksMax","t",&tasks)<0 || prop(m,"CPUQuotaPerSecUSec","t",&cpu)<0 ||
        prop(m,"NoNewPrivileges","b",&yes)<0 || prop(m,"User","s","root")<0 || prop(m,"Group","s","root")<0 ||
        prop(m,"StandardInput","s","null")<0 || prop(m,"StandardOutput","s","null")<0 || prop(m,"StandardError","s","null")<0 ||
        sd_bus_message_open_container(m,'r',"sv")<0 || sd_bus_message_append(m,"s","ExecStart")<0 ||
        sd_bus_message_open_container(m,'v',"a(sasb)")<0 || sd_bus_message_open_container(m,'a',"(sasb)")<0 ||
        sd_bus_message_open_container(m,'r',"sasb")<0 || sd_bus_message_append(m,"s",KEEPER)<0 ||
        sd_bus_message_open_container(m,'a',"s")<0 || sd_bus_message_append(m,"s",KEEPER)<0 || sd_bus_message_close_container(m)<0 ||
        sd_bus_message_append(m,"b",0)<0 || sd_bus_message_close_container(m)<0 || sd_bus_message_close_container(m)<0 ||
        sd_bus_message_close_container(m)<0 || sd_bus_message_close_container(m)<0 || sd_bus_message_close_container(m)<0 ||
        sd_bus_message_open_container(m,'a',"(sa(sv))")<0 || sd_bus_message_close_container(m)<0) return -1;
    return 0;
}
int lsc_open(const struct lsc_config *c,struct lsc **out) {
    if (!out) return -1;
    *out=NULL;
    if (!c || !c->exclusive || !c->entry.slot || c->entry.state!=LC_STARTING || !hex(c->entry.epoch) || !hex(c->entry.launch) ||
        !hex(c->bus_id) || !uuid(c->entry.boot) || !uuid(c->entry.user) || !uuid(c->entry.workspace) ||
        !unique_name(c->manager,sizeof c->manager)) return -1;
    char container[90]; (void)snprintf(container,sizeof container,"step-lc-%s-%016llx",c->entry.epoch,(unsigned long long)c->entry.slot);
    if (strnlen(c->entry.container,sizeof c->entry.container)>=sizeof c->entry.container || strcmp(container,c->entry.container)) return -1;
    struct stat st;
    uid_t uid=0;
#ifdef LSC_TESTING
    uid=getuid();
#endif
    if (fstat(c->journal_fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=uid || (st.st_mode&0777)!=0600 || st.st_nlink>1 || st.st_size ||
        (fcntl(c->journal_fd,F_GETFL)&O_ACCMODE)!=O_RDWR || !keeper_safe() || c->exclusive(c->context,&c->entry)!=1) return -1;
    int linked=st.st_nlink==1;
#ifdef LSC_TESTING
    linked=st.st_nlink<=1;
#endif
    if (!linked) return -1;
    struct lsc *s=calloc(1,sizeof *s); if (!s) return -1;
    s->fd=fcntl(c->journal_fd,F_DUPFD_CLOEXEC,3);
    if (s->fd<0) { free(s); return -1; }
    if (flock(s->fd,LOCK_EX|LOCK_NB)<0 || fstat(s->fd,&st)<0 || st.st_size || lseek(s->fd,0,SEEK_SET)<0) { close(s->fd); free(s); return -1; }
    s->c=*c; (void)snprintf(s->unit,sizeof s->unit,"%s.service",container); *out=s; return 0;
}
int lsc_begin(struct lsc *s) {
    if (!s || s->state!=LSC_NEW) return -1;
    s->state=LSC_UNCERTAIN; /* consume even pre-enqueue failures; no repair/retry */
    sd_bus_message *m=NULL,*sub=NULL;
    if (!held(s) || !keeper_safe() || sd_bus_new(&s->bus)<0 ||
        sd_bus_set_address(s->bus,"unix:path=/run/dbus/system_bus_socket")<0 || sd_bus_set_bus_client(s->bus,1)<0 ||
        sd_bus_start(s->bus)<0 || sd_bus_set_method_call_timeout(s->bus,2000000)<0 || !owner(s)) goto fail;
    char match[512]; (void)snprintf(match,sizeof match,"type='signal',sender='%s',path='%s',interface='%s',member='JobRemoved'",s->c.manager,MANAGER,MI);
    if (sd_bus_add_match(s->bus,&s->match,match,removed,s)<0 ||
        sd_bus_call_method(s->bus,s->c.manager,MANAGER,MI,"Subscribe",NULL,&sub,"")<0 || sd_bus_message_at_end(sub,1)<=0 || build(s,&m)<0) goto fail;
    char line[1024];
    (void)snprintf(line,sizeof line,"INTENT v1 %llu %llu %s %s %s %s %s %s %s %s\n",(unsigned long long)s->c.entry.slot,(unsigned long long)s->c.entry.principal,
        s->c.entry.epoch,s->c.entry.boot,s->c.entry.user,s->c.entry.workspace,s->c.entry.launch,s->unit,s->c.bus_id,s->c.manager);
    struct stat st;
    if (fstat(s->fd,&st)<0 || st.st_size!=0 || journal(s,line)<0 || !held(s) || !owner(s)) goto fail;
    uint64_t t=now(); if (!t) goto fail;
    s->deadline=t+5000000; s->state=LSC_PENDING;
    if (sd_bus_call_async(s->bus,&s->call,m,method_reply,s,2000000)<0) goto fail;
    sd_bus_message_unref(m); sd_bus_message_unref(sub); return 0;
fail:
    s->state=LSC_UNCERTAIN; sd_bus_message_unref(m); sd_bus_message_unref(sub); return -1;
}
/* sd_bus_get_property leaves the cursor INSIDE its variant. Check inner end,
 * exit it, then reject trailing outer arguments. complete=1 inside always fails. */
static int property_end(sd_bus_message *m) {
    return sd_bus_message_at_end(m,0)>0 && sd_bus_message_exit_container(m)>0 && sd_bus_message_at_end(m,1)>0;
}
static int string_prop(struct lsc *s,const char *path,const char *iface,const char *key,char *out,size_t n) {
    sd_bus_message *m=NULL; const char *v=NULL;
    int r=sd_bus_get_property(s->bus,s->c.manager,path,iface,key,NULL,&m,"s");
    int ok=r>=0 && sd_bus_message_read(m,"s",&v)>0 && v && strlen(v)<n && property_end(m);
    if (ok) strcpy(out,v);
    sd_bus_message_unref(m); return ok;
}
static int observe(struct lsc *s) {
    sd_bus_message *m=NULL; const char *p=NULL; char path[512],state[32];
    if (!held(s) || !owner(s) || sd_bus_call_method(s->bus,s->c.manager,MANAGER,MI,"GetUnit",NULL,&m,"s",s->unit)<0) return 0;
    int ok=sd_bus_message_read(m,"o",&p)>0 && p && !strncmp(p,"/org/freedesktop/systemd1/unit/",30) && strlen(p)<sizeof path && sd_bus_message_at_end(m,1)>0;
    if (ok) strcpy(path,p);
    sd_bus_message_unref(m); m=NULL; if (!ok) return 0;
    if (!string_prop(s,path,UI,"ActiveState",state,sizeof state) || strcmp(state,"active") ||
        !string_prop(s,path,SI,"ControlGroup",s->receipt.cgroup,sizeof s->receipt.cgroup)) return 0;
    char expected[512]; (void)snprintf(expected,sizeof expected,"/system.slice/%s",s->unit);
    if (strcmp(expected,s->receipt.cgroup)) return 0;
    if (sd_bus_get_property(s->bus,s->c.manager,path,UI,"InvocationID",NULL,&m,"ay")<0) return 0;
    const void *bytes=NULL; size_t n=0;
    ok=sd_bus_message_read_array(m,'y',&bytes,&n)>0 && n==16 && bytes && property_end(m);
    if (ok) for (size_t i=0;i<16;i++) (void)snprintf(s->receipt.invocation+2*i,3,"%02x",(unsigned)((const unsigned char *)bytes)[i]);
    sd_bus_message_unref(m); m=NULL; if (!ok || !hex(s->receipt.invocation)) return 0;
    unsigned job=1;
    if (sd_bus_get_property(s->bus,s->c.manager,path,UI,"Job",NULL,&m,"(uo)")<0) return 0;
    ok=sd_bus_message_read(m,"(uo)",&job,&p)>0 && job==0 && p && !strcmp(p,"/") && property_end(m);
    sd_bus_message_unref(m);
    return ok && held(s) && owner(s);
}
int lsc_poll(struct lsc *s) {
    if (!s || s->state!=LSC_PENDING) return -1;
    uint64_t t=now();
    if (!t || t>=s->deadline || !held(s)) goto uncertain;
    /* Bounded dispatch prevents hostile signal floods starving deadline checks. */
    for (unsigned i=0;i<32;i++) { int r=sd_bus_process(s->bus,NULL); if (r<0) goto uncertain; if (!r || s->state!=LSC_PENDING) break; }
    if (s->state!=LSC_PENDING) return -1;
    if (s->got_reply && s->got_event) {
        if (s->receipt.job!=s->event_job || strcmp(s->job_path,s->event_path) || !observe(s) || now()>=s->deadline) goto uncertain;
        char line[768]; (void)snprintf(line,sizeof line,"ANCHOR %u %s %s\n",s->receipt.job,s->receipt.invocation,s->receipt.cgroup);
        if (journal(s,line)<0 || !held(s)) goto uncertain;
        s->state=LSC_ANCHORED; return 1;
    }
    return 0;
uncertain:
    s->state=LSC_UNCERTAIN; return -1;
}
enum lsc_status lsc_status(const struct lsc *s) { return s ? s->state:LSC_UNCERTAIN; }
int lsc_receipt(const struct lsc *s,struct lsc_receipt *r) { if (!s || !r || s->state!=LSC_ANCHORED) return -1; *r=s->receipt; return 0; }
void lsc_close(struct lsc *s) {
    if (!s) return;
    sd_bus_slot_unref(s->call); sd_bus_slot_unref(s->match); sd_bus_unref(s->bus); close(s->fd); free(s);
}
