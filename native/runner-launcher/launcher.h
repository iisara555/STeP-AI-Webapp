/* step-runner protected launcher: the ONLY program the gateway account may run as step-runner.
 *
 * It accepts one fixed-format request (argv), verifies the descriptors it was handed, and execs
 * /usr/bin/bwrap with a compiled-in argument vector. Nothing of the caller's environment reaches
 * bwrap, and the sandbox always has its own user namespace (--unshare-user --disable-userns):
 * outside one, a file owner can clear its project id and escape the XFS quota
 * (docs/native-quota-xfs-acceptance.md).
 *
 * Request:  launch v1 p<ID>/<workspace-uuid> <launch-id> <tmpfs-bytes>
 *   fd 0  nonce/key for the runtime, passed through unread
 *   fd 1  the workspace directory, opened O_RDONLY|O_DIRECTORY by the gateway (bound with --bind-fd 1)
 *   fd 2  diagnostics
 */
#ifndef STEP_RUNNER_LAUNCHER_H
#define STEP_RUNNER_LAUNCHER_H

#include <linux/limits.h> /* PATH_MAX */
#include <sys/types.h>

/* Production locations (compiled in; the testing build prefixes each with a scratch directory). */
#define SRL_BWRAP "/usr/bin/bwrap"
#define SRL_BROKER_DIR "/mnt/step-work/step-ai-broker"
#define SRL_BROKER_ROOT SRL_BROKER_DIR "/root"
#define SRL_SOCKET_ROOT "/var/lib/step-runner-launch/sockets"
#define SRL_APP_ROOT "/opt/step/app"
#define SRL_NODE_DIR "/opt/step/node/bin"
#define SRL_NODE SRL_NODE_DIR "/node"
#define SRL_RUNNER_UID 995
#define SRL_RUNNER_GID 983
#define SRL_GATEWAY_UID 1000
#define SRL_GATEWAY_GID 1000

#define SRL_PROJECT_FIRST 100000UL
#define SRL_PROJECT_LAST 199999UL
#define SRL_TMPFS_MIN 65536ULL
#define SRL_TMPFS_MAX 1073741824ULL /* 1 GiB; must be a multiple of SRL_TMPFS_MIN */
#define SRL_SANDBOX_SOCKET_DIR "/run/step-runtime"
#define SRL_SOCKET_FD 3
#define SRL_MAX_ARGS 96
/* Relative to the app root; must match the staged app (server/test checks the TS side agrees). */
#define SRL_TSX_LOADER "node_modules/tsx/dist/loader.mjs"
#define SRL_REGISTER "server/src/register.mjs"
#define SRL_ENTRY "server/src/workspace/runtime-main.ts"

struct srl_config {
    const char *bwrap;       /* exec target */
    const char *broker_dir;  /* .../step-ai-broker, root-owned, not group/other-writable */
    const char *broker_root; /* .../step-ai-broker/root, root:gateway 0710 */
    const char *socket_root; /* gateway-owned 0711 directory in a root-owned parent */
    const char *app_root;    /* root-owned, read-only for everybody else */
    const char *node_dir;
    const char *node;
    uid_t runner_uid;
    gid_t runner_gid;
    uid_t gateway_uid;
    gid_t gateway_gid;
    uid_t root_uid; /* owner of the broker directories and trusted paths (0 in production) */
    int check_projid; /* production: the workspace must carry project <ID> + PROJINHERIT */
    int check_groups; /* production: no supplementary group other than runner_gid */
    /* Trusted-path checks walk up to and including this directory. Production: NULL = "/". */
    const char *trusted_floor;
};

struct srl_request {
    unsigned long project;
    char uuid[37];
    char launch_id[33];
    unsigned long long tmpfs_bytes;
    char tmpfs[24];
    char workspace_id[36]; /* ws_<32 hex> */
    char user_dir[PATH_MAX];
    char mount[PATH_MAX]; /* user_dir/<uuid>: host path, also the mount point in the sandbox */
    char files[PATH_MAX];
    char socket_dir[PATH_MAX];
    char node_args[3][PATH_MAX]; /* tsx loader URL, register URL, entry path */
    char app_binds[5][PATH_MAX];
};

enum srl_error {
    SRL_OK = 0,
    SRL_E_USAGE,          /* argv is not exactly one valid v1 request */
    SRL_E_CREDENTIALS,    /* not running as exactly the runner account */
    SRL_E_DESCRIPTORS,    /* fd 0, 1 or 2 is not open */
    SRL_E_TRUSTED_PATH,   /* bwrap/app/node not a root-owned, non-writable chain */
    SRL_E_BROKER_ROOT,    /* broker directories missing or wrong owner/mode */
    SRL_E_WORKSPACE,      /* fd 1 is not an O_RDONLY directory runner:gateway 02750 */
    SRL_E_DEVICE,         /* fd 1 is not on the broker filesystem */
    SRL_E_LOCATION,       /* fd 1 is not <broker_root>/p<ID>/<uuid> as requested */
    SRL_E_PARENT,         /* the parent of fd 1 is not a root:gateway 0750 p<ID> */
    SRL_E_PROJECT,        /* fd 1 does not carry project <ID> with PROJINHERIT */
    SRL_E_FILES,          /* <workspace>/files is not a runner-owned directory */
    SRL_E_SOCKET,         /* socket directory missing, a symlink or wrong owner/mode */
    SRL_E_INTERNAL,
};

const char *srl_error_name(int error);

/* Pure: validate argv against the fixed format and derive every path from the config. */
int srl_parse(const struct srl_config *cfg, int argc, char *const argv[], struct srl_request *req);

/* Pure: the complete bwrap argv (argv[0] = cfg->bwrap), NULL-terminated; returns the count. */
int srl_build_argv(const struct srl_config *cfg, const struct srl_request *req, char *out[SRL_MAX_ARGS]);

/* Pure predicate on FS_IOC_FSGETXATTR results. */
int srl_project_ok(const struct srl_request *req, unsigned int projid, unsigned int xflags);

int srl_check_credentials(const struct srl_config *cfg);
int srl_check_trusted_paths(const struct srl_config *cfg);
/* Verifies the descriptor's path-independent identity and its fixed location in the broker tree. */
int srl_check_workspace_fd(const struct srl_config *cfg, const struct srl_request *req, int fd);
/* Opens the socket directory O_PATH|O_NOFOLLOW, verifies it and leaves it as SRL_SOCKET_FD. */
int srl_open_socket_dir(const struct srl_config *cfg, const struct srl_request *req);

/* The whole launch. Returns only on refusal (an srl_error) or a failed execve (SRL_E_INTERNAL). */
int srl_launch(const struct srl_config *cfg, int argc, char *const argv[]);

#endif
