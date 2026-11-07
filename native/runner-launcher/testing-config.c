#define _GNU_SOURCE
#include "testing-config.h"

#include <stdio.h>
#include <unistd.h>

static int join(char out[PATH_MAX], const char *prefix, const char *path) {
    int n = snprintf(out, PATH_MAX, "%s%s", prefix, path);
    return n > 0 && n < PATH_MAX ? 0 : -1;
}

int srl_testing_config(const char *prefix, struct srl_config *cfg, struct srl_testing_paths *p) {
    if (!prefix || prefix[0] != '/') return -1;
    if (join(p->bwrap, prefix, SRL_BWRAP) || join(p->broker_dir, prefix, SRL_BROKER_DIR) ||
        join(p->broker_root, prefix, SRL_BROKER_ROOT) || join(p->socket_root, prefix, SRL_SOCKET_ROOT) ||
        join(p->app_root, prefix, SRL_APP_ROOT) || join(p->node_dir, prefix, SRL_NODE_DIR) ||
        join(p->node, prefix, SRL_NODE))
        return -1;
    *cfg = (struct srl_config){
        .bwrap = p->bwrap,
        .broker_dir = p->broker_dir,
        .broker_root = p->broker_root,
        .socket_root = p->socket_root,
        .app_root = p->app_root,
        .node_dir = p->node_dir,
        .node = p->node,
        .runner_uid = getuid(),
        .runner_gid = getgid(),
        .gateway_uid = getuid(),
        .gateway_gid = getgid(),
        .root_uid = getuid(),
        .check_projid = 0,
        .check_groups = 0,
        .trusted_floor = prefix,
    };
    return 0;
}
