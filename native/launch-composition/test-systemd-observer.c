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
/* systemd 259 reports ControlGroup="" for a stopped unit whose cgroup it pruned
 * (cg_trim rmdir, then unit_release_cgroup). The empty string is never evidence:
 * absence must still rest on cgroup.events "populated 0" through the pinned
 * original directory. Removal before that observation stays UNKNOWN; only
 * later cleanup uses VFS S_DEAD/getdents ENOENT. These cases use the PRODUCTION removal check
 * (ops.removed = NULL). */
static void production_init(struct observation_fixture *f) {
    observation_init(f); lso_close(f->observer); f->observer=NULL;
    const struct lso_ops ops={.snapshot=bus_read};
    assert(lso_open_with_ops(&f->c,&ops,f,&f->observer)==0);
}
static void remove_original(struct observation_fixture *f) {
    assert(unlinkat(f->c.cgroup_fd,"cgroup.events",0)==0);
    assert(unlinkat(f->f.quota.base,"original-cgroup",AT_REMOVEDIR)==0);
}
static int second_cgroup_calls; static const char *second_cgroup;
static int bus_read_changing(void *ctx,const char *unit,const char *manager,struct lso_snapshot *s) {
    int r=bus_read(ctx,unit,manager,s);
    if (second_cgroup && ++second_cgroup_calls>1) strcpy(s->cgroup,second_cgroup);
    return r;
}
enum { EMPTY_POPULATED_0, EMPTY_REMOVED, EXPECTED_REMOVED, FOREIGN_REMOVED, EMPTY_POPULATED_1,
    EMPTY_NO_EVENTS_LIVE, EMPTY_OTHER_INVOCATION, EMPTY_ACTIVE, EMPTY_JOB, EMPTY_MISSING, EMPTY_BUS,
    EMPTY_MANAGER, EMPTY_UNFENCED, EMPTY_THEN_EXPECTED, EXPECTED_THEN_EMPTY, EMPTY_THEN_FOREIGN,
    EMPTY_BOOT, EMPTY_REMOVED_UNFENCED, EMPTY_REMOVAL_ERROR, STOPPED_CASES };
