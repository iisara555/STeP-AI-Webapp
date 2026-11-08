#define _GNU_SOURCE
#include "composition.h"
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
struct lco {
    struct lco_config config;
    struct lc *ledger;
    struct qbl *outcome;
    struct lc_entry attached;
    pthread_mutex_t mutex;
    pid_t pid;
};
static int fail(int e) { errno=e; return -1; }
static int lock(struct lco *a) {
    if (!a || a->pid!=getpid()) return fail(EPERM);
    int rc=pthread_mutex_trylock(&a->mutex); return rc ? fail(rc):0;
}
static int unlock(struct lco *a,int rc) { pthread_mutex_unlock(&a->mutex); return rc; }
static int spawn(void *ctx,const char *launch,const struct qb_workspace_receipt *r) {
    struct lco *a=ctx; struct lc_entry e;
    /* Called only inside owner -> qbl -> qb locks. No proof callback or slot
     * replacement can interleave with the final admission and synchronous spawn. */
    if (lc_get(a->ledger,a->attached.slot,&e)<0) return -1;
    if (e.state!=LC_RESERVED || strcmp(e.launch,launch)) return fail(EBUSY);
    if (lc_transition(a->ledger,e.slot,LC_STARTING)<0) return -1;
    e.state=LC_STARTING;
    return a->config.spawn(a->config.context,&e,r);
}
int lco_open(const struct lco_config *c,struct lco **out) {
    if (!out) return fail(EINVAL);
    *out=NULL;
    if (!c || !c->broker || !c->spawn) return fail(ENOTSUP);
    struct lco *a=calloc(1,sizeof *a); if (!a) return -1;
    a->config=*c; a->pid=getpid();
    int rc=pthread_mutex_init(&a->mutex,NULL);
    if (rc) { free(a); return fail(rc); }
    if (lc_open(&c->lifecycle,&a->ledger)<0) {
        int saved=errno; pthread_mutex_destroy(&a->mutex); free(a); return fail(saved);
    }
    *out=a; return 0;
}
static struct qbl_config outcome_config(struct lco *a,const struct lco_slot *s) {
    struct qbl_config c={.broker=a->config.broker,.state_fd=s->state_fd,.peer_uid=s->peer_uid,
        .identity=s->identity,.spawn=spawn,.context=a};
    memcpy(c.user,s->user,sizeof c.user); memcpy(c.workspace,s->workspace,sizeof c.workspace);
    memcpy(c.incarnation,s->launch,sizeof c.incarnation); memcpy(c.launch_id,s->launch,sizeof c.launch_id);
    return c;
}
int lco_prepare(struct lco *a,const struct lco_slot *s,struct lc_entry *out) {
    if (!s || !out) return fail(EINVAL);
    if (lock(a)<0) return -1;
    if (a->outcome) return unlock(a,fail(EBUSY));
    if (lc_reserve(a->ledger,(uint64_t)s->peer_uid,s->user,s->workspace,s->launch,out)<0) return unlock(a,-1);
    struct qbl_config c=outcome_config(a,s);
    /* Errors never release or undo the reservation, even before callback entry. */
    if (qbl_establish(&c)<0 || qbl_open(&c,&a->outcome)<0) return unlock(a,-1);
    a->attached=*out; return unlock(a,0);
}
int lco_attach(struct lco *a,uint64_t slot,const struct lco_slot *s) {
    if (!s) return fail(EINVAL);
    if (lock(a)<0) return -1;
    if (a->outcome) return unlock(a,fail(EBUSY));
    struct lc_entry e;
    if (lc_get(a->ledger,slot,&e)<0) return unlock(a,-1);
    if (e.principal!=(uint64_t)s->peer_uid || memcmp(e.user,s->user,sizeof e.user) ||
        memcmp(e.workspace,s->workspace,sizeof e.workspace) || memcmp(e.launch,s->launch,sizeof e.launch))
        return unlock(a,fail(EACCES));
    struct qbl_config c=outcome_config(a,s);
    if (qbl_open(&c,&a->outcome)<0) return unlock(a,-1);
    a->attached=e; return unlock(a,0);
}
int lco_serve(struct lco *a,int fd) {
    if (lock(a)<0) return -1;
    if (!a->outcome) return unlock(a,fail(ENOENT));
    int rc=qbl_serve(a->outcome,fd); return unlock(a,rc);
}
int lco_detach(struct lco *a) {
    if (lock(a)<0) return -1;
    qbl_close(a->outcome); a->outcome=NULL; memset(&a->attached,0,sizeof a->attached);
    return unlock(a,0);
}
int lco_get(struct lco *a,uint64_t slot,struct lc_entry *out) {
    if (lock(a)<0) return -1;
    int rc=lc_get(a->ledger,slot,out); return unlock(a,rc);
}
struct proofs {
    int (*absent)(void *,const struct lc_entry *);
    int (*clean)(void *,const struct lc_entry *);
    void *context;
};
static enum lc_proof prove(void *ctx,const struct lc_entry *e) {
    struct proofs *p=ctx;
    if (p->absent(p->context,e)!=1) return LC_UNKNOWN;
    return p->clean(p->context,e)==1 ? LC_ABSENT_AND_CLEAN:LC_UNKNOWN;
}
int lco_reconcile(struct lco *a,uint64_t slot,
                  int (*absent)(void *,const struct lc_entry *),
                  int (*clean)(void *,const struct lc_entry *),void *context) {
    if (!absent || !clean) return fail(EINVAL);
    if (lock(a)<0) return -1;
    struct proofs p={absent,clean,context};
    int rc=lc_reconcile(a->ledger,slot,prove,&p); return unlock(a,rc);
}
void lco_close(struct lco *a) {
    if (!a) return;
    /* Caller must stop/drain/join before close. Inherited handles are forbidden. */
    if (a->pid!=getpid()) return;
    qbl_close(a->outcome); lc_close(a->ledger); pthread_mutex_destroy(&a->mutex); free(a);
}
