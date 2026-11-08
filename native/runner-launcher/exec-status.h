/* Private service-child status, never launch authority or runtime readiness. */
#ifndef SRL_EXEC_STATUS_H
#define SRL_EXEC_STATUS_H
#include <sys/types.h>
#define SRL_STATUS_FD 4
#define SRL_STATUS_MAGIC 0x53524c31U
#define SRL_STATUS_ENTERED 1U
#define SRL_STATUS_VALIDATED 2U
#define SRL_STATUS_FAILED 3U
/* Trusted post-fork fixed-exec stub only, before launcher ENTERED. */
#define SRL_STATUS_LAUNCH_EXEC_FAILED 4U
struct srl_exec_status {
    unsigned int stage;
    unsigned int error;
    unsigned int exec_errno;
    int eof; /* Even after VALIDATED: exec-or-death ambiguity, NOT success. */
    int invalid;
};
/* Fixed AF_UNIX SOCK_SEQPACKET peer created by trusted root service BEFORE fork/drop.
 * No received descriptors, commands, secrets or caller-selected FD numbers. */
int srl_status_prepare(uid_t trusted_peer);
int srl_status_send(unsigned int stage, unsigned int error, unsigned int exec_errno);
/* Nonblocking single-record observation: 1 frame, 0 EOF, -1 error/EAGAIN.
 * Malformed/order/ancillary failures poison the observation permanently. */
int srl_status_receive(int fd, struct srl_exec_status *status);
#endif
