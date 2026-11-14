/* Reviewer deletion race, exercised for add AND raise, without real quotas. */
#define main original_test_main
#include "test-core.c"
#undef main
static int interleave, skip_observations;
static struct model *active_model;
static int skip_space_reads;
static void workload_change(void) {
    if (skip_space_reads) { skip_space_reads--; return; }
    assert(interleave);
    if (interleave == 1) { active_model->slots[0].value.bytes_used = 0; fake_available += MIB_; }
    else { active_model->slots[0].value.bytes_used = MIB_; fake_available -= MIB_; }
    interleave = 0; after_space_read = NULL;
}
static int race_observe(void *ctx, int root, int dir, uint32_t project, struct qb_observation *out) {
    int rc = mock_observe(ctx, root, dir, project, out);
    if (!rc && interleave && project == 100000) {
        if (skip_observations) { skip_observations--; return rc; }
        struct model *m = ctx;
        if (interleave == 1) { m->slots[0].value.bytes_used = 0; fake_available += MIB_; }
        else { m->slots[0].value.bytes_used = MIB_; fake_available -= MIB_; }
        interleave = 0;
    }
    return rc;
}
int main(void) {
    assert(geteuid() != 0); umask(0077);
    for (int raising = getenv("RAISE_ONLY") ? 1 : 0; raising < 2; raising++) {
        for (int event = 1; event <= 2; event++) {
            struct fixture f; fixture_init(&f);
            f.policy.grant_count = 1; f.policy.reserve_bytes = MIB_;
            f.adapter.observe = race_observe; bootstrap(&f);
            struct qb_receipt r; assert(ensure(&f, 0, &r) == 0); close(r.directory_fd);
            f.model.slots[0].value.bytes_used = event == 1 ? MIB_ : 0;
            fake_available = event == 1 ? MIB_ : 2 * MIB_;
            off_t size = journal_size(&f); int calls = f.model.raise_calls;
            interleave = event; skip_observations = raising;
            struct qb_capacity c; uint32_t project = 0;
            int rc = raising ? qb_raise(f.broker, f.policy.grants[0].workspace, 2*MIB_, 200, &c)
                             : qb_grant_add(f.broker, user_x, &project, &c);
            printf("%s %s rc=%d errno=%d committed=%llu available=%llu\n",
                   raising ? "raise" : "add", event == 1 ? "delete" : "write", rc, errno,
                   (unsigned long long)c.committed, (unsigned long long)c.available); fflush(stdout);
            assert(rc < 0 && errno == EFBIG);
            assert(journal_size(&f) == size && f.model.raise_calls == calls && project == 0);
            restart(&f);
            assert(journal_size(&f) == size);
            fake_available = 0; interleave = 0; cleanup(&f);
        }
    }
    /* Workloads can also mutate AFTER statvfs, before the durable record. The
     * ledger ceiling does not change: tight budgets refuse, roomy ones admit the
     * same full commitment regardless of deletion/write scheduling. */
    for (int raising = 0; raising < 2; raising++) {
        for (int event = 1; event <= 2; event++) {
            for (int roomy = 0; roomy < 2; roomy++) {
                struct fixture f; fixture_init(&f); f.policy.grant_count = 1;
                f.policy.reserve_bytes = MIB_; bootstrap(&f);
                struct qb_receipt r; assert(ensure(&f, 0, &r) == 0); close(r.directory_fd);
                active_model = &f.model;
                active_model->slots[0].value.bytes_used = event == 1 ? MIB_ : 0;
                fake_available = (roomy ? 4 : 2)*MIB_;
                interleave = event; skip_space_reads = 1; after_space_read = workload_change;
                off_t size = journal_size(&f); struct qb_capacity c; uint32_t project;
                int rc = raising ? qb_raise(f.broker, f.policy.grants[0].workspace, 2*MIB_, 200, &c)
                                 : qb_grant_add(f.broker, user_x, &project, &c);
                printf("post-statvfs %s event=%d roomy=%d rc=%d errno=%d committed=%llu available=%llu\n",
                       raising ? "raise" : "add", event, roomy, rc, errno,
                       (unsigned long long)c.committed, (unsigned long long)c.available); fflush(stdout);
                assert(interleave == 0 && c.committed == 2*MIB_);
                assert(roomy ? rc == 0 : rc < 0 && errno == EFBIG);
                assert(roomy ? journal_size(&f) > size : journal_size(&f) == size);
                restart(&f);
                /* A committed raise/grant remains charged after restart, including
                 * an unallocated new user; usage cannot discount a subsequent add. */
                fake_available = 3*MIB_;
                int next = qb_grant_add(f.broker, user_y, &project, &c);
                assert(roomy ? next < 0 && errno == EFBIG : next == 0);
                assert(c.committed == (roomy ? 3 : 2)*MIB_);
                fake_available = 0; cleanup(&f);
            }
        }
    }
    puts("capacity deletion/write interleavings refused for add and raise; post-statvfs schedules preserve full restart budget");
    return 0;
}
