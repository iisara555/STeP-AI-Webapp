#define _GNU_SOURCE
#include "lifecycle.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
static const char *user="12345678-1234-4234-8234-000000000001";
static const char *workspace="12345678-1234-4234-8234-000000000002";
static const char *launch="00000000000000000000000000000001";
static int fault, sync_count, at_sync=1, after_sync, calls;
int __real_fsync(int);
ssize_t __real_pwrite(int,const void *,size_t,off_t);
int __wrap_fsync(int fd) {
    if (fault && ++sync_count==at_sync) {
        if (fault==1) { if (after_sync) assert(__real_fsync(fd)==0); _exit(80); }
        if (fault==2) { errno=EIO; return -1; }
    }
    return __real_fsync(fd);
}
ssize_t __wrap_pwrite(int fd,const void *b,size_t n,off_t pos) {
    if (fault==3) { assert(__real_pwrite(fd,b,n/2,pos)==(ssize_t)(n/2)); _exit(81); }
    if (fault==4) { errno=EIO; return -1; }
    if (fault==5) return __real_pwrite(fd,b,n/2,pos);
    if (fault==6) { assert(__real_pwrite(fd,b,n,pos)==(ssize_t)n); errno=EIO; return -1; }
    return __real_pwrite(fd,b,n,pos);
}
static enum lc_proof absence(void *ctx,const struct lc_entry *e) {
    (void)ctx; assert(e->slot && e->container[0]); calls++; return LC_ABSENT_AND_CLEAN;
}
struct fixture { char path[1024]; struct lc_config c; };
static struct fixture fresh(uint64_t capacity) {
    struct fixture f={.c={.capacity=capacity,.epoch="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",.boot="12345678-1234-4234-8234-000000000003"}};
    assert(snprintf(f.path,sizeof f.path,"%s/lifecycle-fault-XXXXXX",getenv("TMPDIR"))>0);
    assert(mkdtemp(f.path)); f.c.directory_fd=open(f.path,O_RDONLY|O_DIRECTORY|O_CLOEXEC); assert(f.c.directory_fd>=0); return f;
}
static void dispose(struct fixture *f) {
    assert(unlinkat(f->c.directory_fd,"lifecycle.ledger",0)==0);
    close(f->c.directory_fd); assert(rmdir(f->path)==0);
}
static void wait_exit(pid_t pid,int code) {
    int status; assert(waitpid(pid,&status,0)==pid); assert(WIFEXITED(status) && WEXITSTATUS(status)==code);
}
static struct lc *open_f(struct fixture *f) { struct lc *a=NULL; assert(lc_open(&f->c,&a)==0); return a; }
static struct lc_entry reserve(struct lc *a,unsigned n) {
    char id[33],ws[37]; struct lc_entry e;
    assert(snprintf(id,sizeof id,"%032x",n)==32);
    assert(snprintf(ws,sizeof ws,"12345678-1234-4234-8234-%012x",n)==36);
    assert(lc_reserve(a,1000,user,ws,id,&e)==0); return e;
}
static void prepare(struct fixture *f,int operation) {
    assert(lc_establish(&f->c)==0);
    if (!operation) return;
    struct lc *a=open_f(f); struct lc_entry e=reserve(a,1);
    if (operation>=2) assert(lc_transition(a,e.slot,LC_STARTING)==0);
    if (operation>=3) assert(lc_transition(a,e.slot,LC_RUNNING)==0);
    if (operation>=4) assert(lc_transition(a,e.slot,LC_STOPPING)==0);
    lc_close(a);
}
/* Each operation runs in one holder; opening fences persisted preparation, so
 * move to required live state in this same holder before arming the crash. */
