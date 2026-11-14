#define _POSIX_C_SOURCE 200809L
#include <unistd.h>
/* Protected containment anchor, NOT a launcher. No command parsing, exec, fork,
 * environment access, file IO, IPC or workload startup. Install is forbidden in
 * this increment. Production requires this exact reviewed artifact and every
 * ancestor root-owned/non-writable; ordinary checkout ownership is NOT enough.
 * Default SIGTERM/SIGINT semantics terminate it; Restart=no prevents respawn.
 */
int main(int argc,char **argv) {
    (void)argv;
    if (argc!=1 || getuid()!=0 || geteuid()!=0) return 64;
    for (;;) (void)pause();
}
