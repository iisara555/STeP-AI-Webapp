/* Synthetic synchronous spawn seam; never starts a process or invokes quotas. */
#define main original_test_main
#include "test-core.c"
#undef main

struct launch_model {
    int calls, borrowed_fd, fail;
    int block, entered, release;
    pthread_mutex_t gate;
    pthread_cond_t changed;
    uint64_t inode;
};
static int fake_spawn(void *context, const struct qb_workspace_receipt *r) {
    struct launch_model *m = context;
    struct stat s;
    assert(fstat(r->directory_fd, &s) == 0 && (uint64_t)s.st_ino == m->inode);
    assert(r->inode == m->inode && r->project == 100000);
    m->borrowed_fd = r->directory_fd; m->calls++;
    if (m->block) {
        assert(pthread_mutex_lock(&m->gate) == 0);
        m->entered = 1; assert(pthread_cond_broadcast(&m->changed) == 0);
        while (!m->release) assert(pthread_cond_wait(&m->changed, &m->gate) == 0);
        assert(fstat(r->directory_fd, &s) == 0); /* valid throughout callback */
        assert(pthread_mutex_unlock(&m->gate) == 0);
    }
    if (m->fail) { errno = ECHILD; return -1; }
    return 0;
}
static void launch_fixture(struct fixture *f, struct qb_launch_identity *id) {
    fixture_init(f);
    f->policy.layout = QB_LAYOUT_SHARED;
    f->policy.access_gid = (uint32_t)getegid();
    f->policy.content_uid = (uint32_t)geteuid();
    assert(fchmod(f->root, 0710) == 0); bootstrap(f);
    struct qb_workspace_receipt r;
    assert(workspace_as(f, 0, ws_a, geteuid(), &r) == 0);
    *id = (struct qb_launch_identity){.device = r.device, .user_inode = r.user_inode, .inode = r.inode};
    close(r.directory_fd);
}
static int launch(struct fixture *f, const struct qb_launch_identity *id, const struct qb_spawn_adapter *a) {
    return qb_launch_workspace(f->broker, geteuid(), f->policy.grants[0].workspace, ws_a, id, a);
}
/* Link-time observation of the revoke's FIRST lock: prove EBUSY, not a
 * scheduler-dependent sleep. Then let the real lock block until spawn returns. */