static void stopped_case(unsigned which) {
    struct observation_fixture f; production_init(&f);
    strcpy(f.s.cgroup,""); strcpy(f.s.state,"failed");
    int want=0;
    switch (which) {
    case EMPTY_POPULATED_0: want=1; break;
    case EMPTY_REMOVED: remove_original(&f); break; /* missed populated 0 is UNKNOWN */
    case EXPECTED_REMOVED: strcpy(f.s.cgroup,f.c.cgroup); remove_original(&f); break;
    case FOREIGN_REMOVED: strcpy(f.s.cgroup,"/system.slice/other.service"); remove_original(&f); break;
    case EMPTY_POPULATED_1: event_text(&f,"populated 1\nfrozen 0\n"); break;
    case EMPTY_NO_EVENTS_LIVE: assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0); break; /* bare ENOENT */
    case EMPTY_OTHER_INVOCATION: f.s.invocation[0]='d'; remove_original(&f); break;
    case EMPTY_ACTIVE: strcpy(f.s.state,"active"); remove_original(&f); break;
    case EMPTY_JOB: f.s.job=3; remove_original(&f); break;
    case EMPTY_MISSING: f.s.missing=1; remove_original(&f); break;
    case EMPTY_BUS: f.s.bus_id[0]='e'; remove_original(&f); break;
    case EMPTY_MANAGER: strcpy(f.s.manager,":1.43"); remove_original(&f); break;
    case EMPTY_UNFENCED: f.fenced=0; break;
    case EMPTY_THEN_EXPECTED: second_cgroup=f.c.cgroup; break;
    case EXPECTED_THEN_EMPTY: strcpy(f.s.cgroup,f.c.cgroup); second_cgroup=""; remove_original(&f); break;
    case EMPTY_THEN_FOREIGN: second_cgroup="/system.slice/other.service"; remove_original(&f); break;
    case EMPTY_BOOT: assert(pwrite(f.c.boot_fd,"9",1,0)==1); remove_original(&f); break;
    case EMPTY_REMOVED_UNFENCED: f.fenced=0; remove_original(&f); break;
    case EMPTY_REMOVAL_ERROR: { /* events unreadable and the removal seam errors (-1) */
        lso_close(f.observer); f.observer=NULL; f.cleanup_error=1;
        const struct lso_ops ops={.snapshot=bus_read,.removed=removal};
        assert(lso_open_with_ops(&f.c,&ops,&f,&f.observer)==0);
        assert(unlinkat(f.c.cgroup_fd,"cgroup.events",0)==0); break; }
    default: abort();
    }
    if (second_cgroup) {
        lso_close(f.observer); f.observer=NULL; second_cgroup_calls=0;
        const struct lso_ops ops={.snapshot=bus_read_changing};
        assert(lso_open_with_ops(&f.c,&ops,&f,&f.observer)==0);
    }
    int got=lso_absent(f.observer,&f.c.entry);
    if (got!=want) { fprintf(stderr,"stopped case %u: absent %d, want %d\n",which,got,want); abort(); }
    second_cgroup=NULL;
    struct lc_entry e;
    if (want) {
        /* Cleanup is still the separate proof: NoSuchUnit + original directory removed. */
        assert(lso_reconcile(f.observer,f.f.owner,1)<0 && lco_get(f.f.owner,1,&e)==0 && e.state!=LC_RELEASED);
        f.s.missing=1; f.s.invocation[0]=0; f.s.state[0]=0;
        if (which==EMPTY_POPULATED_0) {
            assert(lso_reconcile(f.observer,f.f.owner,1)<0); /* live directory is not removal */
            remove_original(&f);
        }
        assert(lso_reconcile(f.observer,f.f.owner,1)==0 && lco_get(f.f.owner,1,&e)==0 && e.state==LC_RELEASED);
    } else {
        assert(lso_reconcile(f.observer,f.f.owner,1)<0 && lco_get(f.f.owner,1,&e)==0 && e.state!=LC_RELEASED);
    }
    observation_finish(&f);
}
/* Production removal check only accepts a held directory the VFS marked dead:
 * a live directory, or a descriptor that cannot be read (O_PATH -> EBADF), is
 * never "removed", whatever the error. */
static void production_removal(void) {
    struct observation_fixture f; production_init(&f);
    assert(lso_absent(f.observer,&f.c.entry)==1);
    f.s.missing=1;
    assert(lso_clean(f.observer,&f.c.entry)==0);
    errno=ENOENT; /* a successful getdents must not reuse stale errno */
    assert(lso_removed(NULL,f.c.cgroup_fd)==0);
    int path=openat(f.f.quota.base,"original-cgroup",O_PATH|O_DIRECTORY|O_CLOEXEC); assert(path>=0);
    assert(lso_removed(NULL,path)==0);
    remove_original(&f);
    assert(lso_removed(NULL,path)==0); /* O_PATH: getdents EBADF, not proof */
    assert(lso_removed(NULL,f.c.cgroup_fd)==1);
    assert(lso_removed(NULL,f.c.cgroup_fd)==1); /* independent of the shared offset */
    close(path);
    assert(lso_clean(f.observer,&f.c.entry)==1);
    observation_finish(&f);
}
int main(void) {
    alarm(60); assert(geteuid()!=0);
    for (unsigned i=0;i<18;i++) { unknown_case(i); printf("ok - observer UNKNOWN fixture %u\n",i); }
    absence_cleanup_retry(); puts("ok - exact absence, separate cleanup retry, retained capacity, descriptor substitution");
    for (unsigned i=0;i<STOPPED_CASES;i++) { stopped_case(i); printf("ok - stopped-unit ControlGroup case %u\n",i); }
    production_removal(); puts("ok - production removal check: dead directory only (not live, not O_PATH)");
    return 0;
}
