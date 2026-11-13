/* Real libsystemd against a private Unix-socket peer in this process (never the
 * real system bus). The production snapshot (lso_bus_snapshot) runs in a child;
 * the parent plays the bus and records every method call it receives:
 *  A. accepts, never authenticates: refused at the 5 s attempt deadline (the
 *     old code waited the 90 s auth timeout). Authentication never completes,
 *     so no method call can be on the wire; only elapsed time is asserted.
 *  B. completes SASL, never answers Hello: refused by the Hello budget (the
 *     2 s per-call cap set before sd_bus_start), not the 25 s default.
 *  C. answers Hello, never answers GetNameOwner, peer-uid seam = our uid:
 *     exactly Hello + one GetNameOwner on the wire, refused at its 2 s budget.
 *  D. as C, peer-uid seam left at the production 0: the peer check refuses
 *     before any method call - only Hello on the wire, refused at once.
 * Only the compile-guarded address and peer-uid seams are overridden. */
#define _GNU_SOURCE
#define LSO_TESTING 1
#define LSO_FIXTURE_INCLUDE 1
#include "systemd-observer.c"
#include <assert.h>
#include <signal.h>
#include <sys/un.h>
#include <sys/wait.h>
enum peer { SILENT, NO_HELLO, STALL_CALLS };
struct wire { char members[16][64]; unsigned count; int sasl_done; };
static size_t pad8(size_t n) { return (n+7)&~(size_t)7; }
static uint32_t u32(const unsigned char *p) { uint32_t v; memcpy(&v,p,4); return v; }
/* Parse one little-endian D-Bus message at buf[0..n); returns its length, 0 if
 * incomplete. Records the MEMBER header field and the serial. */
