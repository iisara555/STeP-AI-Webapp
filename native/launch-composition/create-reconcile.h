#ifndef STEP_CREATE_RECONCILE_H
#define STEP_CREATE_RECONCILE_H
#include "systemd-observer.h"
/* Startup reconciliation of ONE nonempty systemd-create journal (create.c
 * format: INTENT v1 / JOB / ANCHOR lines) against its durable lifecycle slot.
 * Trusted local API for the single startup owner only; never a wire request.
 * Read-only: never writes the journal, never calls StartTransientUnit, stop,
 * kill or reset, and never retries or reuses the journal's unit name. The only
 * durable effect is a lifecycle release through lso_reconcile -> lco_reconcile
 * after the observer's exact absence AND separate cleanup proof.
 *
 * Verdicts:
 *  LCR_ANCHORED       complete journal; exact unit/invocation/cgroup observed
 *                     active, no job, same boot, same bus id + manager. Retains
 *                     capacity (the anchor is present).
 *  LCR_ABSENT_PROVEN  complete journal; observer absence + cleanup proven for
 *                     the journal's bus/manager/unit/invocation/cgroup and the
 *                     lifecycle entry is durably RELEASED.
 *  LCR_UNKNOWN        everything else. Retains capacity and the recovery fence.
 */
enum lcr_verdict { LCR_UNKNOWN = 0, LCR_ANCHORED, LCR_ABSENT_PROVEN };
/* Diagnostic only; every reason except NONE/RELEASED accompanies LCR_UNKNOWN. */
enum lcr_reason {
    LCR_R_NONE = 0,
    LCR_R_JOURNAL,    /* journal type/owner/mode/links/size/read failure */
    LCR_R_CHANGED,    /* journal bytes changed after first reconciliation */
    LCR_R_EMPTY,      /* no INTENT: nothing provably sent, but no absence proof */
    LCR_R_TORN,       /* trailing bytes without a final newline */
    LCR_R_GRAMMAR,    /* any line outside the exact field grammar / order */
    LCR_R_LEDGER,     /* INTENT does not bind exactly the durable ledger slot */
    LCR_R_NO_JOB,     /* INTENT without JOB: call may or may not have run */
    LCR_R_NO_ANCHOR,  /* JOB without ANCHOR: unit may still exist */
    LCR_R_QUERY,      /* read-only snapshot failed or was malformed */
    LCR_R_BOOT,       /* current boot differs from INTENT boot / unverifiable */
    LCR_R_BUS,        /* system bus instance differs from INTENT */
    LCR_R_MANAGER,    /* systemd manager unique owner differs from INTENT */
    LCR_R_COLLECTED,  /* NoSuchUnit without a prior absence receipt */
    LCR_R_INVOCATION, /* unit present under another InvocationID / ControlGroup */
    LCR_R_TRANSIENT,  /* exact unit with job or activating/deactivating state */
    LCR_R_NO_PIN,     /* no retained original cgroup descriptor: cannot prove */
    LCR_R_UNPROVEN,   /* observer absence or cleanup proof not established */
    LCR_R_RELEASED,   /* ledger slot already durably RELEASED (ABSENT_PROVEN) */
};
struct lcr;
struct lcr_config {
    struct lco *owner; /* the single startup owner; borrowed, outlives lcr */
    uint64_t slot;     /* durable lifecycle slot this journal belongs to */
    int journal_fd;    /* protected create journal; read only (O_RDONLY or O_RDWR) */
    /* Observer inputs from the owner's protected launch-time record, never from
     * the journal or a peer. cgroup_fd < 0 (descriptor lost, e.g. after a
     * crash) leaves absence unprovable: never better than LCR_UNKNOWN. */
    int boot_fd, cgroup_fd;
    uid_t trusted_uid; /* journal/boot/cgroup owner; production MUST be 0 */
    dev_t cgroup_device;
    ino_t cgroup_inode;
    void *context;
    int (*lifetime_fenced)(void *, const struct lc_entry *); /* see lso_config */
};
/* Duplicates journal_fd CLOEXEC and takes flock(LOCK_EX|LOCK_NB) on that open
 * file description for the handle lifetime (another description's holder, e.g.
 * an in-flight creator, makes open fail with EWOULDBLOCK). Same-description
 * exclusion is the caller's duty, exactly as for lsc_open. */
int lcr_open(const struct lcr_config *, struct lcr **);
/* Re-reads and re-validates the journal on every call. Keep one handle alive
 * across cleanup retries: the observer's absence receipt is in memory only.
 * Returns 0 with *verdict set (UNKNOWN is a normal result), -1 on caller error
 * (verdict still UNKNOWN). Never releases unless verdict is ABSENT_PROVEN. */
int lcr_reconcile(struct lcr *, enum lcr_verdict *, enum lcr_reason *);
void lcr_close(struct lcr *);
/* Trusted test/embedding seam, identical to lso_open_with_ops: the same
 * snapshot/events/removed seams serve the ANCHORED observation and the
 * observer's absence/cleanup proof. Production lcr_open uses lso_bus_snapshot
 * and lso_open (trusted_uid 0, cgroup2 descriptor). */
int lcr_open_with_ops(const struct lcr_config *, const struct lso_ops *, void *, struct lcr **);
/* Exposed for tests: strict parser. Returns the number of complete lines
 * accepted (0..3) or -1 and sets *reason. */
struct lcr_journal {
    uint64_t slot, principal;
    unsigned job;
    char epoch[33], boot[37], user[37], workspace[37], launch[33], unit[100],
        bus_id[33], manager[128], invocation[33], cgroup[512];
};
int lcr_parse(const char *bytes, size_t length, struct lcr_journal *, enum lcr_reason *);
#define LCR_JOURNAL_MAX 1024
#endif
