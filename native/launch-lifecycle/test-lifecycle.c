#define _GNU_SOURCE
#include "lifecycle.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
static const char *u="12345678-1234-4234-8234-000000000001";
static const char *w="12345678-1234-4234-8234-000000000002";
static const char *id="00000000000000000000000000000001";
static int proof_calls;
static enum lc_proof proof(void *p,const struct lc_entry *e) { assert(e->container[0]); proof_calls++; return *(enum lc_proof *)p; }
int main(void) {
    char path[1024]; const char *tmp=getenv("TMPDIR"); assert(tmp);
    assert(snprintf(path,sizeof path,"%s/lifecycle-XXXXXX",tmp)>0); assert(mkdtemp(path));
    struct lc_config c={.directory_fd=open(path,O_DIRECTORY|O_RDONLY|O_CLOEXEC),.capacity=1,
        .epoch="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",.boot="12345678-1234-4234-8234-000000000003"};
    struct lc *a=NULL,*b=NULL; struct lc_entry e,x;
    assert(lc_open(&c,&a)<0); assert(lc_establish(&c)==0); assert(lc_establish(&c)<0);
    assert(lc_open(&c,&a)==0); assert(lc_open(&c,&b)<0);
    pid_t pid=fork(); assert(pid>=0);
    if (!pid) {
        struct lc *other=NULL;
        assert(lc_reserve(a,1000,u,w,id,&e)<0 && errno==EPERM);
        _exit(lc_open(&c,&other)<0 ? 0:1);
    }
    int status; assert(waitpid(pid,&status,0)==pid && WIFEXITED(status) && WEXITSTATUS(status)==0);
    assert(lc_reserve(a,1000,u,w,id,&e)==0); assert(e.state==LC_RESERVED);
    assert(e.principal==1000 && !strcmp(e.epoch,c.epoch) && !strcmp(e.boot,c.boot));
    assert(lc_reserve(a,1000,u,w,id,&x)<0);
    assert(lc_reserve(a,1000,u,"12345678-1234-4234-8234-000000000004","00000000000000000000000000000002",&x)<0 && errno==ENOSPC);
    assert(lc_transition(a,e.slot,LC_RUNNING)<0);
    assert(lc_transition(a,e.slot,LC_STARTING)==0);
    lc_close(a); assert(lc_open(&c,&a)==0);
    assert(lc_get(a,e.slot,&x)==0 && x.state==LC_FENCED);
    enum lc_proof p=LC_UNKNOWN; assert(lc_reconcile(a,e.slot,proof,&p)<0);
    p=LC_PRESENT; assert(lc_reconcile(a,e.slot,proof,&p)<0);
    assert(lc_reserve(a,1000,u,w,"00000000000000000000000000000002",&x)<0);
    p=LC_ABSENT_AND_CLEAN; assert(lc_reconcile(a,e.slot,proof,&p)==0);
    int before=proof_calls;
    assert(lc_reconcile(a,e.slot,proof,&p)==0);
    assert(proof_calls==before);
    assert(lc_reserve(a,1000,u,w,id,&x)<0);
    assert(lc_reserve(a,1000,u,w,"00000000000000000000000000000002",&x)==0);
    assert(strcmp(x.container,e.container));
    assert(lc_reserve(a,1000,u,"12345678-1234-4234-8234-000000000004","00000000000000000000000000000003",&e)<0 && errno==ENOSPC);
    assert(x.slot>e.slot); assert(lc_transition(a,x.slot,LC_STARTING)==0);
    assert(lc_transition(a,x.slot,LC_RUNNING)==0); assert(lc_transition(a,x.slot,LC_STOPPING)==0);
    assert(lc_transition(a,x.slot,LC_RELEASED)<0);
    assert(lc_reconcile(a,x.slot,proof,&p)==0); lc_close(a);
    c.boot[35]='4';
    assert(lc_open(&c,&a)==0);
    assert(lc_get(a,x.slot,&e)==0 && strcmp(e.boot,c.boot));
    assert(lc_reconcile(a,x.slot,proof,&p)==0);
    assert(lc_reserve(a,1000,u,w,"00000000000000000000000000000003",&e)==0);
    assert(!strcmp(e.boot,c.boot) && strcmp(e.container,x.container));
    assert(lc_reconcile(a,e.slot,proof,&p)==0); lc_close(a);
    assert(unlinkat(c.directory_fd,"lifecycle.ledger",0)==0); close(c.directory_fd); assert(rmdir(path)==0);
    puts("lifecycle: lock, reserve, reopen fence, proof release and nonreuse passed");
}
