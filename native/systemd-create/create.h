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
    int journal_fd; /* fresh protected root-owned regular 0600 file, nlink 1, opened
                     O_RDWR, preprovisioned; caller fsyncs parent before use and
                     retains it forever with entry. Single-use scope: README. */
    char bus_id[33], manager[128]; /* protected expected system-bus generation */
    void *context;
    int (*exclusive)(void *, const struct lc_entry *); /* exactly 1 required;
      certifies current boot, lock ownership, no alternate create/start/attach,
      never-reused unit name, no outstanding prior attempt. Not a UID check. */
};
struct lsc_receipt { unsigned job; char invocation[33], cgroup[512]; };
int lsc_open(const struct lsc_config *, struct lsc **);
int lsc_begin(struct lsc *); /* one attempt only, durable INTENT before enqueue */
int lsc_poll(struct lsc *); /* nonblocking dispatch of at most 32 bus messages, then
                            deadline-bounded synchronous readback (each call capped
                            at the time left) after the exact successful
                            JobRemoved; 1 anchored, 0 still pending, -1 terminal */
/* Event-loop integration; each returns -1 unless the handle is LSC_PENDING.
 * lsc_fd: bus socket for poll(2); owned by the handle, never close/read it.
 * lsc_events: poll(2) event mask to wait for on lsc_fd.
 * lsc_timeout: relative CLOCK_MONOTONIC microseconds until lsc_poll must run
 * even without readiness: min(sd-bus internal timeout, 5 s attempt deadline);
 * 0 means call lsc_poll now. */
int lsc_fd(const struct lsc *);
int lsc_events(const struct lsc *);
int lsc_timeout(const struct lsc *, uint64_t *usec);
enum lsc_status lsc_status(const struct lsc *);
int lsc_receipt(const struct lsc *, struct lsc_receipt *);
void lsc_close(struct lsc *); /* unsubscribes locally only; NEVER cancels job/kills */
#endif
