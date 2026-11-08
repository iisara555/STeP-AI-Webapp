/* Actual descriptor/syscall parser + typed bus seam + real composition ledger. */
#define COMPOSITION_TEST_MAIN composition_suite_main
#include "test-composition.c"
#include "systemd-observer.h"
struct observation_fixture {
    struct composed_fixture f;
    struct lso_config c;
    struct lso_snapshot s;
    struct lso *observer;
    int fenced, error, calls, replace_after, cleanup_error;
};
static int fence(void *ctx,const struct lc_entry *e) {
    struct observation_fixture *f=ctx;
    return exact(e,&f->c.entry) ? f->fenced:0;
}
static int bus_read(void *ctx,const char *unit,const char *manager,struct lso_snapshot *s) {
    struct observation_fixture *f=ctx; char expected[100];
    assert(snprintf(expected,sizeof expected,"%s.service",f->c.entry.container)>0);
    assert(!strcmp(unit,expected) && !strcmp(manager,f->c.manager));
    f->calls++; *s=f->s;
    if (f->replace_after && f->calls>1) s->invocation[0]='f';
    return f->error ? -1:0;
}
static int removal(void *ctx,int fd) {
    struct observation_fixture *f=ctx; struct stat st;
    if (f->cleanup_error) return -1;
    assert(fstat(fd,&st)==0); return st.st_nlink==0;
}
static void event_text(struct observation_fixture *f,const char *text) {
    int fd=openat(f->c.cgroup_fd,"cgroup.events",O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC,0600);
    assert(fd>=0 && write(fd,text,strlen(text))==(ssize_t)strlen(text)); close(fd);
}
static void observation_init(struct observation_fixture *f) {
    memset(f,0,sizeof *f); init(&f->f,1);
    assert(lco_open(&f->f.config,&f->f.owner)==0);
    assert(lco_prepare(f->f.owner,&f->f.spec,&f->c.entry)==0);
    assert(lco_detach(f->f.owner)==0);
    assert(mkdirat(f->f.quota.base,"original-cgroup",0700)==0);
    f->c.cgroup_fd=openat(f->f.quota.base,"original-cgroup",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    f->c.boot_fd=openat(f->f.quota.base,"boot-id",O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);
    assert(f->c.cgroup_fd>=0 && f->c.boot_fd>=0);
    char boot[38]; assert(snprintf(boot,sizeof boot,"%s\n",f->c.entry.boot)==37);
    assert(write(f->c.boot_fd,boot,37)==37);
    struct stat st; assert(fstat(f->c.cgroup_fd,&st)==0);
    f->c.cgroup_device=st.st_dev; f->c.cgroup_inode=st.st_ino;
    f->c.trusted_uid=geteuid(); f->c.context=f; f->c.lifetime_fenced=fence; f->fenced=1;
    strcpy(f->c.manager,":1.42"); strcpy(f->c.invocation,"cccccccccccccccccccccccccccccccc");
    strcpy(f->c.bus_id,"dddddddddddddddddddddddddddddddd"); strcpy(f->s.bus_id,f->c.bus_id);
    strcpy(f->c.cgroup,"/protected.slice/original.service");
    strcpy(f->s.manager,f->c.manager); strcpy(f->s.invocation,f->c.invocation);
    strcpy(f->s.cgroup,f->c.cgroup); strcpy(f->s.state,"inactive");
    event_text(f,"populated 0\nfrozen 0\n");
    const struct lso_ops ops={.snapshot=bus_read,.removed=removal};
    assert(lso_open_with_ops(&f->c,&ops,f,&f->observer)==0);
}
static void observation_finish(struct observation_fixture *f) {
    lso_close(f->observer); close(f->c.cgroup_fd); close(f->c.boot_fd); finish(&f->f);
}
static void unknown_case(unsigned which) {
    struct observation_fixture f; observation_init(&f);
    switch (which) {
    case 0: f.fenced=0; break; /* outstanding local start/attach or unknown exclusivity */
    case 1: f.s.job=7; break;
    case 2: f.s.missing=1; break; /* NoSuchUnit alone is not absence */
    case 3: f.error=1; break;
    case 4: strcpy(f.s.manager,":1.43"); break;
    case 5: f.s.invocation[0]='d'; break;
    case 6: strcpy(f.s.cgroup,"/replacement"); break;
    case 7: strcpy(f.s.state,"active"); break; /* leader exit irrelevant */
    case 8: event_text(&f,"populated 1\nfrozen 0\n"); break;
    case 9: event_text(&f,"populated 0\npopulated 0\n"); break;
    case 10: event_text(&f,"populated false\n"); break;
    case 11: event_text(&f,"frozen 0\n"); break;
    case 12: assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0); break;
    case 13: assert(pwrite(f.c.boot_fd,"9",1,0)==1); break;
    case 14: f.replace_after=1; break;
    case 15: memset(f.s.state,'x',sizeof f.s.state); break;
    case 16: assert(fchmod(f.c.cgroup_fd,0770)==0); break;
    case 17: f.s.bus_id[0]='e'; break; /* bus restart can reuse unique owner names */
    default: abort();
    }
    assert(lso_absent(f.observer,&f.c.entry)==0);
    assert(lso_clean(f.observer,&f.c.entry)==0);
    assert(lso_reconcile(f.observer,f.f.owner,1)<0);
    struct lc_entry e; assert(lco_get(f.f.owner,1,&e)==0 && e.state!=LC_RELEASED);
    observation_finish(&f);
}
static void absence_cleanup_retry(void) {
    struct observation_fixture f; observation_init(&f);
    struct lc_entry wrong=f.c.entry; wrong.launch[0]='f';
    assert(lso_absent(f.observer,&wrong)==0);
    assert(lso_clean(f.observer,&f.c.entry)==0); /* cleanup never precedes absence */
    assert(lso_absent(f.observer,&f.c.entry)==1);
    assert(lso_reconcile(f.observer,f.f.owner,1)<0); /* unit still exists */
    f.s.missing=1;
    assert(lso_reconcile(f.observer,f.f.owner,1)<0); /* group metadata remains */
    fresh_spec(&f.f,2); memcpy(f.f.spec.workspace,ws_b,37);
    struct lc_entry e; assert(lco_prepare(f.f.owner,&f.f.spec,&e)<0 && errno==ENOSPC);
    /* Replacing path never replaces retained original descriptor. */
    assert(renameat(f.f.quota.base,"original-cgroup",f.f.quota.base,"old-cgroup")==0);
    assert(mkdirat(f.f.quota.base,"original-cgroup",0700)==0);
    assert(lso_clean(f.observer,&f.c.entry)==0);
    assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0);
    assert(unlinkat(f.f.quota.base,"old-cgroup",AT_REMOVEDIR)==0);
    f.cleanup_error=1; assert(lso_reconcile(f.observer,f.f.owner,1)<0);
    f.cleanup_error=0; f.fenced=0; assert(lso_reconcile(f.observer,f.f.owner,1)<0);
    f.fenced=1; strcpy(f.s.manager,":1.99"); assert(lso_reconcile(f.observer,f.f.owner,1)<0);
    strcpy(f.s.manager,f.c.manager);
    assert(lso_reconcile(f.observer,f.f.owner,1)==0);
    assert(lco_get(f.f.owner,1,&e)==0 && e.state==LC_RELEASED);
    assert(lco_prepare(f.f.owner,&f.f.spec,&e)==0);
    observation_finish(&f);
}
int main(void) {
    alarm(60); assert(geteuid()!=0);
    for (unsigned i=0;i<18;i++) { unknown_case(i); printf("ok - observer UNKNOWN fixture %u\n",i); }
    absence_cleanup_retry(); puts("ok - exact absence, separate cleanup retry, retained capacity, descriptor substitution");
    return 0;
}
