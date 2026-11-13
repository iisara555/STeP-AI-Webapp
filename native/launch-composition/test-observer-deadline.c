/* Real libsystemd, private Unix listener that accepts but never authenticates.
 * The production snapshot (lso_bus_snapshot) must give up within its 5 s
 * attempt deadline and send no method call. Only the compile-guarded address
 * and peer-uid seams are overridden; the real system bus is never contacted. */
#define _GNU_SOURCE
#define LSO_TESTING 1
#define LSO_FIXTURE_INCLUDE 1
#include "systemd-observer.c"
#include <assert.h>
#include <signal.h>
#include <sys/un.h>
#include <sys/wait.h>
int main(void) {
    const char *tmp=getenv("TMPDIR"); assert(tmp && *tmp);
    char root[512], address[600];
    assert(snprintf(root,sizeof root,"%s/observer-deadline-XXXXXX",tmp)>0); assert(mkdtemp(root));
    struct sockaddr_un un={.sun_family=AF_UNIX};
    assert(strlen(root)+4<sizeof un.sun_path);
    assert(snprintf(un.sun_path,sizeof un.sun_path,"%s/bus",root)>0);
    int listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(listener>=0);
    assert(bind(listener,(struct sockaddr *)&un,sizeof un)==0 && listen(listener,1)==0);
    assert(snprintf(address,sizeof address,"unix:path=%s",un.sun_path)>0);
    lso_test_bus_address=address; lso_test_peer_uid=getuid();
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        /* The old code blocked on GetNameOwner for the 90 s auth timeout; the
         * watchdog turns that into a failure in 8 s instead of a hang. */
        alarm(8); uint64_t start=lso_now();
        struct lso_snapshot s;
        assert(lso_bus_snapshot(NULL,"fixed.service",":1.42",&s)==-1);
        uint64_t elapsed=lso_now()-start;
        assert(elapsed>=4900000 && elapsed<7000000);
        printf("observer deadline: stalled authentication refused in %.3f s; no method call\n",(double)elapsed/1000000.0);
        exit(0);
    }
    int status; assert(waitpid(child,&status,0)==child);
    assert(WIFEXITED(status) && WEXITSTATUS(status)==0);
    /* Inspect the peer's actual wire bytes: authentication may have been
     * sent, but no method call (GetNameOwner/GetUnit/Get) ever was. */
    int peer=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK); assert(peer>=0);
    char wire[4096]; size_t used=0;
    for (;;) {
        ssize_t n=recv(peer,wire+used,sizeof wire-used,0);
        if (n==0 || (n<0 && errno==EAGAIN)) break;
        assert(n>0 && used+(size_t)n<sizeof wire); used+=(size_t)n;
    }
    assert(used>0);
    assert(!memmem(wire,used,"GetNameOwner",12) && !memmem(wire,used,"GetUnit",7) &&
           !memmem(wire,used,"org.freedesktop.DBus.Properties",31));
    close(peer); close(listener);
    assert(unlink(un.sun_path)==0 && rmdir(root)==0);
    return 0;
}
