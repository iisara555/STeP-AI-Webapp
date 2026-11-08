#ifndef STEP_SYSTEMD_STOP_H
#define STEP_SYSTEMD_STOP_H
#include "../launch-lifecycle/lifecycle.h"
/* Incarnation-bound stop of ONE anchored systemd-create unit (README-STOP.md).
 * Trusted local API for the single startup/lifecycle owner; never a wire
 * request. Inputs are the durable lifecycle entry plus the identity fields of
 * its complete create journal (from lcr_parse after LCR_ANCHORED); las_open
 * re-renders create.c's exact INTENT/JOB/ANCHOR lines from them and requires
 * the create journal to equal those bytes.
 *
 * Mutations, all addressed to the incarnation's InvocationID object path
 * (/org/freedesktop/systemd1/unit/<encoded invocation id>), which systemd
 * resolves only while that exact invocation exists:
 *   Unit.Kill("all", SIGKILL), then Unit.Stop("fail").
 * Never StopUnit/KillUnit by name, ResetFailed, job cancel, mode replace, or a
 * retry. LAS_STOPPED means only "this incarnation was observed inactive/failed
 * after the exact Stop job completed": it releases NOTHING. Capacity is
 * released only by create-reconcile's observer absence + cleanup proof.
 */
struct las;
enum las_status { LAS_NEW, LAS_PENDING, LAS_STOPPED, LAS_UNCERTAIN };
/* Diagnostic for the most recent terminal transition (NONE while NEW/PENDING
 * and with LAS_STOPPED). Whether anything was sent is visible in the stop
 * journal: empty = nothing attempted; STOP line = Kill may have been sent. */
enum las_reason {
    LAS_R_NONE = 0,
    LAS_R_AUTHORITY, /* exclusive() != 1 */
    LAS_R_CREATE,    /* create journal changed / attributes since open */
    LAS_R_JOURNAL,   /* stop journal stat/write/fsync failure or nonempty */
    LAS_R_BUS,       /* connect, timeout setup, match, Subscribe */
    LAS_R_OWNER,     /* peer uid, bus id, manager unique name or uid */
    LAS_R_QUERY,     /* failed/malformed read-only query */
    LAS_R_REPLACED,  /* name/invocation/Id/ControlGroup no longer this incarnation */
    LAS_R_STATE,     /* not active before / not inactive|failed after */
    LAS_R_JOB,       /* a pending job on the unit: never drained or cancelled */
    LAS_R_KILL,      /* Kill call failed or malformed reply */
    LAS_R_STOP,      /* Stop enqueue failed, error or malformed reply */
    LAS_R_EVENT,     /* JobRemoved not exactly our job with result done */
    LAS_R_DEADLINE,  /* attempt deadline / clock failure */
    LAS_R_DISPATCH,  /* sd_bus_process error */
};
struct las_config {
    struct lc_entry entry; /* durable nonterminal (not RESERVED) ledger entry */
    int create_fd;         /* complete create journal: protected root 0600 nlink 1, readable */
    int stop_fd;           /* fresh empty protected root 0600 nlink 1 file, O_RDWR,
                              single-use; caller fsyncs its parent and retains it */
    char bus_id[33], manager[128], invocation[33]; /* from the create journal */
    unsigned job;                                  /* create JOB id */
    void *context;
    int (*exclusive)(void *, const struct lc_entry *); /* exactly 1 required:
      exclusive stop authority for this entry on the current boot, no other
      create/start/attach/stop/reconcile in flight. Not a UID check. */
};
struct las_receipt { unsigned job; char invocation[33], state[16]; };
int las_open(const struct las_config *, struct las **);
int las_begin(struct las *); /* one attempt: verify, durable STOP, re-verify, Kill, Stop */
int las_poll(struct las *);  /* <=32 messages, then budgeted readback; 1 stopped,
                                0 pending, -1 terminal */
int las_fd(const struct las *);
int las_events(const struct las *);
int las_timeout(const struct las *, uint64_t *usec);
enum las_status las_status(const struct las *);
enum las_reason las_reason(const struct las *);
int las_receipt(const struct las *, struct las_receipt *);
void las_close(struct las *); /* unsubscribes locally only; never cancels/kills */
#endif
