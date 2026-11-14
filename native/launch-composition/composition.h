#ifndef STEP_LAUNCH_COMPOSITION_H
#define STEP_LAUNCH_COMPOSITION_H
#include "../launch-lifecycle/lifecycle.h"
#include "../quota-broker/launch-request.h"
/* Trusted startup owner only; synthetic/uninstalled. No second lifecycle authority.
 * Explicitly provision lc first. Open fences the complete ledger before any slot.
 * All callbacks synchronous, non-reentrant; caller drains users before close and
 * closes this owner before qb_close. Protected directory ancestry is caller policy.
 */
struct lco;
struct lco_config {
    struct lc_config lifecycle;
    struct qb *broker;
    void *context;
    int (*spawn)(void *, const struct lc_entry *, const struct qb_workspace_receipt *);
};
struct lco_slot {
    int state_fd;
    uid_t peer_uid;
    char user[37], workspace[37], launch[33];
    struct qb_launch_identity identity;
};
int lco_open(const struct lco_config *, struct lco **);
/* One attached outcome slot at a time; detach never releases its reservation.
 * Prepare reserves durably BEFORE establishing a fresh outcome. Any later error
 * retains that reservation. Never retry preparation as repair of existing state.
 * Wire incarnation and launch ID both equal the ledger's globally unique launch.
 */
int lco_prepare(struct lco *, const struct lco_slot *, struct lc_entry *);
int lco_attach(struct lco *, uint64_t slot, const struct lco_slot *);
int lco_serve(struct lco *, int connected_socket);
int lco_detach(struct lco *);
int lco_get(struct lco *, uint64_t slot, struct lc_entry *);
/* Each trusted proof receives the EXACT durable incarnation including old boot,
 * epoch, container and launch. Return 1 only for proven absence/cleanup, 0 unknown,
 * -1 error. Cleanup runs only after absence. Anything but both 1 retains capacity.
 * STARTED is callback outcome only, NEVER readiness or proof of process absence.
 */
int lco_reconcile(struct lco *, uint64_t slot,
                  int (*absent)(void *, const struct lc_entry *),
                  int (*clean)(void *, const struct lc_entry *), void *);
void lco_close(struct lco *);
#endif
