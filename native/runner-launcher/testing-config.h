/* TESTING ONLY: the production layout below a scratch prefix, with the caller's own uid/gid
 * standing in for root, step-runner and the gateway. Never linked into the installed launcher. */
#ifndef STEP_RUNNER_LAUNCHER_TESTING_CONFIG_H
#define STEP_RUNNER_LAUNCHER_TESTING_CONFIG_H

#include "launcher.h"

struct srl_testing_paths {
    char bwrap[PATH_MAX], broker_dir[PATH_MAX], broker_root[PATH_MAX], socket_root[PATH_MAX];
    char app_root[PATH_MAX], node_dir[PATH_MAX], node[PATH_MAX];
};

/* Returns 0, or -1 if the prefix is not absolute or too long. */
int srl_testing_config(const char *prefix, struct srl_config *cfg, struct srl_testing_paths *paths);

#endif
