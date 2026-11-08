#ifndef STEP_SYSTEMD_OBSERVER_H
#define STEP_SYSTEMD_OBSERVER_H
#include "composition.h"
#include <sys/types.h>
/* Trusted local API; NEVER populate from a request. No create/stop mutations.
 * Each instance owns duplicated protected descriptors and ONE durable entry.
 * Serialize all calls, including close, under the startup owner's fence.
 */
struct lso;
struct lso_snapshot {
    char bus_id[33], manager[128], invocation[33], cgroup[512], state[32];
    unsigned job;
    int missing; /* only explicit org.freedesktop.systemd1.NoSuchUnit */
};
struct lso_config {
    struct lc_entry entry;
    int boot_fd, cgroup_fd; /* pinned boot_id and original cgroup v2 directory */
    uid_t trusted_uid; /* production MUST be 0 */
    dev_t cgroup_device;
    ino_t cgroup_inode;
    char bus_id[33], manager[128], invocation[33], cgroup[512];
    void *context;
    /* Return 1 ONLY while owner has exclusive, durable nonreuse authority for
     * this exact entry, all possible descendants confined to original subtree,
     * permanently fenced starts/restarts/attaches (including external actors),
     * and no in-flight create/start/attach or escaped process. Held across both
     * proof callbacks and release. Missing/unverifiable prerequisites => 0.
     * A lock alone, systemd job==0, or matching UID does NOT establish this.
     */
    int (*lifetime_fenced)(void *, const struct lc_entry *);
};
/* Uses libsystemd sd-bus runtime ABI, system bus only. Bounded synchronous reads
 * addressed to expected unique manager owner, not an untrusted shell command.
 */
int lso_open(const struct lso_config *, struct lso **);
int lso_absent(void *, const struct lc_entry *);
int lso_clean(void *, const struct lc_entry *);
int lso_reconcile(struct lso *, struct lco *, uint64_t slot);
void lso_close(struct lso *);
/* Explicit trusted test/embedding seams; never selectable by a peer. Read must
 * fill a fresh complete snapshot, validate bus signatures/errors, and bracket
 * manager ownership. Events receives borrowed original directory descriptor.
 * Production lso_open always uses actual syscalls, cgroup2 and sd-bus.
 */
struct lso_ops {
    int (*snapshot)(void *, const char *, const char *, struct lso_snapshot *);
    int (*events)(void *, int, int *);
    int (*removed)(void *, int);
};
int lso_open_with_ops(const struct lso_config *, const struct lso_ops *, void *, struct lso **);
/* The production read-only snapshot reader (the default lso_ops.snapshot):
 * root system-bus peer, expected root manager owner bracketing GetUnit and
 * Get(ControlGroup/ActiveState/InvocationID/Job). Never mutates systemd. */
int lso_bus_snapshot(void *, const char *unit, const char *manager, struct lso_snapshot *);
#endif
