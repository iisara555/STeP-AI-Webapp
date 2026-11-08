#ifndef STEP_SYSTEMD_CREATE_H
#define STEP_SYSTEMD_CREATE_H
#include "../launch-lifecycle/lifecycle.h"
/* Trusted local API only; no peer-selectable command, properties, paths or limits.
 * Owner serializes calls and holds exclusive durable nonreuse/start/attach
 * authority throughout. Every nonempty journal is pending at startup until
 * separately reconciled, including intent-only / failed / timed-out calls.
 * Never release reservation from this module's return value or anchored receipt.
 */
struct lsc;
enum lsc_status { LSC_NEW, LSC_PENDING, LSC_ANCHORED, LSC_UNCERTAIN };
struct lsc_config {
    struct lc_entry entry; /* authoritative LC_STARTING record */
    int journal_fd; /* fresh protected root-owned regular 0600 file, preprovisioned;
                     caller fsyncs parent before use, retains forever with entry */
    char bus_id[33], manager[128]; /* protected expected system-bus generation */
    void *context;
    int (*exclusive)(void *, const struct lc_entry *); /* exactly 1 required;
      certifies current boot, lock ownership, no alternate create/start/attach,
      never-reused unit name, no outstanding prior attempt. Not a UID check. */
};
struct lsc_receipt { unsigned job; char invocation[33], cgroup[512]; };
int lsc_open(const struct lsc_config *, struct lsc **);
int lsc_begin(struct lsc *); /* one attempt only, durable INTENT before enqueue */
int lsc_poll(struct lsc *); /* nonblocking dispatch; bounded synchronous readback
                            after exact successful JobRemoved; caller pumps */
enum lsc_status lsc_status(const struct lsc *);
int lsc_receipt(const struct lsc *, struct lsc_receipt *);
void lsc_close(struct lsc *); /* unsubscribes locally only; NEVER cancels job/kills */
#endif
