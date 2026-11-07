/* Entry point. The production build has a compiled-in configuration and reads no environment.
 * The TESTING build (-DSRL_TESTING, never installed) takes a scratch prefix from SRL_TEST_ROOT and
 * refuses to run as root or as the production runner uid. */
#define _GNU_SOURCE
#include "launcher.h"

#include <stdio.h>
#include <unistd.h>

#ifdef SRL_TESTING
#include "testing-config.h"
#include <stdlib.h>
#endif

int main(int argc, char **argv) {
#ifdef SRL_TESTING
    static struct srl_config cfg;
    static struct srl_testing_paths paths;
    uid_t uid = getuid();
    if (uid == 0 || geteuid() == 0 || uid == SRL_RUNNER_UID ||
        srl_testing_config(getenv("SRL_TEST_ROOT"), &cfg, &paths) != 0) {
        fputs("step-runner-launch (TESTING build): REFUSED testing\n", stderr);
        return 2;
    }
#else
    static const struct srl_config cfg = {
        .bwrap = SRL_BWRAP,
        .broker_dir = SRL_BROKER_DIR,
        .broker_root = SRL_BROKER_ROOT,
        .socket_root = SRL_SOCKET_ROOT,
        .app_root = SRL_APP_ROOT,
        .node_dir = SRL_NODE_DIR,
        .node = SRL_NODE,
        .runner_uid = SRL_RUNNER_UID,
        .runner_gid = SRL_RUNNER_GID,
        .gateway_uid = SRL_GATEWAY_UID,
        .gateway_gid = SRL_GATEWAY_GID,
        .root_uid = 0,
        .check_projid = 1,
        .check_groups = 1,
        .trusted_floor = NULL,
    };
#endif
    int error = srl_launch(&cfg, argc, argv);
    /* fd 2 is the caller's; a refusal names only the failed check, never request contents. */
    fprintf(stderr, "step-runner-launch: REFUSED %s\n", srl_error_name(error));
    return 2;
}
