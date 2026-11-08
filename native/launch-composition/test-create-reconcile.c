/* Startup reconciliation of systemd-create journals: actual parser, actual
 * observer proofs (lso), actual composition owner and lifecycle ledger.
 * Only the read-only bus snapshot seam is fake. No unit is created/stopped. */
#define COMPOSITION_TEST_MAIN composition_suite_main
#include "test-composition.c"
#include "create-reconcile.h"
#include <sys/file.h>
#define BUS "dddddddddddddddddddddddddddddddd"
#define MGR ":1.42"
#define INV "cccccccccccccccccccccccccccccccc"
struct rfx {
    struct composed_fixture f;
    struct lc_entry e;
    struct lcr_config c;
    struct lso_snapshot s;
    int fenced, error, snapshots, events_calls;
    char unit[100], intent[600], job[80], anchor[300], full[1024];
    size_t intent_n, job_n, full_n;
};
static int rfence(void *ctx,const struct lc_entry *e) {
    struct rfx *f=ctx; return exact(e,&f->e) ? f->fenced:0;
}
static int rsnap(void *ctx,const char *unit,const char *manager,struct lso_snapshot *s) {
    struct rfx *f=ctx; f->snapshots++;
    assert(!strcmp(unit,f->unit)); assert(strlen(manager)<128);
    *s=f->s; return f->error ? -1:0;
}
static int revents(void *ctx,int group,int *populated) {
    struct rfx *f=ctx; f->events_calls++;
    int fd=openat(group,"cgroup.events",O_RDONLY|O_CLOEXEC); if (fd<0) return -1;
    char b[64]={0}; ssize_t n=read(fd,b,sizeof b-1); close(fd);
    if (n<=0) return -1;
    if (!strcmp(b,"populated 0\n")) { *populated=0; return 0; }
    if (!strcmp(b,"populated 1\n")) { *populated=1; return 0; }
    return -1;
}
static int rremoved(void *ctx,int group) {
    (void)ctx; struct stat st; return fstat(group,&st)<0 ? -1:st.st_nlink==0;
}
static const struct lso_ops OPS={rsnap,revents,rremoved};
static void put_journal(struct rfx *f,const char *bytes,size_t n) {
    assert(ftruncate(f->c.journal_fd,0)==0);
    assert(n==0 || pwrite(f->c.journal_fd,bytes,n,0)==(ssize_t)n);
}
static void events(struct rfx *f,const char *text) {
    int fd=openat(f->c.cgroup_fd,"cgroup.events",O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC,0600);
    assert(fd>=0 && write(fd,text,strlen(text))==(ssize_t)strlen(text)); close(fd);
}
static void rinit(struct rfx *f) {
    memset(f,0,sizeof *f); init(&f->f,1);
    assert(lco_open(&f->f.config,&f->f.owner)==0);
    assert(lco_prepare(f->f.owner,&f->f.spec,&f->e)==0);
    assert(lco_detach(f->f.owner)==0);
    /* Restart: the reopened owner fences the crashed STARTING/RESERVED slot. */
    lco_close(f->f.owner); f->f.owner=NULL;
    assert(lco_open(&f->f.config,&f->f.owner)==0);
    assert(lco_get(f->f.owner,1,&f->e)==0 && f->e.state==LC_FENCED);
    assert(snprintf(f->unit,sizeof f->unit,"%s.service",f->e.container)>0);
    f->intent_n=(size_t)snprintf(f->intent,sizeof f->intent,"INTENT v1 %llu %llu %s %s %s %s %s %s %s %s\n",
        (unsigned long long)f->e.slot,(unsigned long long)f->e.principal,f->e.epoch,f->e.boot,f->e.user,
        f->e.workspace,f->e.launch,f->unit,BUS,MGR);
    f->job_n=(size_t)snprintf(f->job,sizeof f->job,"JOB 7 /org/freedesktop/systemd1/job/7\n");
    (void)snprintf(f->anchor,sizeof f->anchor,"ANCHOR 7 %s /system.slice/%s\n",INV,f->unit);
    f->full_n=(size_t)snprintf(f->full,sizeof f->full,"%s%s%s",f->intent,f->job,f->anchor);
    int journal=openat(f->f.quota.base,"create.journal",O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);
    assert(journal>=0);
    assert(mkdirat(f->f.quota.base,"original-cgroup",0700)==0);
    f->c=(struct lcr_config){.owner=f->f.owner,.slot=1,.journal_fd=journal,
        .cgroup_fd=openat(f->f.quota.base,"original-cgroup",O_RDONLY|O_DIRECTORY|O_CLOEXEC),
        .boot_fd=openat(f->f.quota.base,"boot-id",O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600),
        .trusted_uid=geteuid(),.context=f,.lifetime_fenced=rfence};
    assert(f->c.cgroup_fd>=0 && f->c.boot_fd>=0);
    char boot[38]; assert(snprintf(boot,sizeof boot,"%s\n",f->e.boot)==37);
    assert(write(f->c.boot_fd,boot,37)==37);
    struct stat st; assert(fstat(f->c.cgroup_fd,&st)==0);
    f->c.cgroup_device=st.st_dev; f->c.cgroup_inode=st.st_ino; f->fenced=1;
    put_journal(f,f->full,f->full_n);
    /* Default observation: the exact anchor is live. */
    strcpy(f->s.bus_id,BUS); strcpy(f->s.manager,MGR); strcpy(f->s.invocation,INV);
    (void)snprintf(f->s.cgroup,sizeof f->s.cgroup,"/system.slice/%s",f->unit);
    strcpy(f->s.state,"active");
    events(f,"populated 1\n");
}
/* Absence-ready observation: failed anchor, empty original subtree. */
static void absent_ready(struct rfx *f) { strcpy(f->s.state,"failed"); events(f,"populated 0\n"); }
static void rfinish(struct rfx *f) {
    if (f->c.cgroup_fd>=0) close(f->c.cgroup_fd);
    close(f->c.boot_fd); close(f->c.journal_fd); finish(&f->f);
}
static enum lc_state ledger_state(struct rfx *f) {
    struct lc_entry e; assert(lco_get(f->f.owner,1,&e)==0); return e.state;
}
static char *journal_bytes(struct rfx *f,size_t *n) {
    static char b[4096]; ssize_t r=pread(f->c.journal_fd,b,sizeof b,0); assert(r>=0); *n=(size_t)r; return b;
}
/* One fresh handle, one reconciliation. */
static enum lcr_verdict once(struct rfx *f,enum lcr_reason *why) {
    size_t before_n; char before[4096]; memcpy(before,journal_bytes(f,&before_n),sizeof before);
    struct lcr *h=NULL; assert(lcr_open_with_ops(&f->c,&OPS,f,&h)==0);
    enum lcr_verdict v=(enum lcr_verdict)77; enum lcr_reason r=(enum lcr_reason)77;
    assert(lcr_reconcile(h,&v,&r)==0); lcr_close(h);
    size_t after_n; char *after=journal_bytes(f,&after_n);
    assert(after_n==before_n && !memcmp(after,before,before_n)); /* never writes */
    if (why) *why=r;
    return v;
}
static void expect_unknown(struct rfx *f,enum lcr_reason reason) {
    enum lcr_reason r; enum lcr_verdict v=once(f,&r);
    if (v!=LCR_UNKNOWN || r!=reason) { fprintf(stderr,"verdict %d reason %d, want UNKNOWN %d\n",v,r,reason); abort(); }
    assert(ledger_state(f)==LC_FENCED);
}
static void anchored(void) {
    struct rfx f; rinit(&f);
    enum lcr_reason r; assert(once(&f,&r)==LCR_ANCHORED && r==LCR_R_NONE);
    assert(ledger_state(&f)==LC_FENCED && f.events_calls==0);
    /* Capacity retained: a new workspace cannot reserve while the anchor lives. */
    fresh_spec(&f.f,2); memcpy(f.f.spec.workspace,ws_b,37);
    struct lc_entry next; assert(lco_prepare(f.f.owner,&f.f.spec,&next)<0);
    rfinish(&f);
}
static void absent_proven(void) {
    struct rfx f; rinit(&f); absent_ready(&f);
    struct lcr *h=NULL; assert(lcr_open_with_ops(&f.c,&OPS,&f,&h)==0);
    enum lcr_verdict v; enum lcr_reason r;
    /* Absence proven, but the failed unit is still loaded: cleanup unproven. */
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && r==LCR_R_UNPROVEN);
    assert(ledger_state(&f)==LC_FENCED && f.events_calls==1);
    fresh_spec(&f.f,2); memcpy(f.f.spec.workspace,ws_b,37);
    struct lc_entry next; assert(lco_prepare(f.f.owner,&f.f.spec,&next)<0);
    /* Metadata gone (reset + cgroup removed): retained receipt, separate cleanup. */
    f.s.missing=1; f.s.invocation[0]=0; f.s.cgroup[0]=0; f.s.state[0]=0;
    assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0);
    assert(unlinkat(f.f.quota.base,"original-cgroup",AT_REMOVEDIR)==0);
    f.fenced=0; /* lost lifetime fence still blocks release */
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && r==LCR_R_UNPROVEN && ledger_state(&f)==LC_FENCED);
    f.fenced=1;
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_ABSENT_PROVEN && r==LCR_R_NONE);
    assert(ledger_state(&f)==LC_RELEASED && f.events_calls==1);
    /* Second pass: already released is reported distinctly, never as a fresh proof. */
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_ALREADY_RELEASED && r==LCR_R_RELEASED);
    lcr_close(h);
    assert(once(&f,&r)==LCR_ALREADY_RELEASED && r==LCR_R_RELEASED);
    assert(lco_prepare(f.f.owner,&f.f.spec,&next)==0 && strcmp(next.container,f.e.container));
    rfinish(&f);
}
static void collected_new_handle(void) {
    /* A fresh handle (e.g. after another crash) has no absence receipt. */
    struct rfx f; rinit(&f);
    f.s.missing=1; f.s.invocation[0]=0; f.s.cgroup[0]=0; f.s.state[0]=0;
    assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0);
    assert(unlinkat(f.f.quota.base,"original-cgroup",AT_REMOVEDIR)==0);
    expect_unknown(&f,LCR_R_COLLECTED); assert(f.events_calls==0);
    rfinish(&f);
}
enum { LIVE, ABSENT_READY };
static void unknown_case(unsigned which) {
    struct rfx f; rinit(&f);
    enum lcr_reason want=LCR_R_UNPROVEN;
    switch (which) {
    case 0: put_journal(&f,"",0); want=LCR_R_EMPTY; break;
    case 1: put_journal(&f,f.intent,f.intent_n); want=LCR_R_NO_JOB; break;
    case 2: put_journal(&f,f.intent,f.intent_n); absent_ready(&f); f.s.missing=1; want=LCR_R_NO_JOB; break;
    case 3: put_journal(&f,f.full,f.intent_n+f.job_n); want=LCR_R_NO_ANCHOR; break;
    case 4: put_journal(&f,f.full,f.intent_n+f.job_n); absent_ready(&f); want=LCR_R_NO_ANCHOR; break;
    case 5: put_journal(&f,f.full,f.intent_n+f.job_n); absent_ready(&f); f.s.missing=1; want=LCR_R_NO_ANCHOR; break;
    case 6: assert(pwrite(f.c.boot_fd,"0",1,0)==1); want=LCR_R_BOOT; break;
    case 7: assert(pwrite(f.c.boot_fd,"0",1,0)==1); absent_ready(&f); want=LCR_R_BOOT; break;
    case 8: f.s.bus_id[0]='e'; want=LCR_R_BUS; break;
    case 9: f.s.bus_id[0]='e'; absent_ready(&f); want=LCR_R_BUS; break;
    case 10: strcpy(f.s.manager,":1.43"); want=LCR_R_MANAGER; break;
    case 11: strcpy(f.s.manager,":1.43"); absent_ready(&f); want=LCR_R_MANAGER; break;
    case 12: f.s.missing=1; want=LCR_R_COLLECTED; break;
    case 13: f.s.invocation[0]='d'; want=LCR_R_INVOCATION; break;
    case 14: f.s.invocation[0]='d'; absent_ready(&f); want=LCR_R_INVOCATION; break;
    case 15: strcpy(f.s.cgroup,"/system.slice/other.service"); want=LCR_R_INVOCATION; break;
    case 16: strcpy(f.s.cgroup,"/system.slice/other.service"); absent_ready(&f); want=LCR_R_INVOCATION; break;
    case 17: f.s.job=9; want=LCR_R_TRANSIENT; break;
    case 18: absent_ready(&f); f.s.job=9; want=LCR_R_TRANSIENT; break;
    case 19: strcpy(f.s.state,"deactivating"); want=LCR_R_TRANSIENT; break;
    case 20: strcpy(f.s.state,"activating"); want=LCR_R_TRANSIENT; break;
    case 21: f.error=1; want=LCR_R_QUERY; break;
    case 22: f.error=1; absent_ready(&f); want=LCR_R_QUERY; break;
    case 23: memset(f.s.state,'a',sizeof f.s.state); want=LCR_R_QUERY; break;
    case 24: memset(f.s.invocation,'c',sizeof f.s.invocation); want=LCR_R_QUERY; break;
    case 25: memset(f.s.cgroup,'c',sizeof f.s.cgroup); want=LCR_R_QUERY; break;
    case 26: memset(f.s.bus_id,'d',sizeof f.s.bus_id); want=LCR_R_QUERY; break;
    case 27: memset(f.s.manager,'1',sizeof f.s.manager); want=LCR_R_QUERY; break;
    case 28: f.s.missing=2; want=LCR_R_QUERY; break;
    case 29: absent_ready(&f); close(f.c.cgroup_fd); f.c.cgroup_fd=-1; want=LCR_R_NO_PIN; break;
    case 30: absent_ready(&f); f.fenced=0; want=LCR_R_UNPROVEN; break;
    case 31: strcpy(f.s.state,"failed"); events(&f,"populated 1\n"); want=LCR_R_UNPROVEN; break;
    case 32: absent_ready(&f); assert(fchmod(f.c.journal_fd,0644)==0); want=LCR_R_JOURNAL; break;
    case 33: assert(linkat(f.f.quota.base,"create.journal",f.f.quota.base,"second-name",0)==0); want=LCR_R_JOURNAL; break;
    case 34: { char big[LCR_JOURNAL_MAX+1]; memset(big,'\n',sizeof big); put_journal(&f,big,sizeof big); want=LCR_R_JOURNAL; break; }
    case 35: f.c.trusted_uid=geteuid()+1; want=LCR_R_JOURNAL; break;
    case 36: absent_ready(&f); f.c.cgroup_inode++; want=LCR_R_UNPROVEN; break;
    case 37: { /* torn ANCHOR, unit live: never anchored */
        put_journal(&f,f.full,f.full_n-1); want=LCR_R_TORN; break; }
    case 38: { /* trailing extra line */
        char b[1100]; int n=snprintf(b,sizeof b,"%s%s",f.full,f.anchor); put_journal(&f,b,(size_t)n); want=LCR_R_GRAMMAR; break; }
    case 39: { /* INTENT for another principal */
        char b[1100]; memcpy(b,f.full,f.full_n+1); char *p=strstr(b," v1 1 "); assert(p); p+=6;
        assert(*p>='0' && *p<'9'); (*p)++;
        put_journal(&f,b,f.full_n); want=LCR_R_LEDGER; break; }
    case 40: assert(pwrite(f.c.boot_fd,"x",1,36)==1); want=LCR_R_BOOT; break;
    case 41: assert(fchmod(f.c.boot_fd,0666)==0); want=LCR_R_BOOT; break;
    case 45: { /* journal for another epoch, self-consistent unit: not this ledger slot */
        char b[1100]; memcpy(b,f.full,f.full_n+1);
        for (char *p=strstr(b,f.e.epoch);p;p=strstr(p+32,f.e.epoch)) p[31]=p[31]=='1' ? '2':'1';
        put_journal(&f,b,f.full_n); want=LCR_R_LEDGER; break; }
    case 42: assert(pwrite(f.c.boot_fd,"x",1,37)==1); want=LCR_R_BOOT; break; /* boot file longer */
    case 43: /* inactive (not failed) is a candidate too; cleanup still unproven */
        strcpy(f.s.state,"inactive"); events(&f,"populated 0\n"); want=LCR_R_UNPROVEN; break;
    case 44: { /* journal boot equals the current boot but not the ledger's */
        char b[1100]; memcpy(b,f.full,f.full_n+1); char *p=strstr(b,f.e.boot); assert(p); p[35]=p[35]=='1' ? '2':'1';
        char boot[38]; memcpy(boot,p,36); boot[36]='\n'; boot[37]=0; assert(pwrite(f.c.boot_fd,boot,37,0)==37);
        put_journal(&f,b,f.full_n); want=LCR_R_LEDGER; break; }
    default: abort();
    }
    expect_unknown(&f,want);
    if (which==31 || which==43) assert(f.events_calls==1); /* one absence observation, no re-observation */
    /* Incomplete/rejected journals and changed generations never reach the observer's proof. */
    if (which<=16 || (which>=21 && which<=28) || (which>=32 && which!=43)) assert(f.events_calls==0);
    if (which<=5 || (which>=32 && which<=35) || (which>=37 && which!=43)) assert(f.snapshots==0);
    rfinish(&f);
}
static void changed_after_open(void) {
    struct rfx f; rinit(&f);
    struct lcr *h=NULL; assert(lcr_open_with_ops(&f.c,&OPS,&f,&h)==0);
    enum lcr_verdict v; enum lcr_reason r;
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_ANCHORED);
    assert(pwrite(f.c.journal_fd,"d",1,(off_t)f.full_n-3)==1); /* same length, other bytes */
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && r==LCR_R_CHANGED);
    put_journal(&f,f.full,f.full_n); /* restoring does not clear the poison */
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && r==LCR_R_CHANGED);
    lcr_close(h); rfinish(&f);
}
static void open_refusals(void) {
    struct rfx f; rinit(&f); struct lcr *h=(struct lcr *)1;
    /* An in-flight creator holds the journal lock through another description. */
    int other=openat(f.f.quota.base,"create.journal",O_RDWR|O_CLOEXEC); assert(other>=0);
    assert(flock(other,LOCK_EX|LOCK_NB)==0);
    assert(lcr_open_with_ops(&f.c,&OPS,&f,&h)<0 && errno==EWOULDBLOCK && h==NULL);
    close(other);
    /* The handle holds its own lock for its lifetime. */
    assert(lcr_open_with_ops(&f.c,&OPS,&f,&h)==0);
    other=openat(f.f.quota.base,"create.journal",O_RDWR|O_CLOEXEC); assert(other>=0);
    assert(flock(other,LOCK_EX|LOCK_NB)<0 && errno==EWOULDBLOCK); close(other);
    lcr_close(h);
    other=openat(f.f.quota.base,"create.journal",O_RDWR|O_CLOEXEC); assert(other>=0);
    assert(flock(other,LOCK_EX|LOCK_NB)==0); close(other); /* close releases the lock */
    int wo=openat(f.f.quota.base,"create.journal",O_WRONLY|O_CLOEXEC); assert(wo>=0);
    struct lcr_config c=f.c; c.journal_fd=wo; h=(struct lcr *)1;
    assert(lcr_open_with_ops(&c,&OPS,&f,&h)<0 && h==NULL); close(wo);
    c=f.c; c.owner=NULL; assert(lcr_open_with_ops(&c,&OPS,&f,&h)<0);
    c=f.c; c.slot=0; assert(lcr_open_with_ops(&c,&OPS,&f,&h)<0);
    struct lso_ops none={0}; assert(lcr_open_with_ops(&f.c,&none,&f,&h)<0);
    assert(lcr_open_with_ops(&f.c,NULL,&f,&h)<0);
    assert(lcr_open_with_ops(&f.c,&OPS,&f,NULL)<0);
    /* Production entry refuses a non-root trust root before any observation. */
    assert(lcr_open(&f.c,&h)<0 && errno==EPERM && h==NULL);
    /* Unknown slot: caller error, verdict UNKNOWN, nothing released. */
    c=f.c; c.slot=2; assert(lcr_open_with_ops(&c,&OPS,&f,&h)==0);
    enum lcr_verdict v=LCR_ANCHORED; enum lcr_reason r;
    assert(lcr_reconcile(h,&v,&r)<0 && v==LCR_UNKNOWN); lcr_close(h);
    assert(lcr_reconcile(NULL,&v,&r)<0);
    assert(f.snapshots==0 && ledger_state(&f)==LC_FENCED);
    rfinish(&f);
}
/* Strict grammar: each variant otherwise names the live exact anchor. */
static void grammar(void) {
    struct rfx f; rinit(&f);
    char epoch[33], unit[100]; strcpy(epoch,f.e.epoch); strcpy(unit,f.unit);
    struct { const char *find, *repl; int line; } v[]={
        {"INTENT v1 1 ","INTENT v1 01 ",0}, {"INTENT v1 1 ","INTENT v1 0 ",0},
        {"INTENT v1 1 ","INTENT v1 18446744073709551616 ",0}, {"INTENT v1 ","INTENT v2 ",0},
        {"INTENT v1 ","INTENT  v1 ",0}, {"INTENT v1 ","intent v1 ",0}, {"INTENT v1 1 ","INTENT v1 1\t",0},
        {" " MGR "\n"," " MGR " \n",0}, {" " MGR "\n"," " MGR "\r\n",0}, {" " MGR "\n"," " MGR " x\n",0},
        {" " MGR "\n"," :1.42.3\n",0}, {" " MGR "\n"," 11.42\n",0}, {" " MGR "\n"," :1.\n",0}, {" " MGR "\n"," :.42\n",0},
        {" " MGR "\n"," :1.42",0},
        {" " BUS " "," " BUS "d ",0}, {" " BUS " "," DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD ",0},
        {" " BUS " "," 00000000000000000000000000000000 ",0},
        {".service "," .service ",0}, {".service ",".socket ",0},
        {"JOB 7 ","JOB 07 ",1}, {"JOB 7 ","JOB 0 ",1}, {"/job/7\n","/job/8\n",1}, {"/job/7\n","/job/7/\n",1},
        {"JOB 7 ","JOB 4294967296 ",1}, {"JOB 7 ","JOB  7 ",1}, {"systemd1/job/","systemd2/job/",1},
        {"ANCHOR 7 ","ANCHOR 8 ",2}, {"ANCHOR 7 ","ANCHOR 07 ",2},
        {" " INV " "," 00000000000000000000000000000000 ",2}, {" " INV " "," CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC ",2},
        {" " INV " "," " INV "c ",2}, {"/system.slice/","/user.slice/",2}, {"/system.slice/","/system.slice//",2},
        {".service\n",".service \n",2}, {".service\n",".service\n\n",2},
        {" " MGR "\n","\n",0}, {" /org/freedesktop/systemd1/job/7\n","\n",1}, {" /system.slice/","\n/system.slice/",2},
    };
    for (size_t i=0;i<sizeof v/sizeof *v;i++) {
        char lines[3][700]; strcpy(lines[0],f.intent); strcpy(lines[1],f.job); strcpy(lines[2],f.anchor);
        char *at=strstr(lines[v[i].line],v[i].find); assert(at);
        char tail[700]; strcpy(tail,at+strlen(v[i].find)); strcpy(at,v[i].repl); strcat(at,tail);
        char b[2200]; int n=snprintf(b,sizeof b,"%s%s%s",lines[0],lines[1],lines[2]);
        put_journal(&f,b,(size_t)n);
        enum lcr_reason r; enum lcr_verdict got=once(&f,&r);
        if (got!=LCR_UNKNOWN || (r!=LCR_R_GRAMMAR && r!=LCR_R_TORN)) { fprintf(stderr,"grammar %zu: %d/%d\n",i,got,r); abort(); }
    }
    /* Self-consistent whole-line variants: each would name the live anchor if
     * its single grammar rule were missing. */
    char lines[12][3][700]; size_t nl=0; char boot_bad[37];
    #define VARIANT(I,J,A) do { strcpy(lines[nl][0],I); strcpy(lines[nl][1],J); strcpy(lines[nl][2],A); nl++; } while (0)
    char in[700], jb[200], an[300];
    (void)snprintf(in,sizeof in,"INTENT v1 01 %llu %s %s %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,f.e.epoch,f.e.boot,
        f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    (void)snprintf(in,sizeof in,"INTENT v1 18446744073709551617 %llu %s %s %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,
        f.e.epoch,f.e.boot,f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    (void)snprintf(in,sizeof in,"INTENT v1 1 0%llu %s %s %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,f.e.epoch,f.e.boot,
        f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    strcpy(boot_bad,f.e.boot); boot_bad[8]='a';
    (void)snprintf(in,sizeof in,"INTENT v1 1 %llu %s %s %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,f.e.epoch,boot_bad,
        f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    strcpy(boot_bad,f.e.boot); boot_bad[0]='X';
    (void)snprintf(in,sizeof in,"INTENT v1 1 %llu %s %s %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,f.e.epoch,boot_bad,
        f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    (void)snprintf(in,sizeof in,"INTENT v1 1 %llu %s %sa %s %s %s %s %s %s\n",(unsigned long long)f.e.principal,f.e.epoch,f.e.boot,
        f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR); VARIANT(in,f.job,f.anchor);
    if (f.e.principal>=20) { /* digit check: "99:" would evaluate to 1000 */
        (void)snprintf(in,sizeof in,"INTENT v1 1 %llu%c %s %s %s %s %s %s %s %s\n",(unsigned long long)(f.e.principal/10-1),
            (char)('0'+10+f.e.principal%10),f.e.epoch,f.e.boot,f.e.user,f.e.workspace,f.e.launch,f.unit,BUS,MGR);
        VARIANT(in,f.job,f.anchor);
    }
    (void)snprintf(jb,sizeof jb,"JOB 0 /org/freedesktop/systemd1/job/0\n");
    (void)snprintf(an,sizeof an,"ANCHOR 0 %s /system.slice/%s\n",INV,f.unit); VARIANT(f.intent,jb,an);
    (void)snprintf(jb,sizeof jb,"JOB 07 /org/freedesktop/systemd1/job/07\n");
    (void)snprintf(an,sizeof an,"ANCHOR 07 %s /system.slice/%s\n",INV,f.unit); VARIANT(f.intent,jb,an);
    (void)snprintf(jb,sizeof jb,"JOB 4294967303 /org/freedesktop/systemd1/job/4294967303\n"); VARIANT(f.intent,jb,f.anchor);
    for (size_t i=0;i<nl;i++) {
        char b[2200]; int n=snprintf(b,sizeof b,"%s%s%s",lines[i][0],lines[i][1],lines[i][2]);
        put_journal(&f,b,(size_t)n);
        enum lcr_reason r; enum lcr_verdict got=once(&f,&r);
        if (got!=LCR_UNKNOWN || r!=LCR_R_GRAMMAR) { fprintf(stderr,"whole-line %zu: %d/%d\n",i,got,r); abort(); }
    }
    /* Line order, duplicates, NUL, overlong lines, unit not derived from epoch/slot. */
    char b[2200]; int n;
    n=snprintf(b,sizeof b,"%s%s%s",f.job,f.intent,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR);
    n=snprintf(b,sizeof b,"%s%s%s%s",f.intent,f.intent,f.job,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR);
    n=snprintf(b,sizeof b,"%s%s%s%s",f.intent,f.job,f.job,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR);
    n=snprintf(b,sizeof b,"%s%s",f.intent,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR);
    n=snprintf(b,sizeof b,"\n%s%s%s",f.intent,f.job,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR);
    memcpy(b,f.full,f.full_n); b[f.intent_n+3]=0; put_journal(&f,b,f.full_n); expect_unknown(&f,LCR_R_GRAMMAR);
    { char m[151]; memset(m,'1',sizeof m); m[0]=':'; m[75]='.'; m[150]=0;
      char intent[900]; strcpy(intent,f.intent); char *p=strstr(intent," " MGR "\n"); assert(p); sprintf(p," %s\n",m);
      n=snprintf(b,sizeof b,"%s%s%s",intent,f.job,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR); }
    { char intent[900]; strcpy(intent,f.intent); char *p=strstr(intent,"-0000000000000001.service"); assert(p); p[16]='2';
      n=snprintf(b,sizeof b,"%s%s%s",intent,f.job,f.anchor); put_journal(&f,b,(size_t)n); expect_unknown(&f,LCR_R_GRAMMAR); }
    assert(f.snapshots==0 && f.events_calls==0 && ledger_state(&f)==LC_FENCED);
    (void)epoch; (void)unit; rfinish(&f);
}
static void sweep_torn(int mode) {
    struct rfx f; rinit(&f); if (mode==ABSENT_READY) { absent_ready(&f); f.s.missing=1; }
    for (size_t len=1;len<f.full_n;len++) {
        put_journal(&f,f.full,len);
        enum lcr_reason want=len==f.intent_n ? LCR_R_NO_JOB:len==f.intent_n+f.job_n ? LCR_R_NO_ANCHOR:LCR_R_TORN;
        expect_unknown(&f,want);
    }
    assert(f.snapshots==0 && f.events_calls==0);
    put_journal(&f,f.full,f.full_n);
    enum lcr_reason r; enum lcr_verdict v=once(&f,&r);
    assert(mode==LIVE ? v==LCR_ANCHORED:(v==LCR_UNKNOWN && r==LCR_R_COLLECTED));
    rfinish(&f);
}
static void sweep_substitute(int mode) {
    struct rfx f; rinit(&f); if (mode==ABSENT_READY) absent_ready(&f);
    static const char repl[]={'0','1','7','a','c','d','f','X',' ','\n',0,':','.','/','-'};
    char b[1024]; unsigned count=0;
    for (size_t off=0;off<f.full_n;off++) for (size_t k=0;k<sizeof repl;k++) {
        if (f.full[off]==repl[k]) continue;
        memcpy(b,f.full,f.full_n); b[off]=repl[k]; put_journal(&f,b,f.full_n);
        enum lcr_reason r; enum lcr_verdict v=once(&f,&r);
        if (v!=LCR_UNKNOWN) { fprintf(stderr,"substitute off %zu byte %d: verdict %d\n",off,repl[k],v); abort(); }
        count++;
    }
    assert(f.events_calls==0 && ledger_state(&f)==LC_FENCED && count>5000);
    rfinish(&f);
}
static void parser_bounds(void) {
    struct lcr_journal j; enum lcr_reason r;
    assert(lcr_parse("",0,&j,&r)==0);
    assert(lcr_parse("INTENT",6,&j,&r)<0 && r==LCR_R_TORN);
    char big[LCR_JOURNAL_MAX+8]; memset(big,'1',sizeof big); big[sizeof big-1]='\n';
    assert(lcr_parse(big,sizeof big,&j,&r)<0 && r==LCR_R_JOURNAL);
    struct rfx f; rinit(&f);
    assert(lcr_parse(f.full,f.full_n,&j,&r)==3 && r==LCR_R_NONE);
    assert(j.slot==1 && j.job==7 && !strcmp(j.unit,f.unit) && !strcmp(j.invocation,INV) && !strcmp(j.manager,MGR) &&
        !strcmp(j.bus_id,BUS) && !strcmp(j.boot,f.e.boot) && !strcmp(j.launch,f.e.launch) && j.principal==f.e.principal);
    assert(lcr_parse(f.full,f.intent_n,&j,&r)==1 && lcr_parse(f.full,f.intent_n+f.job_n,&j,&r)==2);
    rfinish(&f);
}
int main(void) {
    alarm(240); assert(geteuid()!=0);
    parser_bounds(); puts("ok - parser bounds and fields");
    anchored(); puts("ok - ANCHORED: exact live anchor retains capacity, journal unchanged");
    absent_proven(); puts("ok - ABSENT_PROVEN: observer absence, separate cleanup retry, release, idempotent");
    collected_new_handle(); puts("ok - collected unit without prior receipt is UNKNOWN");
    for (unsigned i=0;i<46;i++) { unknown_case(i); printf("ok - UNKNOWN case %u\n",i); }
    changed_after_open(); puts("ok - journal change poisons handle");
    open_refusals(); puts("ok - open refusals, lock exclusion, unknown slot");
    grammar(); puts("ok - strict grammar variants");
    sweep_torn(LIVE); sweep_torn(ABSENT_READY); puts("ok - every torn-write offset (live and absence-ready)");
    sweep_substitute(LIVE); sweep_substitute(ABSENT_READY); puts("ok - every single-byte substitution (live and absence-ready)");
    return 0;
}
