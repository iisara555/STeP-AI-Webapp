/* Real libsystemd, private Unix listener, public open/begin interfaces.
 * The only overrides are the compile-guarded address/peer/file trust seams.
 * No environment/default bus address is ever used by either mutation client. */
#define _GNU_SOURCE
#define LSC_TESTING 1
#define LSC_FIXTURE_INCLUDE 1
#if defined(TEST_STOP) || defined(TEST_RESET)
#include "stop.c"
#else
#include "create.c"
#endif
#include <assert.h>
#include <signal.h>
#include <sys/un.h>
#include <sys/wait.h>
#define EPOCH "11111111111111111111111111111111"
#define UUID "11111111-1111-1111-1111-111111111111"
#define UNIT "step-lc-" EPOCH "-0000000000000001.service"
static int exclusive(void *ctx,const struct lc_entry *entry) { (void)ctx; (void)entry; return 1; }
static int scratch_file(const char *root,const char *name) {
    char path[512]; assert(snprintf(path,sizeof path,"%s/%s",root,name)>0);
    int fd=open(path,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600); assert(fd>=0);
    return fd;
}
int main(void) {
    const char *tmp=getenv("TMPDIR"); assert(tmp && *tmp);
    char root[512], path[512], address[600];
    assert(snprintf(root,sizeof root,"%s/bus-deadline-XXXXXX",tmp)>0); assert(mkdtemp(root));
    struct sockaddr_un un={.sun_family=AF_UNIX};
    assert(snprintf(un.sun_path,sizeof un.sun_path,"%s/bus",root)>0);
    assert(strlen(root)+4<sizeof un.sun_path);
    int listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(listener>=0);
    assert(bind(listener,(struct sockaddr *)&un,sizeof un)==0 && listen(listener,1)==0);
    assert(snprintf(address,sizeof address,"unix:path=%s",un.sun_path)>0);
    lsc_test_bus_address=address; lsc_test_peer_uid=getuid(); lsc_test_journal_uid=getuid();
    struct lc_entry entry={.slot=1,.principal=1000,.state=LC_STARTING};
    strcpy(entry.epoch,EPOCH); strcpy(entry.launch,EPOCH); strcpy(entry.boot,UUID);
    strcpy(entry.user,UUID); strcpy(entry.workspace,UUID); strcpy(entry.container,"step-lc-" EPOCH "-0000000000000001");
    int journal_fd=scratch_file(root,"journal");
#if defined(TEST_STOP) || defined(TEST_RESET)
    lsc_test_create_uid=getuid();
    struct las_config c={.entry=entry,.exclusive=exclusive,.stop_fd=journal_fd,.job=7};
    strcpy(c.bus_id,EPOCH); strcpy(c.manager,":1.42"); strcpy(c.invocation,"01000000000000000000000000000000");
    c.create_fd=scratch_file(root,"create");
    char text[1024]; size_t length=0; assert(render_create(&c,UNIT,text,sizeof text,&length));
    assert(write(c.create_fd,text,length)==(ssize_t)length);
    struct las *s=NULL;
#ifdef TEST_RESET
    assert(las_reset_open(&c,exclusive,NULL,&s)==0);
#else
    assert(las_open(&c,&s)==0);
#endif
#else
    lsc_test_root=root; lsc_test_keeper_uid=getuid();
    assert(snprintf(path,sizeof path,"%s/usr",root)>0 && mkdir(path,0700)==0);
    assert(snprintf(path,sizeof path,"%s/usr/libexec",root)>0 && mkdir(path,0700)==0);
    assert(snprintf(path,sizeof path,"%s/usr/libexec/step-container-keeper",root)>0);
    int keeper=open(path,O_WRONLY|O_CREAT|O_EXCL,0700); assert(keeper>=0); close(keeper);
    struct lsc_config c={.entry=entry,.exclusive=exclusive,.journal_fd=journal_fd};
    strcpy(c.bus_id,EPOCH); strcpy(c.manager,":1.42");
    struct lsc *s=NULL; assert(lsc_open(&c,&s)==0);
#endif
    /* Listener stays open without answering authentication. A watchdog makes
     * the old 90-second block fail in eight seconds, not hang the suite. */
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        alarm(8); uint64_t start=now();
#if defined(TEST_STOP) || defined(TEST_RESET)
#ifdef TEST_RESET
        assert(las_reset(s)==-1 && las_status(s)==LAS_UNCERTAIN && las_reason(s)==LAS_R_DEADLINE);
        assert(las_reset(s)==-1);
#else
        assert(las_begin(s)==-1 && las_status(s)==LAS_UNCERTAIN && las_reason(s)==LAS_R_DEADLINE);
#endif
        assert(las_begin(s)==-1); las_close(s); close(c.create_fd);
#else
        assert(lsc_begin(s)==-1 && lsc_status(s)==LSC_UNCERTAIN);
        assert(lsc_begin(s)==-1); lsc_close(s);
#endif
        uint64_t elapsed=now()-start;
        assert(elapsed>=4900000 && elapsed<7000000);
        struct stat st; assert(fstat(journal_fd,&st)==0 && st.st_size==0);
        printf("deadline: stalled authentication refused in %.3f s; no intent/mutation\n",(double)elapsed/1000000.0);
        close(listener); close(journal_fd); exit(0);
    }
    int status; assert(waitpid(child,&status,0)==child);
    /* Inspect the private peer's actual wire bytes, not just the empty
     * journal: authentication may be sent, ResetFailed must never be. */
    int peer=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK); assert(peer>=0);
    char wire[4096]; size_t used=0;
    for (;;) {
        ssize_t n=recv(peer,wire+used,sizeof wire-used,0);
        if (n==0) break;
        assert(n>0 && used+(size_t)n<sizeof wire); used+=(size_t)n;
    }
    assert(used>0 && !memmem(wire,used,"ResetFailed",11)); close(peer);
#if defined(TEST_STOP) || defined(TEST_RESET)
    las_close(s); close(c.create_fd); (void)path;
#else
    lsc_close(s); assert(unlink(path)==0);
    assert(snprintf(path,sizeof path,"%s/usr/libexec",root)>0 && rmdir(path)==0);
    assert(snprintf(path,sizeof path,"%s/usr",root)>0 && rmdir(path)==0);
#endif
    close(listener); close(journal_fd);
#if defined(TEST_STOP) || defined(TEST_RESET)
    assert(snprintf(path,sizeof path,"%s/create",root)>0 && unlink(path)==0);
#endif
    assert(snprintf(path,sizeof path,"%s/journal",root)>0 && unlink(path)==0);
    assert(unlink(un.sun_path)==0 && rmdir(root)==0);
    assert(WIFEXITED(status) && WEXITSTATUS(status)==0);
    return 0;
}
