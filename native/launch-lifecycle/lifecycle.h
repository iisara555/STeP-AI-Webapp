#ifndef STEP_LIFECYCLE_H
#define STEP_LIFECYCLE_H
#include <stdint.h>
/* Trusted local API only; no wire protocol or production linkage. */
struct lc;
enum lc_state { LC_RESERVED=1, LC_STARTING, LC_RUNNING, LC_STOPPING, LC_FENCED, LC_RELEASED };
enum lc_proof { LC_UNKNOWN=0, LC_PRESENT, LC_ABSENT_AND_CLEAN };
struct lc_config { int directory_fd; uint64_t capacity; char epoch[33], boot[37]; };
struct lc_entry {
    uint64_t slot, principal;
    enum lc_state state;
    char epoch[33], boot[37], user[37], workspace[37], launch[33], container[90];
};
/* Establish is explicit operator provisioning, never automatic repair. */
int lc_establish(const struct lc_config *);
/* Existing ledger only. Durably fences every nonterminal entry before success. */
int lc_open(const struct lc_config *, struct lc **);
int lc_reserve(struct lc *, uint64_t principal, const char *user, const char *workspace,
               const char *launch, struct lc_entry *);
int lc_transition(struct lc *, uint64_t slot, enum lc_state);
/* Callback is synchronous, trusted, non-reentrant; never a PID/ENOENT heuristic.
 * ABSENT_AND_CLEAN certifies incarnation-bound descendant absence AND metadata cleanup.
 * Release is durable/idempotent; all other proofs retain capacity and recovery fence. */
int lc_reconcile(struct lc *, uint64_t slot,
                 enum lc_proof (*)(void *, const struct lc_entry *), void *);
int lc_get(struct lc *, uint64_t slot, struct lc_entry *);
void lc_close(struct lc *);
#endif
