/* Reuse the strict typed, stateful stop/reset bus, in its own translation unit.
 * No libsystemd is linked to this composition test. */
#define main stop_fixture_suite_main
#include "../systemd-create/test-stop.c"
#undef main
/* The production observer is forbidden in this fixture: lcr_open_with_ops
 * supplies only its read-only snapshot seam. The observer connects through
 * sd_bus_new, which here is test-stop.c's fake (an accidental production
 * snapshot would quietly return -1), so the tripwire sits at the observer's own
 * entry points: the Makefile links this binary with
 * -Wl,--wrap=lso_bus_snapshot -Wl,--wrap=lso_open and these wrappers abort. */
#include "systemd-observer.h"
int __wrap_lso_bus_snapshot(void *ctx,const char *unit,const char *manager,struct lso_snapshot *out);
int __wrap_lso_bus_snapshot(void *ctx,const char *unit,const char *manager,struct lso_snapshot *out) {
    (void)ctx; (void)unit; (void)manager; (void)out;
    fprintf(stderr,"FAIL: production lso_bus_snapshot reached from the reset fixture\n"); abort();
}
int __wrap_lso_open(const struct lso_config *c,struct lso **out);
int __wrap_lso_open(const struct lso_config *c,struct lso **out) {
    (void)c; (void)out;
    fprintf(stderr,"FAIL: production lso_open reached from the reset fixture\n"); abort();
}
int sd_bus_get_property_string(sd_bus *b,const char *d,const char *p,const char *i,const char *k,sd_bus_error *e,char **out) {
    (void)b; (void)d; (void)p; (void)i; (void)k; (void)e; (void)out; assert(0); return -EPERM;
}
int cross_reset_bus(const struct las_config *c,int (*gate)(void *,const struct lc_entry *),void *ctx,int fail,int *sent) {
    stopped_unit(fail ? "ResetFailed":NULL,1,0);
    lsc_test_create_uid=geteuid(); lsc_test_journal_uid=geteuid();
    struct las *s=NULL; int result=las_reset_open(c,gate,ctx,&s);
    if (!result) {
        cur=s; result=las_reset(s);
        assert(las_begin(s)==-1 && las_reset(s)==-1);
        assert(result==1 ? las_status(s)==LAS_RESET:las_status(s)==LAS_UNCERTAIN);
    }
    *sent=resets_sent;
    assert(kills==0 && stops==0);
    las_close(s); cur=NULL;
    assert(!bus_live && live()==0);
    return result;
}
