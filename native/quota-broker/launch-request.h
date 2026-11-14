#ifndef STEP_LAUNCH_REQUEST_H
#define STEP_LAUNCH_REQUEST_H
#include "core.h"
/* One protected, pre-prepared launch slot. No peer-provided paths, credentials,
 * executable, argv, environment, quota identity or descriptors. Caller authenticates
 * end users before preparing this slot; peer_uid is the fixed gateway principal.
 * Workloads MUST be isolated from that principal. State directory and ancestors
 * must be protected from peers, workloads and replacement. A slot is never reset.
 * To authorize another slot requires trusted lifecycle/absence reconciliation.
 * Callback must synchronously spawn the ONE fixed-policy child, obeying core.h.
 * No callback default: ENOTSUP. No installed principal-switch helper is provided.
 */
struct qbl_config {
    struct qb *broker;
    int state_fd;
    uid_t peer_uid;
    char user[37], workspace[37], incarnation[33], launch_id[33];
    struct qb_launch_identity identity;
    void *context;
    int (*spawn)(void *, const char *launch_id, const struct qb_workspace_receipt *borrowed);
};
struct qbl;
/* Trusted operator only, never request handling: exclusive establishment after
 * lifecycle census. Never call automatically on open failure or missing state. */
int qbl_establish(const struct qbl_config *);
/* Existing state only. Missing/truncated/mismatched state refuses, never resets. */
int qbl_open(const struct qbl_config *, struct qbl **);
/* Connected AF_UNIX STREAM, NONBLOCK + CLOEXEC, borrowed; one bounded frame + EOF.
 * LAUNCH/1 <32 lowercase hex incarnation> <32 lowercase hex launch ID>\n
 * STATUS/1 <same>\n (both 75 bytes). SO_PEERCRED checked BEFORE read/parse/reply.
 * 500ms absolute I/O deadline; cannot cancel synchronous core/callback/fsync.
 * Replies STARTED (callback success, NOT runtime health), DENIED (no callback),
 * UNKNOWN (callback error/crash/pending), EMPTY (status before first request).
 * Any uncertain outcome is terminal, never automatically resubmitted. Replays
 * only report the persisted outcome, never authorize/spawn another process.
 * Single in-flight connection per caller; mutex serializes uses of this slot.
 */
int qbl_serve(struct qbl *, int connected_socket);
/* Caller MUST drain/join socket users before close; close before qb_close. */
void qbl_close(struct qbl *);
#endif
