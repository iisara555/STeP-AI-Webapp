#define _GNU_SOURCE
#include "core.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef NDEBUG
#error Tests require assertions
#endif

/* Link-time syscall adapter used only by tests to fail one journal sync. */
static uint64_t fail_sync_inode;
int __real_fsync(int fd);
int __wrap_fsync(int fd);
int __wrap_fsync(int fd) {
    struct stat s;
    if (fail_sync_inode && fstat(fd, &s) == 0 && (uint64_t)s.st_ino == fail_sync_inode) {
        fail_sync_inode = 0; errno = EIO; return -1;
    }
    return __real_fsync(fd);
}
/* Synthetic ioctl model ONLY. No ioctl/quotactl/mount/root path is executed. */
struct model {
    uint8_t uuid[16];
    int enforced, configure_calls, fail, corrupt, crash, entered, release, block, substitute;
    struct { uint64_t inode; struct qb_observation value; } slots[QB_MAX_GRANTS];
    pthread_mutex_t gate;
    pthread_cond_t changed;
};
struct fixture {
    char path[4096];
    int base, root, state;
    struct qb_policy policy;
    struct qb_adapter adapter;
    struct model model;
    struct qb *broker;
};
static int mock_mount(void *context, int fd, uint8_t uuid[16], int *enforced) {
    struct model *m = context;
    struct stat s; assert(fstat(fd, &s) == 0 && S_ISDIR(s.st_mode));
    memcpy(uuid, m->uuid, 16); *enforced = m->enforced; return 0;
}
static int mock_observe(void *context, int mount_fd, int fd, uint32_t project,
                        struct qb_observation *out) {
    struct model *m = context;
    struct stat s, root;
    assert(fstat(fd, &s) == 0 && fstat(mount_fd, &root) == 0 && s.st_dev == root.st_dev);
    assert(project >= 100000 && project < 100000 + QB_MAX_GRANTS);
    unsigned int index = project - 100000;
    struct stat parent;
    if (m->slots[index].inode == (uint64_t)s.st_ino) *out = m->slots[index].value;
    /* XFS PROJINHERIT model: a directory created inside a project directory inherits it. */
    else if (m->slots[index].inode && fstatat(fd, "..", &parent, 0) == 0 &&
             (uint64_t)parent.st_ino == m->slots[index].inode) *out = m->slots[index].value;
    else memset(out, 0, sizeof(*out));
    if (m->corrupt == 1) out->inodes_hard++;
    if (m->corrupt == 2) out->bytes_hard++;
    if (m->corrupt == 3) out->inherit = 0;
    if (m->corrupt == 4) out->project++;
    return 0;
}
static int mock_configure(void *context, int mount_fd, int fd, uint32_t project,
                         uint64_t bytes, uint64_t inodes) {
    struct model *m = context;
    struct stat s, root;
    assert(fstat(fd, &s) == 0 && fstat(mount_fd, &root) == 0 && s.st_dev == root.st_dev);
    m->configure_calls++;
    assert(pthread_mutex_lock(&m->gate) == 0);
    m->entered = 1; assert(pthread_cond_broadcast(&m->changed) == 0);
    while (m->block && !m->release) assert(pthread_cond_wait(&m->changed, &m->gate) == 0);
    assert(pthread_mutex_unlock(&m->gate) == 0);
    if (m->crash) _exit(73); /* reservation + directory identity must already survive */
    if (m->fail) { errno = EIO; return -1; }
    if (m->substitute) {
        assert(project == 100000);
        assert(renameat(mount_fd, "p100000", mount_fd, "pinned-original") == 0);
        assert(mkdirat(mount_fd, "p100000", 0700) == 0);
    }
    unsigned int index = project - 100000;
    assert(index < QB_MAX_GRANTS);
    m->slots[index].inode = (uint64_t)s.st_ino;
    m->slots[index].value = (struct qb_observation){.project = project, .bytes_hard = bytes,
                                                  .inodes_hard = inodes, .inherit = 1};
    return 0;
}
static void fixture_init(struct fixture *f) {
    memset(f, 0, sizeof(*f));
    const char *tmp = getenv("TMPDIR"); assert(tmp && tmp[0] == '/');
    int n = snprintf(f->path, sizeof(f->path), "%s/step-quota-core-XXXXXX", tmp);
    assert(n > 0 && (size_t)n < sizeof(f->path));
    assert(mkdtemp(f->path));
    f->base = open(f->path, O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(f->base >= 0);
    assert(mkdirat(f->base, "roots", 0700) == 0 && mkdirat(f->base, "state", 0700) == 0);
    f->root = openat(f->base, "roots", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    f->state = openat(f->base, "state", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(f->root >= 0 && f->state >= 0);
    struct stat s; assert(fstat(f->root, &s) == 0);
    f->policy.root_device = (uint64_t)s.st_dev; f->policy.root_inode = (uint64_t)s.st_ino;
    f->policy.epoch[0] = 19; f->policy.mount_uuid[0] = 42;
    f->policy.bytes_hard = 1048576; f->policy.inodes_hard = 100;
    f->policy.first_project = 100000; f->policy.last_project = 100063;
    f->policy.grant_count = 10;
    for (uint32_t i = 0; i < f->policy.grant_count; i++) {
        f->policy.grants[i].peer_uid = (uint32_t)geteuid();
        n = snprintf(f->policy.grants[i].workspace, 40, "12345678-1234-4234-8234-%012u", i);
        assert(n == 36);
    }
    f->model.enforced = 1; memcpy(f->model.uuid, f->policy.mount_uuid, 16);
    assert(pthread_mutex_init(&f->model.gate, NULL) == 0);
    assert(pthread_cond_init(&f->model.changed, NULL) == 0);
    f->adapter = (struct qb_adapter){.context = &f->model, .mount = mock_mount,
                                    .observe = mock_observe, .configure = mock_configure};
}
static void start(struct fixture *f) {
    assert(qb_open(f->root, f->state, &f->policy, &f->adapter, &f->broker) == 0);
}
static void bootstrap(struct fixture *f) { assert(qb_bootstrap(f->state, &f->policy) == 0); start(f); }
static int remove_fixture(const char *p, const struct stat *s, int type, struct FTW *walk) {
    (void)s; (void)type; (void)walk; return remove(p);
}
static void cleanup(struct fixture *f) {
    qb_close(f->broker); close(f->root); close(f->state); close(f->base);
    assert(pthread_mutex_destroy(&f->model.gate) == 0);
    assert(pthread_cond_destroy(&f->model.changed) == 0);
    assert(nftw(f->path, remove_fixture, 16, FTW_DEPTH | FTW_PHYS) == 0);
}
static int ensure_as(struct fixture *f, unsigned int index, uid_t peer, struct qb_receipt *out) {
    char frame[47];
    int n = snprintf(frame, sizeof(frame), "ENSURE/1 %s\n", f->policy.grants[index].workspace);
    assert(n == 46);
    return qb_ensure(f->broker, peer, frame, 46, out);
}
static int ensure(struct fixture *f, unsigned int index, struct qb_receipt *out) {
    return ensure_as(f, index, geteuid(), out);
}
static void protocol(void) {
    char id[37];
    const char valid[] = "ENSURE/1 12345678-1234-4234-8234-123456789abc\n";
    assert(qb_request(valid, sizeof(valid)-1, id) == 0);
    assert(!strcmp(id, "12345678-1234-4234-8234-123456789abc"));
    assert(qb_request(NULL, 46, id) < 0);
    for (size_t n = 0; n < sizeof(valid)-1; n++) assert(qb_request(valid, n, id) < 0);
    assert(qb_request(valid, sizeof(valid), id) < 0);
    char bad[47]; memcpy(bad, valid, sizeof(bad));
    for (size_t i = 0; i < sizeof(bad)-1; i++) {
        char saved = bad[i]; bad[i] = '\0';
        assert(qb_request(bad, 46, id) < 0); bad[i] = saved;
    }
    const char *extra[] = {"../etc", "ENSURE/1 /etc\n", "ENSURE/1 {}\n", "CLEAR/1 x\n",
                          "{\"workspaceId\":\"x\",\"projectId\":100000}",
                          "ENSURE/1 12345678-1234-4234-8234-123456789abc\n4096"};
    for (size_t i = 0; i < sizeof(extra)/sizeof(extra[0]); i++) assert(qb_request(extra[i], strlen(extra[i]), id) < 0);
    memcpy(bad, valid, sizeof(bad)); bad[44] = 'C'; assert(qb_request(bad, 46, id) < 0);
}
static void policy_and_bootstrap(void) {
    struct fixture f; fixture_init(&f);
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &f.broker) < 0 && !f.broker);
    struct stat s; assert(fstatat(f.state, "manifest", &s, 0) < 0 && errno == ENOENT);
    struct qb_policy bad = f.policy; bad.bytes_hard = 1;
    assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.grant_count = 0; assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.grants[1] = bad.grants[0]; assert(qb_bootstrap(f.state, &bad) < 0);
    assert(fchmod(f.state, 0777) == 0 && qb_bootstrap(f.state, &f.policy) < 0);
    assert(fchmod(f.state, 0700) == 0);
    bootstrap(&f);
    assert(qb_bootstrap(f.state, &f.policy) < 0);
    struct qb *second = NULL;
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &second) < 0 && !second);
    qb_close(f.broker); f.broker = NULL;
    bad = f.policy; bad.epoch[0]++;
    assert(qb_open(f.root, f.state, &bad, &f.adapter, &second) < 0);
    bad = f.policy; bad.bytes_hard *= 2;
    assert(qb_open(f.root, f.state, &bad, &f.adapter, &second) < 0);
    assert(qb_open(f.root, f.state, &f.policy, NULL, &second) < 0);
    assert(unlinkat(f.state, "journal", 0) == 0);
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &second) < 0);
    assert(fstatat(f.state, "journal", &s, 0) < 0 && errno == ENOENT);
    cleanup(&f);
}
static void allocate_and_restart(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r;
    assert(ensure_as(&f, 0, (uid_t)(geteuid()+1), &r) < 0 && r.directory_fd == -1);
    assert(f.model.configure_calls == 0);
    assert(ensure(&f, 0, &r) == 0 && r.project == 100000 && r.bytes_hard == 1048576 && r.inodes_hard == 100);
    struct stat s; assert(fstat(r.directory_fd, &s) == 0 && r.inode == (uint64_t)s.st_ino);
    uint64_t inode = r.inode; close(r.directory_fd);
    /* Mutating caller-owned policy/adapter storage cannot change the authority. */
    f.policy.bytes_hard = 4096;
    f.adapter.configure = NULL;
    assert(ensure(&f, 0, &r) == 0 && r.bytes_hard == 1048576); close(r.directory_fd);
    f.policy.bytes_hard = 1048576; f.adapter.configure = mock_configure;
    /* Existing mutable descendants are never recursively traversed or reassigned. */
    int fd = openat(f.root, "p100000/child", O_WRONLY | O_CREAT | O_EXCL, 0600);
    assert(fd >= 0); close(fd);
    assert(ensure(&f, 0, &r) == 0 && r.project == 100000 && r.inode == inode); close(r.directory_fd);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(ensure(&f, 0, &r) == 0 && r.inode == inode); close(r.directory_fd);
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    assert(f.model.configure_calls == 2);
    cleanup(&f);
}
static void foreign_tree(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    assert(mkdirat(f.root, "p100000", 0700) == 0);
    int fd = openat(f.root, "p100000/untouched", O_WRONLY | O_CREAT | O_EXCL, 0600);
    assert(fd >= 0 && write(fd, "foreign", 7) == 7); close(fd);
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 0);
    assert(ensure(&f, 0, &r) < 0 && errno == EOWNERDEAD);
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    struct stat s; assert(fstatat(f.root, "p100000/untouched", &s, 0) == 0 && s.st_size == 7);
    cleanup(&f);
}
static void substitutions(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) == 0); int retained = r.directory_fd;
    assert(renameat(f.root, "p100000", f.root, "original") == 0);
    assert(mkdirat(f.root, "p100000", 0700) == 0);
    assert(ensure(&f, 0, &r) < 0 && errno == ESTALE && r.directory_fd == -1);
    struct stat s; assert(fstat(retained, &s) == 0);
    int original = openat(f.root, "original", O_RDONLY | O_DIRECTORY); assert(original >= 0);
    struct stat old; assert(fstat(original, &old) == 0 && s.st_ino == old.st_ino);
    close(original); close(retained);
    assert(unlinkat(f.root, "p100000", AT_REMOVEDIR) == 0);
    assert(symlinkat("original", f.root, "p100000") == 0);
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 1);
    cleanup(&f);
}
static void substitution_during_adapter(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f); f.model.substitute = 1;
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && r.directory_fd == -1 && errno == ESTALE);
    struct stat original, replacement;
    assert(fstatat(f.root, "pinned-original", &original, 0) == 0);
    assert(fstatat(f.root, "p100000", &replacement, 0) == 0);
    assert(f.model.slots[0].inode == (uint64_t)original.st_ino);
    assert(f.model.slots[0].inode != (uint64_t)replacement.st_ino);
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 1);
    cleanup(&f);
}
static void mount_and_evidence(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r;
    f.model.uuid[0]++;
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 0);
    f.model.uuid[0]--; f.model.enforced = 0;
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 0);
    f.model.enforced = 1;
    assert(ensure(&f, 0, &r) == 0 && r.project == 100000); close(r.directory_fd);
    for (int i = 1; i <= 4; i++) {
        f.model.corrupt = i;
        assert(ensure(&f, 0, &r) < 0 && r.directory_fd == -1 && f.model.configure_calls == 1);
    }
    f.model.corrupt = 0;
    assert(fchmod(f.root, 0777) == 0 && ensure(&f, 0, &r) < 0);
    assert(fchmod(f.root, 0700) == 0);
    assert(fchmodat(f.root, "p100000", 0777, 0) == 0 && ensure(&f, 0, &r) < 0);
    cleanup(&f);
}
static void failure_and_capacity(void) {
    struct fixture f; fixture_init(&f); f.policy.last_project = 100001; bootstrap(&f);
    f.model.fail = 1;
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && r.directory_fd == -1);
    f.model.fail = 0;
    /* A partial/unknown provisioning outcome is observed, never rewritten. */
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 1);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(ensure(&f, 0, &r) < 0 && f.model.configure_calls == 1);
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    assert(ensure(&f, 2, &r) < 0 && errno == ENOSPC);
    cleanup(&f);
}
static void interrupted(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    qb_close(f.broker); f.broker = NULL;
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) {
        start(&f); f.model.crash = 1; struct qb_receipt r;
        (void)ensure(&f, 0, &r); _exit(99);
    }
    int status; assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 73);
    start(&f); struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0); /* no synthetic evidence survived process crash */
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    cleanup(&f);
}
static void uncertain_commit(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct stat s; assert(fstatat(f.state, "journal", &s, 0) == 0);
    fail_sync_inode = (uint64_t)s.st_ino;
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && r.directory_fd == -1 && !fail_sync_inode);
    assert(f.model.configure_calls == 0);
    assert(fstatat(f.root, "p100000", &s, 0) < 0 && errno == ENOENT);
    assert(ensure(&f, 1, &r) < 0); /* all subsequent work is poisoned */
    qb_close(f.broker); f.broker = NULL; start(&f); /* resync before replay */
    assert(ensure(&f, 0, &r) < 0 && errno == EOWNERDEAD);
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    cleanup(&f);
}
static void truncated_live_state(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r; assert(ensure(&f, 0, &r) == 0); close(r.directory_fd);
    int fd = openat(f.state, "journal", O_WRONLY); assert(fd >= 0);
    assert(ftruncate(fd, 0) == 0); close(fd);
    assert(ensure(&f, 0, &r) < 0 && r.directory_fd == -1);
    assert(f.model.configure_calls == 1);
    cleanup(&f);
}
static void cached_revoke_idempotency_and_mount_health(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    const char *workspace = f.policy.grants[0].workspace;
    assert(qb_revoke(f.broker, workspace) == 0);
    struct stat before, after;
    assert(fstatat(f.state, "journal", &before, 0) == 0 && before.st_size > 0);
    assert(qb_revoke(f.broker, workspace) == 0);
    assert(fstatat(f.state, "journal", &after, 0) == 0 && after.st_size == before.st_size);
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && errno == EACCES && r.directory_fd == -1);
    f.model.uuid[0]++;
    assert(qb_revoke(f.broker, workspace) < 0 && errno == EXDEV);
    f.model.uuid[0]--; f.model.enforced = 0;
    assert(qb_revoke(f.broker, workspace) < 0 && errno == EXDEV);
    f.model.enforced = 1;
    assert(qb_revoke(f.broker, workspace) == 0);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(qb_revoke(f.broker, workspace) == 0);
    assert(fstatat(f.state, "journal", &after, 0) == 0 && after.st_size == before.st_size);
    assert(ensure(&f, 0, &r) < 0 && errno == EACCES && r.directory_fd == -1);
    assert(f.model.configure_calls == 0);
    cleanup(&f);
}
static void cached_revoke_truncated_journal(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    const char *workspace = f.policy.grants[0].workspace;
    assert(qb_revoke(f.broker, workspace) == 0); /* no allocation yet */
    int fd = openat(f.state, "journal", O_RDWR | O_CLOEXEC); assert(fd >= 0);
    struct stat s; assert(fstat(fd, &s) == 0 && s.st_size > 0);
    assert(ftruncate(fd, 0) == 0 && fsync(fd) == 0);
    /* Never acknowledge a cached deny whose durable record has disappeared. */
    assert(qb_revoke(f.broker, workspace) < 0 && errno == EIO);
    /* Even restoring the expected size cannot clear the detected corruption. */
    assert(ftruncate(fd, s.st_size) == 0 && fsync(fd) == 0);
    assert(qb_revoke(f.broker, workspace) < 0 && errno == EIO);
    assert(qb_revoke(f.broker, f.policy.grants[1].workspace) < 0 && errno == EIO);
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) < 0 && errno == EIO && r.directory_fd == -1);
    assert(ensure(&f, 1, &r) < 0 && errno == EIO && r.directory_fd == -1);
    assert(f.model.configure_calls == 0);
    /* A well-formed empty rollback is undetectable on restart without an
     * external witness. This is why the retry above MUST NOT report success. */
    assert(ftruncate(fd, 0) == 0 && fsync(fd) == 0); close(fd);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(ensure(&f, 0, &r) == 0 && f.model.configure_calls == 1);
    close(r.directory_fd);
    cleanup(&f);
}
static void corrupt_state(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r; assert(ensure(&f, 0, &r) == 0); close(r.directory_fd);
    qb_close(f.broker); f.broker = NULL;
    int fd = openat(f.state, "journal", O_WRONLY | O_APPEND); assert(fd >= 0);
    assert(write(fd, "x", 1) == 1 && fsync(fd) == 0); close(fd);
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &f.broker) < 0 && !f.broker);
    assert(f.model.configure_calls == 1);
    cleanup(&f);
}
struct call { struct fixture *f; unsigned int index; int result; struct qb_receipt receipt; atomic_int entered, done; };
static void *thread_ensure(void *arg) {
    struct call *c = arg;
    c->result = ensure(c->f, c->index, &c->receipt);
    return NULL;
}
static void *thread_revoke(void *arg) {
    struct call *c = arg;
    atomic_store(&c->entered, 1);
    c->result = qb_revoke(c->f->broker, c->f->policy.grants[c->index].workspace);
    atomic_store(&c->done, 1); return NULL;
}
static void exclusive_process_authority(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) {
        struct qb *other = NULL;
        int result = qb_open(f.root, f.state, &f.policy, &f.adapter, &other);
        if (other) qb_close(other);
        _exit(result < 0 && !other ? 0 : 98);
    }
    int status;
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    struct qb_receipt r; assert(ensure(&f, 0, &r) == 0 && r.project == 100000); close(r.directory_fd);
    cleanup(&f);
}
static void concurrent_ten(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    pthread_t threads[10]; struct call calls[10];
    memset(calls, 0, sizeof(calls));
    for (unsigned int i = 0; i < 10; i++) {
        calls[i].f = &f; calls[i].index = i;
        assert(pthread_create(&threads[i], NULL, thread_ensure, &calls[i]) == 0);
    }
    unsigned int seen = 0;
    for (unsigned int i = 0; i < 10; i++) {
        assert(pthread_join(threads[i], NULL) == 0 && calls[i].result == 0);
        unsigned int offset = calls[i].receipt.project - 100000;
        assert(offset < 10 && !(seen & (1u << offset))); seen |= 1u << offset;
        close(calls[i].receipt.directory_fd);
    }
    assert(seen == 1023 && f.model.configure_calls == 10);
    cleanup(&f);
}
static void revoke_fences_mutation(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    assert(qb_revoke(f.broker, f.policy.grants[1].workspace) == 0);
    struct qb_receipt r;
    assert(ensure(&f, 1, &r) < 0 && errno == EACCES && f.model.configure_calls == 0);
    f.model.block = 1;
    struct call e = {.f = &f, .index = 0}, rev = {.f = &f, .index = 0};
    atomic_init(&rev.entered, 0); atomic_init(&rev.done, 0);
    pthread_t et, rt;
    assert(pthread_create(&et, NULL, thread_ensure, &e) == 0);
    assert(pthread_mutex_lock(&f.model.gate) == 0);
    while (!f.model.entered) assert(pthread_cond_wait(&f.model.changed, &f.model.gate) == 0);
    assert(pthread_mutex_unlock(&f.model.gate) == 0);
    assert(pthread_create(&rt, NULL, thread_revoke, &rev) == 0);
    while (!atomic_load(&rev.entered)) sched_yield();
    /* The revoke API must not COMPLETE while the mutator is blocked. A timed
     * join catches an accidentally unlocked implementation, not just thread
     * scheduling before its first call. No storage/host timeout is weakened. */
    struct timespec deadline; assert(clock_gettime(CLOCK_REALTIME, &deadline) == 0);
    deadline.tv_nsec += 100000000;
    if (deadline.tv_nsec >= 1000000000) { deadline.tv_nsec -= 1000000000; deadline.tv_sec++; }
    assert(pthread_timedjoin_np(rt, NULL, &deadline) == ETIMEDOUT);
    assert(!atomic_load(&rev.done));
    assert(pthread_mutex_lock(&f.model.gate) == 0); f.model.release = 1;
    assert(pthread_cond_broadcast(&f.model.changed) == 0);
    assert(pthread_mutex_unlock(&f.model.gate) == 0);
    assert(pthread_join(et, NULL) == 0 && pthread_join(rt, NULL) == 0);
    assert(e.result == 0 && rev.result == 0); close(e.receipt.directory_fd);
    int writes = f.model.configure_calls;
    assert(ensure(&f, 0, &r) < 0 && errno == EACCES && f.model.configure_calls == writes);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(ensure(&f, 0, &r) < 0 && ensure(&f, 1, &r) < 0);
    assert(qb_revoke(f.broker, f.policy.grants[0].workspace) == 0);
    cleanup(&f);
}
static int workspace_as(struct fixture *f, unsigned int user, const char *ws, uid_t peer,
                        struct qb_workspace_receipt *out) {
    char frame[96];
    int n = snprintf(frame, sizeof(frame), "WORKSPACE/1 %s %s\n", f->policy.grants[user].workspace, ws);
    assert(n == 86);
    return qb_workspace(f->broker, peer, frame, 86, out);
}
static int usage_of(struct fixture *f, unsigned int user, struct qb_usage *out) {
    char frame[64];
    int n = snprintf(frame, sizeof(frame), "USAGE/1 %s\n", f->policy.grants[user].workspace);
    assert(n == 45);
    return qb_usage(f->broker, geteuid(), frame, 45, out);
}
static void expect_dir(int parent, const char *name, uint64_t uid, uint64_t gid, mode_t mode) {
    struct stat c; assert(fstatat(parent, name, &c, AT_SYMLINK_NOFOLLOW) == 0);
    assert(S_ISDIR(c.st_mode) && c.st_uid == uid && c.st_gid == gid && (c.st_mode & 07777) == mode);
}
static const char *ws_a = "aaaaaaaa-0000-4000-8000-000000000001";
static const char *ws_b = "bbbbbbbb-0000-4000-8000-000000000002";
static void shared_layout(void) {
    struct fixture f; fixture_init(&f);
    f.policy.layout = QB_LAYOUT_SHARED;
    f.policy.access_gid = (uint32_t)getegid(); f.policy.content_uid = (uint32_t)geteuid();
    struct qb_policy bad = f.policy; bad.layout = 2; assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.access_gid = 0; assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.content_uid = 0; assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.layout = QB_LAYOUT_PRIVATE; assert(qb_bootstrap(f.state, &bad) < 0);
    bad = f.policy; bad.reserved = 1; assert(qb_bootstrap(f.state, &bad) < 0);
    assert(qb_bootstrap(f.state, &f.policy) == 0);
    /* The shared layout's root is traverse-only for the access group, never 0700/0711. */
    struct qb *b = NULL;
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &b) < 0 && errno == EPERM && !b);
    assert(fchmod(f.root, 0711) == 0);
    assert(qb_open(f.root, f.state, &f.policy, &f.adapter, &b) < 0 && errno == EPERM && !b);
    assert(fchmod(f.root, 0710) == 0); start(&f);
    uint64_t me = geteuid(), gid = getegid();
    /* User project directory: broker-owned, access group read-only, never workload-writable. */
    struct qb_receipt r;
    assert(ensure(&f, 0, &r) == 0 && r.project == 100000);
    assert(!memcmp(r.mount_uuid, f.policy.mount_uuid, 16));
    expect_dir(f.root, "p100000", me, gid, 0750);
    struct stat s; assert(fstatat(r.directory_fd, "files", &s, 0) < 0 && errno == ENOENT);
    uint64_t user_inode = r.inode; close(r.directory_fd);
    /* Workspaces are subdirectories of the user's pool, inheriting its project. */
    struct qb_workspace_receipt w, w2;
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) == 0);
    assert(w.project == 100000 && w.user_inode == user_inode && w.bytes_hard == 1048576);
    assert(!memcmp(w.mount_uuid, f.policy.mount_uuid, 16));
    assert(fstat(w.directory_fd, &s) == 0 && (uint64_t)s.st_ino == w.inode && (uint64_t)s.st_dev == w.device);
    expect_dir(r.directory_fd = openat(f.root, "p100000", O_RDONLY | O_DIRECTORY), ws_a, me, gid, 02750);
    expect_dir(w.directory_fd, "files", me, gid, 02750);
    expect_dir(w.directory_fd, "snapshots", me, gid, 02750);
    close(r.directory_fd);
    uint64_t inode_a = w.inode; close(w.directory_fd);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) == 0 && w.inode == inode_a); close(w.directory_fd);
    assert(workspace_as(&f, 0, ws_b, geteuid(), &w2) == 0 && w2.project == 100000 && w2.inode != inode_a);
    close(w2.directory_fd);
    assert(f.model.configure_calls == 1); /* one quota per user, not per workspace */
    /* Workload content inside a workspace may change freely. */
    char path[96]; snprintf(path, sizeof(path), "p100000/%s/conversations.json", ws_a);
    int fd = openat(f.root, path, O_WRONLY | O_CREAT | O_EXCL, 0640); assert(fd >= 0); close(fd);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) == 0); close(w.directory_fd);
    qb_close(f.broker); f.broker = NULL; start(&f);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) == 0 && w.inode == inode_a); close(w.directory_fd);
    /* Strict frames, grants and peers. */
    char frame[96];
    snprintf(frame, sizeof(frame), "WORKSPACE/1 %s %s\n", f.policy.grants[0].workspace, ws_a);
    assert(qb_workspace(f.broker, geteuid(), frame, 85, &w) < 0 && errno == EPROTO && w.directory_fd == -1);
    frame[50] = 'A'; assert(qb_workspace(f.broker, geteuid(), frame, 86, &w) < 0 && errno == EPROTO);
    snprintf(frame, sizeof(frame), "WORKSPACE/1 %s ../../../../../../../../etc/passwd\n", f.policy.grants[0].workspace);
    assert(qb_workspace(f.broker, geteuid(), frame, strlen(frame), &w) < 0 && errno == EPROTO);
    assert(workspace_as(&f, 0, ws_a, (uid_t)(geteuid() + 1), &w) < 0 && errno == EACCES);
    snprintf(frame, sizeof(frame), "WORKSPACE/1 12345678-1234-4234-8234-999999999999 %s\n", ws_a);
    assert(qb_workspace(f.broker, geteuid(), frame, 86, &w) < 0 && errno == EACCES);
    /* Changed or interrupted hand-overs are denied, never adopted or repaired. */
    snprintf(path, sizeof(path), "p100000/%s", ws_a);
    mode_t modes[] = {02770, 0700, 02755};
    for (unsigned int i = 0; i < 3; i++) {
        assert(fchmodat(f.root, path, modes[i], 0) == 0);
        assert(workspace_as(&f, 0, ws_a, geteuid(), &w) < 0 && errno == EPERM && w.directory_fd == -1);
    }
    assert(fchmodat(f.root, path, 02750, 0) == 0);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) == 0); close(w.directory_fd);
    const char *ws_c = "cccccccc-0000-4000-8000-000000000003";
    snprintf(path, sizeof(path), "p100000/%s", ws_c);
    assert(mkdirat(f.root, path, 0700) == 0); /* left half-created */
    assert(workspace_as(&f, 0, ws_c, geteuid(), &w) < 0 && errno == EPERM);
    assert(fchmodat(f.root, "p100000", 0755, 0) == 0);
    assert(ensure(&f, 0, &r) < 0 && errno == EPERM);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) < 0 && errno == EPERM);
    assert(fchmodat(f.root, "p100000", 0750, 0) == 0);
    assert(fchmod(f.root, 0750) == 0 && ensure(&f, 0, &r) < 0 && errno == EPERM);
    assert(fchmod(f.root, 0710) == 0);
    /* Usage: read-only, never allocates, reports the pool's usage against its hard limits. */
    struct qb_usage u;
    assert(usage_of(&f, 1, &u) < 0 && errno == ENOENT && f.model.configure_calls == 1);
    f.model.slots[0].value.bytes_used = 838861; f.model.slots[0].value.inodes_used = 81;
    assert(usage_of(&f, 0, &u) == 0 && u.project == 100000 && u.bytes_used == 838861 &&
           u.bytes_hard == 1048576 && u.inodes_used == 81 && u.inodes_hard == 100);
    snprintf(frame, sizeof(frame), "USAGE/1 %s\n", f.policy.grants[0].workspace);
    assert(qb_usage(f.broker, (uid_t)(geteuid() + 1), frame, 45, &u) < 0 && errno == EACCES);
    assert(qb_usage(f.broker, geteuid(), frame, 44, &u) < 0 && errno == EPROTO);
    f.model.corrupt = 2; assert(usage_of(&f, 0, &u) < 0 && errno == EDQUOT); f.model.corrupt = 0;
    assert(ensure(&f, 1, &r) == 0 && r.project == 100001); close(r.directory_fd);
    assert(usage_of(&f, 1, &u) == 0 && u.project == 100001 && u.bytes_used == 0);
    /* Revoking the user denies every workspace and usage request. */
    assert(qb_revoke(f.broker, f.policy.grants[0].workspace) == 0);
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) < 0 && errno == EACCES);
    assert(usage_of(&f, 0, &u) < 0 && errno == EACCES);
    assert(f.model.configure_calls == 2);
    /* A manifest bound to the shared layout cannot be reopened with other access values. */
    qb_close(f.broker); f.broker = NULL;
    bad = f.policy; bad.access_gid++;
    assert(qb_open(f.root, f.state, &bad, &f.adapter, &b) < 0 && !b);
    cleanup(&f);
}
static void private_layout_receipt(void) {
    struct fixture f; fixture_init(&f); bootstrap(&f);
    struct qb_receipt r; assert(ensure(&f, 0, &r) == 0);
    assert(!memcmp(r.mount_uuid, f.policy.mount_uuid, 16));
    struct stat s; assert(fstat(r.directory_fd, &s) == 0 && (s.st_mode & 07777) == 0700);
    assert(fstatat(r.directory_fd, "files", &s, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT);
    close(r.directory_fd);
    struct qb_workspace_receipt w;
    assert(workspace_as(&f, 0, ws_a, geteuid(), &w) < 0 && errno == ENOTSUP && w.directory_fd == -1);
    cleanup(&f);
}
int main(void) {
    assert(geteuid() != 0); /* This harness refuses root, even accidentally. */
    umask(0077);
    void (*tests[])(void) = {protocol, policy_and_bootstrap, allocate_and_restart, foreign_tree,
        substitutions, mount_and_evidence, failure_and_capacity, interrupted, corrupt_state,
        uncertain_commit, truncated_live_state, substitution_during_adapter, exclusive_process_authority,
        concurrent_ten, revoke_fences_mutation, cached_revoke_truncated_journal,
        cached_revoke_idempotency_and_mount_health, shared_layout, private_layout_receipt};
    const char *names[] = {"strict bounded protocol", "explicit protected policy/bootstrap",
        "allocation/retry/restart", "never adopt foreign tree", "substitution/symlink/retained FD",
        "mount/evidence fail closed", "unknown outcome/capacity", "interrupted provision/restart",
        "torn journal rejected", "uncertain commit prevents mutation", "live state truncation denied",
        "mid-adapter substitution denied", "exclusive cross-process authority", "ten concurrent unique reservations",
        "durable revocation mutation fence", "cached revoke rejects lost durable state",
        "cached revoke idempotency/restart/mount health", "per-user pool: user dir, workspace subdirs, usage",
        "private layout unchanged, receipt carries mount UUID"};
    _Static_assert(sizeof(tests)/sizeof(tests[0]) == sizeof(names)/sizeof(names[0]), "test names mismatch");
    for (size_t i = 0; i < sizeof(tests)/sizeof(tests[0]); i++) { tests[i](); printf("ok %zu - %s\n", i+1, names[i]); }
    printf("%zu unprivileged core tests passed; ZERO real XFS quota tests executed\n", sizeof(tests)/sizeof(tests[0]));
    return 0;
}