static _Thread_local int probe_revoke;
static _Thread_local int check_closed_fd = -1;
static pthread_barrier_t lock_observed;
int __real_pthread_mutex_lock(pthread_mutex_t *mutex);
int __wrap_pthread_mutex_lock(pthread_mutex_t *mutex);
static void barrier(pthread_barrier_t *b) {
    int rc = pthread_barrier_wait(b); assert(rc == 0 || rc == PTHREAD_BARRIER_SERIAL_THREAD);
}
int __wrap_pthread_mutex_lock(pthread_mutex_t *mutex) {
    if (probe_revoke) {
        probe_revoke = 0;
        assert(pthread_mutex_trylock(mutex) == EBUSY);
        barrier(&lock_observed);
    }
    int rc = __real_pthread_mutex_lock(mutex);
    if (check_closed_fd >= 0) {
        assert(rc == 0 && fcntl(check_closed_fd, F_GETFD) < 0 && errno == EBADF);
        check_closed_fd = -1;
    }
    return rc;
}
struct launch_thread {
    struct fixture *f;
    struct qb_launch_identity id;
    struct qb_spawn_adapter adapter;
    int rc, error;
    atomic_int revoked;
};
static void *run_launch(void *arg) {
    struct launch_thread *t = arg;
    t->rc = launch(t->f, &t->id, &t->adapter); t->error = errno; return NULL;
}
static void *run_revoke(void *arg) {
    struct launch_thread *t = arg;
    probe_revoke = 1;
    struct launch_model *m = t->adapter.context;
    check_closed_fd = m->borrowed_fd;
    assert(qb_revoke(t->f->broker, t->f->policy.grants[0].workspace) == 0);
    atomic_store(&t->revoked, 1); return NULL;
}
static void ordering(int fail) {
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    struct launch_model m = {.inode = id.inode, .block = 1, .fail = fail};
    assert(pthread_mutex_init(&m.gate, NULL) == 0);
    assert(pthread_cond_init(&m.changed, NULL) == 0);
    assert(pthread_barrier_init(&lock_observed, NULL, 2) == 0);
    struct launch_thread t = {.f = &f, .id = id, .adapter = {.context = &m, .spawn = fake_spawn}};
    atomic_init(&t.revoked, 0);
    pthread_t starter, revoker;
    assert(pthread_create(&starter, NULL, run_launch, &t) == 0);
    assert(pthread_mutex_lock(&m.gate) == 0);
    while (!m.entered) assert(pthread_cond_wait(&m.changed, &m.gate) == 0);
    assert(pthread_mutex_unlock(&m.gate) == 0);
    assert(pthread_create(&revoker, NULL, run_revoke, &t) == 0);
    barrier(&lock_observed);
    assert(atomic_load(&t.revoked) == 0);
    assert(pthread_mutex_lock(&m.gate) == 0);
    m.release = 1; assert(pthread_cond_broadcast(&m.changed) == 0);
    assert(pthread_mutex_unlock(&m.gate) == 0);
    assert(pthread_join(starter, NULL) == 0 && pthread_join(revoker, NULL) == 0);
    assert(fail ? t.rc == -1 && t.error == ECHILD : t.rc == 0);
    assert(atomic_load(&t.revoked) == 1 && m.calls == 1);
    assert(fcntl(m.borrowed_fd, F_GETFD) < 0 && errno == EBADF);
    assert(launch(&f, &id, &t.adapter) < 0 && errno == EACCES && m.calls == 1);
    /* All users joined BEFORE core mutex destruction. Durable replay still denies. */
    restart(&f);
    assert(launch(&f, &id, &t.adapter) < 0 && errno == EACCES && m.calls == 1);
    cleanup(&f);
    assert(pthread_barrier_destroy(&lock_observed) == 0);
    assert(pthread_cond_destroy(&m.changed) == 0);
    assert(pthread_mutex_destroy(&m.gate) == 0);
}
static void revalidation(void) {
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    struct launch_model m = {.inode = id.inode};
    struct qb_spawn_adapter a = {.context = &m, .spawn = fake_spawn};
    struct qb_launch_identity bad = id; bad.inode++;
    assert(launch(&f, &bad, &a) < 0 && errno == ESTALE);
    bad = id; bad.device++;
    assert(launch(&f, &bad, &a) < 0 && errno == ESTALE);
    bad = id; bad.user_inode++;
    assert(launch(&f, &bad, &a) < 0 && errno == ESTALE);
    assert(qb_launch_workspace(f.broker, (uid_t)(geteuid()+1), f.policy.grants[0].workspace,
                               ws_a, &id, &a) < 0 && errno == EACCES);
    assert(qb_launch_workspace(f.broker, geteuid(), user_x, ws_a, &id, &a) < 0 && errno == EACCES);
    assert(qb_launch_workspace(f.broker, geteuid(), f.policy.grants[0].workspace,
                               "../not-a-workspace", &id, &a) < 0 && errno == EINVAL);
    assert(launch(&f, &id, NULL) < 0 && errno == ENOTSUP);
    struct qb_spawn_adapter absent = {0};
    assert(launch(&f, &id, &absent) < 0 && errno == ENOTSUP);
    assert(launch(&f, NULL, &a) < 0 && errno == EINVAL);
    off_t size = journal_size(&f);
    assert(qb_launch_workspace(f.broker, geteuid(), f.policy.grants[1].workspace,
                               ws_a, &id, &a) < 0 && errno == ENOENT);
    assert(qb_launch_workspace(f.broker, geteuid(), f.policy.grants[0].workspace,
                               ws_b, &id, &a) < 0 && errno == ENOENT);
    assert(journal_size(&f) == size && f.model.configure_calls == 1 && m.calls == 0);
    f.model.enforced = 0; assert(launch(&f, &id, &a) < 0 && errno == EXDEV); f.model.enforced = 1;
    f.model.corrupt = 1; assert(launch(&f, &id, &a) < 0 && errno == EDQUOT); f.model.corrupt = 0;
    char path[96]; snprintf(path, sizeof(path), "p100000/%s", ws_a);
    assert(fchmodat(f.root, path, 02770, 0) == 0);
    assert(launch(&f, &id, &a) < 0 && errno == EPERM);
    assert(fchmodat(f.root, path, 02750, 0) == 0);
    /* Same path, correct mode/project, DIFFERENT inode cannot consume old receipt identity. */
    assert(renameat(f.root, path, f.root, "old-workspace") == 0);
    struct qb_workspace_receipt replacement;
    assert(workspace_as(&f, 0, ws_a, geteuid(), &replacement) == 0);
    close(replacement.directory_fd);
    assert(launch(&f, &id, &a) < 0 && errno == ESTALE && m.calls == 0);
    cleanup(&f);
}
static int replace_pool;
static int launch_observe(void *ctx, int root, int dir, uint32_t project, struct qb_observation *out) {
    int rc = mock_observe(ctx, root, dir, project, out);
    struct model *m = ctx; struct stat s; assert(fstat(dir, &s) == 0);
    if (!rc && replace_pool && (uint64_t)s.st_ino != m->slots[0].inode) {
        replace_pool = 0;
        assert(renameat(root, "p100000", root, "old-pool") == 0);
        assert(mkdirat(root, "p100000", 0750) == 0);
    }
    return rc;
}
static void pool_substitution(void) {
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    /* Reopen with an adapter replacing the protected parent at the final observation. */
    qb_close(f.broker); f.broker = NULL;
    f.adapter.observe = launch_observe; start(&f);
    struct launch_model m = {.inode = id.inode};
    struct qb_spawn_adapter a = {.context = &m, .spawn = fake_spawn};
    replace_pool = 1;
    assert(launch(&f, &id, &a) < 0 && errno == ESTALE && m.calls == 0 && !replace_pool);
    cleanup(&f);
}
static void callback_errors(void) {
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    struct launch_model m = {.inode = id.inode, .fail = 1};
    struct qb_spawn_adapter a = {.context = &m, .spawn = fake_spawn};
    for (int i = 0; i < 100; i++) {
        assert(launch(&f, &id, &a) == -1 && errno == ECHILD && m.calls == i+1);
        assert(fcntl(m.borrowed_fd, F_GETFD) < 0 && errno == EBADF);
    }
    m.fail = 0;
    assert(launch(&f, &id, &a) == 0 && m.calls == 101); /* explicit fresh attempt only */
    assert(qb_revoke(f.broker, f.policy.grants[0].workspace) == 0);
    assert(launch(&f, &id, &a) < 0 && errno == EACCES && m.calls == 101);
    cleanup(&f);
}
int main(void) {
    assert(geteuid() != 0); umask(0077);
    alarm(30); /* deadlocks fail boundedly, not a sleep-based ordering assertion */
    ordering(0); ordering(1); revalidation(); pool_substitution(); callback_errors();
    struct fixture f; struct qb_launch_identity id; launch_fixture(&f, &id);
    struct launch_model m = {.borrowed_fd = -1, .inode = id.inode};
    struct qb_spawn_adapter a = {.context = &m, .spawn = fake_spawn};
    assert(launch(&f, &id, &a) == 0 && m.calls == 1);
    assert(fcntl(m.borrowed_fd, F_GETFD) < 0 && errno == EBADF);
    struct qb_workspace_receipt stale;
    assert(workspace_as(&f, 0, ws_a, geteuid(), &stale) == 0);
    assert(qb_revoke(f.broker, f.policy.grants[0].workspace) == 0);
    struct stat s; assert(fstat(stale.directory_fd, &s) == 0); /* still a usable FD, NOT authority */
    for (int i = 0; i < 10; i++)
        assert(launch(&f, &id, &a) < 0 && errno == EACCES && m.calls == 1);
    close(stale.directory_fd);
    cleanup(&f);
    puts("launch: ordering success/error, fresh identity/grant/quota checks, pool substitution,");
    puts("        callback errors/FD release, live receipt + revoked request replay denial passed");
    return 0;
}
