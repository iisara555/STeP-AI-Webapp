#define _GNU_SOURCE
#include "launch-request.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct qbl { struct qbl_config c; int fd; off_t offset; char state; int broken; pthread_mutex_t mutex; };
static int hex_id(const char *s) {
    if (strnlen(s, 33) != 32) return 0;
    for (size_t i=0; i<32; i++)
        if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
    return 1;
}
static int uuid(const char *s) {
    char frame[47], out[37];
    if (strnlen(s, 37) != 36) return 0;
    int n=snprintf(frame, sizeof frame, "ENSURE/1 %s\n", s);
    return n==46 && qb_request(frame, 46, out)==0;
}
static int safe_file(int fd) {
    struct stat st; int flags=fcntl(fd, F_GETFL);
    return flags>=0 && (flags&O_ACCMODE)==O_RDWR && !(flags&O_APPEND) &&
        fstat(fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==geteuid() &&
        (st.st_mode&07777)==0600 && st.st_nlink==1;
}
static int open_slot(const struct qbl_config *c, struct qbl **out, int fresh) {
    if (!c || !out || !c->broker) { errno=EINVAL; return -1; }
    *out=NULL;
    if (!c->spawn) { errno=ENOTSUP; return -1; }
    struct stat st;
    if (!hex_id(c->incarnation) || !hex_id(c->launch_id) || !uuid(c->user) || !uuid(c->workspace) ||
        fstat(c->state_fd,&st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=geteuid() ||
        (st.st_mode&07777)!=0700) { errno=EINVAL; return -1; }
    char header[320];
    int n=snprintf(header,sizeof header,"QBL/1 %s %s %s %s %llu %llu %llu %llu\n",
        c->incarnation,c->launch_id,c->user,c->workspace,(unsigned long long)c->peer_uid,
        (unsigned long long)c->identity.device,(unsigned long long)c->identity.user_inode,
        (unsigned long long)c->identity.inode);
    if (n<0 || (size_t)n>=sizeof header) { errno=EINVAL; return -1; }
    int flags=O_RDWR|O_CLOEXEC|O_NOFOLLOW;
    if (fresh) flags|=O_CREAT|O_EXCL;
    int fd=openat(c->state_fd,"launch.outcome",flags,0600);
    if (fd<0) return -1;
    if (!safe_file(fd) || flock(fd,LOCK_EX|LOCK_NB)<0) { close(fd); errno=EPERM; return -1; }
    char state='E';
    if (fresh) {
        if (pwrite(fd,header,(size_t)n,0)!=n || pwrite(fd,&state,1,n)!=1 || fsync(fd)<0 || fsync(c->state_fd)<0)
            goto fail;
    } else {
        char got[320];
        if (fstat(fd,&st)<0 || st.st_size!=n+1 || pread(fd,got,(size_t)n,0)!=n ||
            memcmp(header,got,(size_t)n) || pread(fd,&state,1,n)!=1 || !strchr("EPSDU",state) || state==0) {
            errno=EIO; goto fail;
        }
    }
    if (fsync(c->state_fd)<0) goto fail;
    struct qbl *a=calloc(1,sizeof *a); if (!a) goto fail;
    int error=pthread_mutex_init(&a->mutex,NULL);
    if (error) { free(a); errno=error; goto fail; }
    a->c=*c; a->fd=fd; a->offset=n; a->state=state; *out=a; return 0;
fail: { int saved=errno; close(fd); errno=saved; return -1; }
}
int qbl_open(const struct qbl_config *c, struct qbl **out) { return open_slot(c,out,0); }
int qbl_establish(const struct qbl_config *c) {
    struct qbl *a; if (open_slot(c,&a,1)<0) return -1;
    qbl_close(a); return 0;
}
static int persist(struct qbl *a, char state) {
    /* Mark broken BEFORE I/O: a failed write/sync must not permit a fresh try. */
    a->broken=1;
    if (pwrite(a->fd,&state,1,a->offset)!=1 || fsync(a->fd)<0) return -1;
    a->state=state; a->broken=0; return 0;
}
static int64_t now_ms(void);
struct spawning { struct qbl *a; int entered; int64_t deadline; };
static int spawn(void *ctx, const struct qb_workspace_receipt *r) {
    struct spawning *s=ctx;
    int64_t now=now_ms();
    if (now<0 || now>=s->deadline) { errno=ETIMEDOUT; return -1; }
    s->entered=1;
    return s->a->c.spawn(s->a->c.context,s->a->c.launch_id,r);
}
static int64_t now_ms(void) {
    struct timespec t; if (clock_gettime(CLOCK_MONOTONIC,&t)<0) return -1;
    return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000;
}
static int ready(int fd, short events, int64_t deadline) {
    for (;;) {
        int64_t now=now_ms(); if (now<0 || now>=deadline) { errno=ETIMEDOUT; return -1; }
        struct pollfd p={fd,events,0}; int rc=poll(&p,1,(int)(deadline-now));
        if (rc<0 && errno==EINTR) continue;
        if (rc<=0 || (p.revents&(POLLERR|POLLNVAL))) { errno=EIO; return -1; }
        return 0;
    }
}
int qbl_serve(struct qbl *a, int fd) {
    struct sockaddr_un addr; socklen_t len=sizeof addr, size=sizeof(int);
    int type=0, listening=0, flags=fcntl(fd,F_GETFL), fdflags=fcntl(fd,F_GETFD);
    struct ucred peer; socklen_t pl=sizeof peer;
    /* Kernel credentials first: absolutely no read, parsing or reply before this. */
    if (!a || getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&pl)<0 || pl!=sizeof peer || peer.uid!=a->c.peer_uid) {
        errno=EACCES; return -1;
    }
    if (flags<0 || !(flags&O_NONBLOCK) || fdflags<0 || !(fdflags&FD_CLOEXEC) ||
        getsockname(fd,(struct sockaddr *)&addr,&len)<0 || addr.sun_family!=AF_UNIX ||
        getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&size)<0 || type!=SOCK_STREAM ||
        getsockopt(fd,SOL_SOCKET,SO_ACCEPTCONN,&listening,&size)<0 || listening) { errno=EINVAL; return -1; }
    int64_t now=now_ms(); if (now<0) return -1;
    int64_t deadline=now+500;
    char frame[76]; size_t used=0;
    for (;;) {
        if (ready(fd,POLLIN,deadline)<0) return -1;
        struct iovec iov={frame+used,sizeof frame-used};
        struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1};
        /* No control buffer: kernel closes rights; any ancillary truncation denies. */
        ssize_t n=recvmsg(fd,&msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
        if (n<0) { if (errno==EINTR || errno==EAGAIN) continue; return -1; }
        if (msg.msg_flags&(MSG_CTRUNC|MSG_TRUNC)) { errno=EINVAL; return -1; }
        used+=(size_t)n;
        if (used>75) { errno=EMSGSIZE; return -1; }
        if (!n) break;
    }
    char expected[76];
    int n=snprintf(expected,sizeof expected,"LAUNCH/1 %s %s\n",a->c.incarnation,a->c.launch_id);
    int query=used==75 && memcmp(frame,"STATUS",6)==0;
    if (query) memcpy(expected,"STATUS",6);
    if (n!=75 || used!=75 || memcmp(frame,expected,75)) { errno=EINVAL; return -1; }
    /* Do not let a queued/contended request outlive its admission deadline. */
    int error=pthread_mutex_trylock(&a->mutex);
    if (error) { errno=error; return -1; }
    const char *outcome="UNKNOWN";
    now=now_ms();
    if (now<0 || now>=deadline) { pthread_mutex_unlock(&a->mutex); errno=ETIMEDOUT; return -1; }
    if (!query && !a->broken && a->state=='E' && persist(a,'P')==0) {
        struct spawning s={a,0,deadline};
        struct qb_spawn_adapter adapter={&s,spawn};
        int rc=qb_launch_workspace(a->c.broker,peer.uid,a->c.user,a->c.workspace,&a->c.identity,&adapter);
        char state=rc==0 ? 'S' : (s.entered ? 'U' : 'D');
        (void)persist(a,state);
    }
    if (!a->broken) {
        if (a->state=='E') outcome="EMPTY";
        if (a->state=='S') outcome="STARTED";
        if (a->state=='D') outcome="DENIED";
    }
    char reply[40]; n=snprintf(reply,sizeof reply,"LAUNCH/1 %s\n",outcome);
    pthread_mutex_unlock(&a->mutex);
    /* Recheck after synchronous work: an expired/lost response is reconciled by STATUS. */
    if (ready(fd,POLLOUT,deadline)<0) return -1;
    return send(fd,reply,(size_t)n,MSG_DONTWAIT|MSG_NOSIGNAL)==n ? 0 : -1;
}
void qbl_close(struct qbl *a) {
    if (!a) return;
    close(a->fd); pthread_mutex_destroy(&a->mutex); free(a);
}