static void operation(struct lc *a,int op) {
    struct lc_entry e;
    if (op==0) { assert(lc_reserve(a,1000,user,workspace,launch,&e)==0); return; }
    if (op==1) { assert(lc_transition(a,1,LC_STARTING)==0); return; }
    if (op==2) { assert(lc_transition(a,1,LC_RUNNING)==0); return; }
    if (op==3) { assert(lc_transition(a,1,LC_STOPPING)==0); return; }
    assert(lc_reconcile(a,1,absence,NULL)==0);
}
static void crash_transitions(void) {
    for (int op=0;op<5;op++) for (int phase=0;phase<3;phase++) {
        struct fixture f=fresh(2); assert(lc_establish(&f.c)==0);
        pid_t pid=fork(); assert(pid>=0);
        if (!pid) {
            struct lc *a=open_f(&f);
            if (op) (void)reserve(a,1);
            if (op>=2) assert(lc_transition(a,1,LC_STARTING)==0);
            if (op>=3) assert(lc_transition(a,1,LC_RUNNING)==0);
            if (op>=4) assert(lc_transition(a,1,LC_STOPPING)==0);
            fault=phase==2 ? 3:1; after_sync=phase; sync_count=0;
            operation(a,op); _exit(90);
        }
        wait_exit(pid,phase==2 ? 81:80);
        struct lc *a=NULL;
        if (phase==2) assert(lc_open(&f.c,&a)<0 && !a);
        else {
            a=open_f(&f); struct lc_entry e; assert(lc_get(a,1,&e)==0);
            assert(e.state==(op==4 ? LC_RELEASED:LC_FENCED));
            if (op!=4) { struct lc_entry other; assert(lc_reserve(a,1000,user,workspace,"00000000000000000000000000000002",&other)<0); }
            assert(lc_reconcile(a,1,absence,NULL)==0); lc_close(a);
        }
        dispose(&f);
    }
    puts("crash: reserve/starting/running/stopping/release before+after sync and torn write passed");
}
static void crash_fences(void) {
    for (int phase=0;phase<3;phase++) for (int n=1;n<=3;n++) {
        struct fixture f=fresh(4); assert(lc_establish(&f.c)==0);
        struct lc *a=open_f(&f); for (unsigned i=1;i<=3;i++) (void)reserve(a,i); lc_close(a);
        pid_t pid=fork(); assert(pid>=0);
        if (!pid) {
            fault=phase==2 ? 3:1; after_sync=phase; at_sync=n; sync_count=0;
            a=open_f(&f); _exit(90);
        }
        /* Torn writes always stop at the first fence; fsync faults cover each fence. */
        wait_exit(pid,phase==2 ? 81:80);
        if (phase==2) { a=NULL; assert(lc_open(&f.c,&a)<0); }
        else {
            a=open_f(&f);
            for (uint64_t i=1;i<=3;i++) { struct lc_entry e; assert(lc_get(a,i,&e)==0 && e.state==LC_FENCED); }
            assert(lc_reconcile(a,1,absence,NULL)==0);
            struct lc_entry e; assert(lc_reserve(a,1000,user,workspace,"00000000000000000000000000000004",&e)<0);
            assert(lc_reconcile(a,2,absence,NULL)==0); assert(lc_reconcile(a,3,absence,NULL)==0);
            (void)reserve(a,4); lc_close(a);
        }
        dispose(&f);
    }
    puts("recovery: interrupted fence drain never admits before all proofs passed");
}
static void sync_poison(void) {
    for (int op=0;op<5;op++) {
        struct fixture f=fresh(2); assert(lc_establish(&f.c)==0); struct lc *a=open_f(&f);
        if (op) (void)reserve(a,1);
        if (op>=2) assert(lc_transition(a,1,LC_STARTING)==0);
        if (op>=3) assert(lc_transition(a,1,LC_RUNNING)==0);
        if (op>=4) assert(lc_transition(a,1,LC_STOPPING)==0);
        fault=2; sync_count=0; at_sync=1;
        struct lc_entry e; int rc;
        if (!op) rc=lc_reserve(a,1000,user,workspace,launch,&e);
        else if (op<4) rc=lc_transition(a,1,(enum lc_state)(op+1));
        else rc=lc_reconcile(a,1,absence,NULL);
        assert(rc<0); fault=0;
        int before=calls;
        assert(lc_get(a,1,&e)<0); assert(lc_reconcile(a,1,absence,NULL)<0);
        assert(calls==before); assert(lc_reserve(a,1000,user,workspace,"00000000000000000000000000000002",&e)<0);
        lc_close(a); a=open_f(&f); assert(lc_get(a,1,&e)==0);
        assert(e.state==(op==4 ? LC_RELEASED:LC_FENCED)); lc_close(a); dispose(&f);
    }
    /* Both establishment fsyncs and every recovery fsync must refuse handles. */
    for (int stage=1;stage<=2;stage++) {
        struct fixture f=fresh(2); fault=2; sync_count=0; at_sync=stage;
        assert(lc_establish(&f.c)<0); fault=0; assert(lc_establish(&f.c)<0); dispose(&f);
    }
    for (int stage=1;stage<=3;stage++) {
        struct fixture f=fresh(2); prepare(&f,1); struct lc *a=NULL;
        fault=2; sync_count=0; at_sync=stage; assert(lc_open(&f.c,&a)<0 && !a); fault=0;
        a=open_f(&f); lc_close(a); dispose(&f);
    }
    at_sync=1;
    puts("sync uncertainty: every mutation poisons; establish/recovery refuse handles passed");
}
static void rehash(unsigned char *b) {
    uint64_t hash=UINT64_C(14695981039346656037);
    for (size_t i=0;i<248;i++) { hash^=b[i]; hash*=UINT64_C(1099511628211); }
    for (unsigned i=0;i<8;i++) { b[248+i]=(unsigned char)hash; hash>>=8; }
}
static void corrupt(void) {
    for (int kind=0;kind<9;kind++) {
        struct fixture f=fresh(2); prepare(&f,1);
        int fd=openat(f.c.directory_fd,"lifecycle.ledger",O_RDWR|O_CLOEXEC); assert(fd>=0);
        unsigned char record[256]; assert(pread(fd,record,sizeof record,256)==256);
        if (kind==0) { record[108]^=1; assert(pwrite(fd,record,sizeof record,256)==256); }
        if (kind==1) assert(pwrite(fd,record,sizeof record,512)==256); /* replay */
        if (kind==2) assert(ftruncate(fd,511)==0);
        if (kind==3) f.c.capacity=1;
        if (kind==4) f.c.epoch[0]='b';
        if (kind==5) { /* checksummed but illegal first state */
            record[32]=LC_RUNNING; rehash(record); assert(pwrite(fd,record,sizeof record,256)==256);
        }
        if (kind==6 || kind==7) { /* valid sequence, changed principal/boot */
            record[8]=2; record[32]=LC_STARTING;
            if (kind==6) record[24]^=1;
            else record[107]='4';
            rehash(record); assert(pwrite(fd,record,sizeof record,512)==256);
        }
        if (kind==8) { /* checksummed noncanonical reserved padding */
            record[33]=1; rehash(record); assert(pwrite(fd,record,sizeof record,256)==256);
        }
        close(fd); struct lc *a=NULL; assert(lc_open(&f.c,&a)<0 && !a); dispose(&f);
    }
    for (off_t cut=1;cut<256;cut++) {
        struct fixture f=fresh(2); prepare(&f,1);
        int fd=openat(f.c.directory_fd,"lifecycle.ledger",O_RDWR|O_CLOEXEC); assert(fd>=0);
        assert(ftruncate(fd,256+cut)==0); close(fd);
        struct lc *a=NULL; assert(lc_open(&f.c,&a)<0); dispose(&f);
    }
    puts("corruption: modified/replayed records, config mismatch and all 255 tail lengths refused");
}
static void crash_establish(void) {
    for (int phase=0;phase<3;phase++) for (int n=1;n<=2;n++) {
        struct fixture f=fresh(1); pid_t pid=fork(); assert(pid>=0);
        if (!pid) {
            fault=phase==2 ? 3:1; sync_count=0; after_sync=phase; at_sync=n;
            assert(lc_establish(&f.c)==0); _exit(90);
        }
        wait_exit(pid,phase==2 ? 81:80);
        assert(lc_establish(&f.c)<0);
        struct lc *a=NULL;
        if (phase==2) assert(lc_open(&f.c,&a)<0);
        else { a=open_f(&f); (void)reserve(a,1); lc_close(a); }
        dispose(&f);
    }
    puts("establishment: crash at header/directory durability boundaries never auto-recreates");
}
static void duplicate_workspace(void) {
    struct fixture f=fresh(2); assert(lc_establish(&f.c)==0); struct lc *a=open_f(&f); struct lc_entry e;
    assert(lc_reserve(a,1000,user,workspace,launch,&e)==0);
    assert(lc_reserve(a,1000,user,workspace,"00000000000000000000000000000002",&e)<0);
    lc_close(a); dispose(&f);
}
static void write_poison(void) {
    for (int op=0;op<5;op++) for (int mode=4;mode<=6;mode++) {
        struct fixture f=fresh(2); assert(lc_establish(&f.c)==0); struct lc *a=open_f(&f);
        if (op) (void)reserve(a,1);
        if (op>=2) assert(lc_transition(a,1,LC_STARTING)==0);
        if (op>=3) assert(lc_transition(a,1,LC_RUNNING)==0);
        if (op>=4) assert(lc_transition(a,1,LC_STOPPING)==0);
        fault=mode;
        struct lc_entry e; int rc;
        if (!op) rc=lc_reserve(a,1000,user,workspace,launch,&e);
        else if (op<4) rc=lc_transition(a,1,(enum lc_state)(op+1));
        else rc=lc_reconcile(a,1,absence,NULL);
        assert(rc<0); fault=0;
        int before=calls;
        assert(lc_get(a,1,&e)<0 && errno==EIO);
        assert(lc_reconcile(a,1,absence,NULL)<0 && calls==before);
        lc_close(a); a=NULL;
        if (mode==5) assert(lc_open(&f.c,&a)<0 && !a);
        else {
            a=open_f(&f);
            if (!op && mode==4) assert(lc_get(a,1,&e)<0 && errno==ENOENT);
            else { assert(lc_get(a,1,&e)==0); assert(e.state==(op==4 && mode==6 ? LC_RELEASED:LC_FENCED)); }
            lc_close(a);
        }
        dispose(&f);
    }
    puts("write uncertainty: errors, short writes and error-after-complete-write poison all transitions");
}
int main(void) { duplicate_workspace(); crash_establish(); crash_transitions(); crash_fences(); sync_poison(); write_poison(); corrupt(); }
