/* Public seam agreed for this increment: real reconcile -> its own observer
 * receipt -> real reset adapter -> independent cleanup -> real ledger release.
 * Typed bus lives in test-reset-bus.c; all filesystem data is disposable. */
#define BUS "11111111111111111111111111111111"
#define INV "01000000000000000000000000000000"
#define RINIT_SETUP(f) do { strcpy((f)->f.config.lifecycle.epoch,BUS); \
    strcpy((f)->f.spec.launch,"22222222222222222222222222222222"); \
    assert(unlinkat((f)->f.lifecycle_fd,"lifecycle.ledger",0)==0); \
    assert(lc_establish(&(f)->f.config.lifecycle)==0); } while (0)
#define RECONCILE_TEST_MAIN reconcile_fixture_suite_main
#include "test-create-reconcile.c"
#undef main
#include "../systemd-create/stop.h"
extern int cross_reset_bus(const struct las_config *,int (*)(void *,const struct lc_entry *),void *,int,int *);
struct connection { struct rfx *f; int fd, calls, sent, fail; };
static int connected_reset(void *ctx,const struct lc_entry *e,const struct lcr_journal *j,
    int (*gate)(void *,const struct lc_entry *),void *gate_ctx) {
    struct connection *x=ctx; x->calls++;
    assert(ledger_state(x->f)==LC_FENCED && x->f->events_calls==1);
    struct las_config c={.entry=*e,.create_fd=x->f->c.journal_fd,.stop_fd=x->fd,
        .context=x->f,.exclusive=rfence,.job=j->job};
    strcpy(c.bus_id,j->bus_id); strcpy(c.manager,j->manager); strcpy(c.invocation,j->invocation);
    return cross_reset_bus(&c,gate,gate_ctx,x->fail,&x->sent);
}
static void connected_case(int mode) {
    struct rfx f; rinit(&f); stopped(&f);
    struct connection x={.f=&f,.fail=mode==1};
    x.fd=openat(f.f.quota.base,"reset.record",O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600); assert(x.fd>=0);
    f.c.reset=connected_reset; f.c.reset_context=&x;
    if (mode==2) events(&f,"populated 1\n");
    if (mode==3) { prune(&f); f.s.missing=1; }
    if (mode==5) strcpy(f.s.manager,":1.43");
    struct lcr *h=NULL; assert(lcr_open_with_ops(&f.c,&OPS,&f,&h)==0);
    enum lcr_verdict v; enum lcr_reason r;
    assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN);
    assert(r==(mode==1 ? LCR_R_RESET:mode==3 ? LCR_R_COLLECTED:mode==5 ? LCR_R_MANAGER:LCR_R_UNPROVEN));
    assert(x.calls==(mode<2 || mode==4) && x.sent==(mode<2 || mode==4) && ledger_state(&f)==LC_FENCED);
    if (mode==2) assert(f.events_calls==1); /* reject at the first failed proof, never re-observe */
    /* Reset reply/readback is NOT metadata cleanup: still loaded and original
     * directory still present, so the real ledger must retain capacity. */
    if (mode<2 || mode==4) {
        assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && x.calls==1 && x.sent==1 &&
            r==(mode==1 ? LCR_R_RESET:LCR_R_UNPROVEN));
        if (mode==4) {
            f.s.missing=1; f.s.invocation[0]=0; f.s.state[0]=0;
            assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && ledger_state(&f)==LC_FENCED);
            prune(&f); /* unit gone alone is not metadata cleanup either */
        } else {
            prune(&f); /* directory removed alone: still not enough */
            assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_UNKNOWN && ledger_state(&f)==LC_FENCED);
            f.s.missing=1; f.s.invocation[0]=0; f.s.state[0]=0;
        }
        assert(lcr_reconcile(h,&v,&r)==0 && v==LCR_ABSENT_PROVEN && r==LCR_R_NONE);
        assert(ledger_state(&f)==LC_RELEASED && x.calls==1 && f.events_calls==1);
    }
    lcr_close(h); close(x.fd); rfinish(&f);
}
int main(void) {
    alarm(60); assert(geteuid()!=0);
    for (int mode=0;mode<6;mode++) { connected_case(mode); printf("ok - connected reset case %d\n",mode); }
    return 0;
}