static size_t message(const unsigned char *buf,size_t n,char *member,size_t member_n,uint32_t *serial) {
    if (n<16) return 0;
    assert(buf[0]=='l' && buf[3]==1);
    uint32_t body=u32(buf+4), fields=u32(buf+12); *serial=u32(buf+8);
    size_t total=pad8(16+(size_t)fields)+body;
    if (n<total) return 0;
    member[0]=0;
    for (size_t i=16;i<16+fields;) {
        i=pad8(i); if (i>=16+fields) break;
        unsigned char code=buf[i], sl=buf[i+1]; char sig=(char)buf[i+2]; i+=3+(size_t)sl;
        if (sig=='s' || sig=='o') {
            i=(i+3)&~(size_t)3; uint32_t len=u32(buf+i);
            if (code==3) { assert(len<member_n); memcpy(member,buf+i+4,len); member[len]=0; }
            i+=4+(size_t)len+1;
        } else if (sig=='g') { i+=1+(size_t)buf[i]+1; }
        else if (sig=='u') { i=(i+3)&~(size_t)3; i+=4; }
        else assert(0);
    }
    return total;
}
static size_t field_string(unsigned char *f,size_t o,unsigned char code,char sig,const char *s) {
    o=pad8(o); f[o++]=code; f[o++]=1; f[o++]=(unsigned char)sig; f[o++]=0;
    uint32_t len=(uint32_t)strlen(s);
    if (sig=='g') { f[o++]=(unsigned char)len; memcpy(f+o,s,len+1); return o+len+1; }
    o=(o+3)&~(size_t)3; memcpy(f+o,&len,4); memcpy(f+o+4,s,len+1); return o+4+len+1;
}
/* METHOD_RETURN for Hello: unique name ":1.7", from org.freedesktop.DBus. */
static void reply_hello(int fd,uint32_t reply_serial) {
    unsigned char m[256]={0}; unsigned char *f=m+16; size_t o=0;
    f[o++]=5; f[o++]=1; f[o++]='u'; f[o++]=0; memcpy(f+o,&reply_serial,4); o+=4;
    o=field_string(f,o,7,'s',"org.freedesktop.DBus");
    o=field_string(f,o,8,'g',"s");
    size_t body_at=pad8(16+o);
    uint32_t len=4, body=4+len+1, serial=1, fields=(uint32_t)o;
    memcpy(m+body_at,&len,4); memcpy(m+body_at+4,":1.7",5);
    m[0]='l'; m[1]=2; m[2]=1; m[3]=1; memcpy(m+4,&body,4); memcpy(m+8,&serial,4); memcpy(m+12,&fields,4);
    size_t total=body_at+body;
    assert(send(fd,m,total,MSG_NOSIGNAL)==(ssize_t)total);
}
static void say(int fd,const char *s) { assert(send(fd,s,strlen(s),MSG_NOSIGNAL)==(ssize_t)strlen(s)); }
/* Serve one client until it closes (bounded by 10 s of silence). */
static void serve(int listener,enum peer mode,struct wire *w) {
    struct pollfd p={.fd=listener,.events=POLLIN};
    assert(poll(&p,1,10000)==1);
    int fd=accept4(listener,NULL,NULL,SOCK_CLOEXEC); assert(fd>=0);
    static unsigned char buf[65536]; size_t used=0;
    memset(w,0,sizeof *w);
    for (;;) {
        p.fd=fd; p.events=POLLIN;
        assert(poll(&p,1,10000)==1);
        ssize_t n=recv(fd,buf+used,sizeof buf-used,0);
        if (n==0 || (n<0 && errno==ECONNRESET)) break;
        assert(n>0); used+=(size_t)n; assert(used<sizeof buf);
        if (mode==SILENT) { used=0; continue; }
        while (!w->sasl_done) {
            unsigned char *end=memmem(buf,used,"\r\n",2); if (!end) break;
            size_t line=(size_t)(end-buf); char text[256]={0};
            const unsigned char *s=buf; size_t sl=line;
            while (sl && !*s) { s++; sl--; }
            assert(sl<sizeof text); memcpy(text,s,sl);
            memmove(buf,end+2,used-line-2); used-=line+2;
            if (!strncmp(text,"AUTH",4)) say(fd,"DATA\r\n");
            else if (!strncmp(text,"DATA",4)) say(fd,"OK 0123456789abcdef0123456789abcdef\r\n");
            else if (!strncmp(text,"NEGOTIATE_UNIX_FD",17)) say(fd,"AGREE_UNIX_FD\r\n");
            else if (!strcmp(text,"BEGIN")) w->sasl_done=1;
            else assert(0);
        }
        for (;;) {
            if (!w->sasl_done) break;
            uint32_t serial; char *member=w->members[w->count];
            size_t len=message(buf,used,member,sizeof w->members[0],&serial);
            if (!len) break;
            memmove(buf,buf+len,used-len); used-=len;
            assert(++w->count<16);
            if (!strcmp(member,"Hello") && mode==STALL_CALLS) reply_hello(fd,serial);
        }
    }
    close(fd);
}
static void expect_members(const struct wire *w,unsigned count,const char *first,const char *second) {
    if (w->count!=count || (count>0 && strcmp(w->members[0],first)) || (count>1 && strcmp(w->members[1],second))) {
        fprintf(stderr,"FAIL: wire carried %u method call(s):",w->count);
        for (unsigned i=0;i<w->count;i++) fprintf(stderr," %s",w->members[i]);
        fprintf(stderr,"\n"); exit(1);
    }
}
/* Run the production snapshot in a child; return elapsed microseconds. */
static uint64_t scenario(int listener,const char *address,enum peer mode,int seam_uid,struct wire *w,const char *what) {
    uint64_t start=lso_now();
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        alarm(9); /* the old code waited 90 s; fail instead of hanging */
        lso_test_bus_address=address;
        if (seam_uid) lso_test_peer_uid=getuid();
        struct lso_snapshot s;
        _exit(lso_bus_snapshot(NULL,"fixed.service",":1.42",&s)==-1 ? 0:2);
    }
    if (mode==SILENT) {
        /* never accept before the child is done; read what it sent after */
        int status; assert(waitpid(child,&status,0)==child);
        if (!WIFEXITED(status) || WEXITSTATUS(status)) { fprintf(stderr,"FAIL: %s: snapshot not refused (status %d)\n",what,status); exit(1); }
        uint64_t elapsed=lso_now()-start;
        serve(listener,mode,w);
        return elapsed;
    }
    serve(listener,mode,w);
    int status; assert(waitpid(child,&status,0)==child);
    if (!WIFEXITED(status) || WEXITSTATUS(status)) { fprintf(stderr,"FAIL: %s: snapshot not refused (status %d)\n",what,status); exit(1); }
    return lso_now()-start;
}
static void within(uint64_t elapsed,uint64_t lo,uint64_t hi,const char *what) {
    if (elapsed<lo || elapsed>=hi) {
        fprintf(stderr,"FAIL: %s took %.3f s, want [%.1f, %.1f)\n",what,(double)elapsed/1e6,(double)lo/1e6,(double)hi/1e6); exit(1);
    }
    printf("observer deadline: %s refused in %.3f s\n",what,(double)elapsed/1e6);
}
int main(void) {
    const char *tmp=getenv("TMPDIR");
    if (!tmp || !*tmp) { fprintf(stderr,"test-observer-deadline: TMPDIR must name a private scratch directory\n"); return 1; }
    char root[512], address[600];
    if (snprintf(root,sizeof root,"%s/observer-deadline-XXXXXX",tmp)>=(int)sizeof root || !mkdtemp(root)) {
        fprintf(stderr,"test-observer-deadline: cannot create a directory under TMPDIR=%s\n",tmp); return 1;
    }
    struct sockaddr_un un={.sun_family=AF_UNIX};
    if (strlen(root)+5>sizeof un.sun_path) { fprintf(stderr,"test-observer-deadline: TMPDIR path too long for a Unix socket\n"); rmdir(root); return 1; }
    assert(snprintf(un.sun_path,sizeof un.sun_path,"%s/bus",root)>0);
    int listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(listener>=0);
    assert(bind(listener,(struct sockaddr *)&un,sizeof un)==0 && listen(listener,1)==0);
    assert(snprintf(address,sizeof address,"unix:path=%s",un.sun_path)>0);
    struct wire w;
    within(scenario(listener,address,SILENT,1,&w,"stalled authentication"),4900000,7000000,"stalled authentication");
    uint64_t t=scenario(listener,address,NO_HELLO,1,&w,"unanswered Hello");
    expect_members(&w,1,"Hello",NULL);
    within(t,1900000,3000000,"unanswered Hello");
    t=scenario(listener,address,STALL_CALLS,1,&w,"unanswered GetNameOwner");
    expect_members(&w,2,"Hello","GetNameOwner");
    within(t,1900000,3000000,"unanswered GetNameOwner");
    t=scenario(listener,address,STALL_CALLS,0,&w,"non-root bus peer");
    expect_members(&w,1,"Hello",NULL);
    within(t,0,1000000,"non-root bus peer (no method call)");
    close(listener);
    assert(unlink(un.sun_path)==0 && rmdir(root)==0);
    return 0;
}
