#define _GNU_SOURCE
#include "lifecycle.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#define RECORD 256
#define MAX_SLOTS 65536
#define MAX_RECORDS 1048576
struct lc {
    int fd, poisoned; pid_t owner; pthread_mutex_t mutex;
    struct lc_config c; struct lc_entry *entries;
    uint64_t count, records;
};
static int fail(int e) { errno=e; return -1; }
static int hex(const char *s,size_t n) {
    if (!s || strnlen(s,n+1)!=n) return 0;
    for (size_t i=0;i<n;i++) if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
    return 1;
}
static int uuid(const char *s) {
    if (!s || strnlen(s,37)!=36) return 0;
    for (size_t i=0;i<36;i++) {
        if (i==8 || i==13 || i==18 || i==23) { if (s[i]!='-') return 0; }
        else if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
    }
    return 1;
}
static void put(unsigned char *b,uint64_t v) { for (unsigned i=0;i<8;i++) { b[i]=(unsigned char)v; v>>=8; } }
static uint64_t get(const unsigned char *b) { uint64_t v=0; for (unsigned i=0;i<8;i++) v|=(uint64_t)b[i]<<(8*i); return v; }
static uint64_t checksum(const unsigned char *b) {
    uint64_t h=UINT64_C(14695981039346656037);
    for (size_t i=0;i<248;i++) { h^=b[i]; h*=UINT64_C(1099511628211); } return h;
}
static void encode(const struct lc *a,const struct lc_entry *e,unsigned char b[RECORD]) {
    memset(b,0,RECORD); memcpy(b,"STEPLC01",8); put(b+8,a->records);
    if (e) {
        put(b+16,e->slot); put(b+24,e->principal); b[32]=(unsigned char)e->state;
        memcpy(b+40,e->epoch,32); memcpy(b+72,e->boot,36); memcpy(b+108,e->user,36);
        memcpy(b+144,e->workspace,36); memcpy(b+180,e->launch,32);
    } else { put(b+24,a->c.capacity); memcpy(b+40,a->c.epoch,32); }
    put(b+248,checksum(b));
}
static int append(struct lc *a,const struct lc_entry *e) {
    if (a->records>=MAX_RECORDS) return fail(ENOSPC);
    unsigned char b[RECORD]; encode(a,e,b);
    a->poisoned=1;
    if (pwrite(a->fd,b,RECORD,(off_t)(a->records*RECORD))!=RECORD || fsync(a->fd)<0) return fail(EIO);
    a->records++; a->poisoned=0; return 0;
}
static int legal(enum lc_state old,enum lc_state next) {
    return old!=LC_RELEASED && (next==LC_FENCED || next==LC_RELEASED ||
        (old==LC_RESERVED && next==LC_STARTING) || (old==LC_STARTING && next==LC_RUNNING) ||
        ((old==LC_STARTING || old==LC_RUNNING) && next==LC_STOPPING));
}
static void name(struct lc_entry *e) {
    (void)snprintf(e->container,sizeof e->container,"step-lc-%s-%016llx",e->epoch,(unsigned long long)e->slot);
}
static int locked(struct lc *a) {
    if (!a || a->owner!=getpid()) return fail(EPERM);
    int rc=pthread_mutex_trylock(&a->mutex); if (rc) return fail(rc);
    if (a->poisoned) { pthread_mutex_unlock(&a->mutex); return fail(EIO); } return 0;
}
static int unlock(struct lc *a,int rc) { pthread_mutex_unlock(&a->mutex); return rc; }
void lc_close(struct lc *a) {
    if (!a) return;
    close(a->fd); free(a->entries); pthread_mutex_destroy(&a->mutex); free(a);
}
static int setup(const struct lc_config *c,struct lc **out,int fresh) {
    if (!out) return fail(EINVAL);
    *out=NULL;
    if (!c || !c->capacity || c->capacity>MAX_SLOTS || !hex(c->epoch,32) || !uuid(c->boot)) return fail(EINVAL);
    struct stat st;
    if (fstat(c->directory_fd,&st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&07777)!=0700) return fail(EPERM);
    int fd=openat(c->directory_fd,"lifecycle.ledger",O_RDWR|O_CLOEXEC|O_NOFOLLOW|(fresh ? O_CREAT|O_EXCL:0),0600);
    if (fd<0) return -1;
    if (fstat(fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&07777)!=0600 || st.st_nlink!=1) { close(fd); return fail(EPERM); }
    if (flock(fd,LOCK_EX|LOCK_NB)<0) { int saved=errno; close(fd); return fail(saved); }
    /* The previous holder may append between the first fstat and our lock.
     * Only the locked snapshot is authoritative for validation and replay. */
    if (fstat(fd,&st)<0) { int saved=errno; close(fd); return fail(saved); }
    if (!S_ISREG(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&07777)!=0600 || st.st_nlink!=1) { close(fd); return fail(EPERM); }
    struct lc *a=calloc(1,sizeof *a);
    if (!a) { close(fd); return -1; }
    a->fd=fd; a->c=*c; a->owner=getpid();
    int rc=pthread_mutex_init(&a->mutex,NULL);
    if (rc) { close(fd); free(a); return fail(rc); }
    a->entries=calloc(MAX_SLOTS,sizeof *a->entries);
    if (!a->entries) goto bad;
    if (fresh) {
        if (append(a,NULL)<0 || fsync(c->directory_fd)<0) goto bad;
    } else {
        if (st.st_size<RECORD || st.st_size%RECORD || st.st_size>(off_t)(MAX_RECORDS*RECORD)) goto corrupt;
        for (off_t pos=0;pos<st.st_size;pos+=RECORD) {
            unsigned char b[RECORD],expected[RECORD];
            if (pread(fd,b,RECORD,pos)!=RECORD || memcmp(b,"STEPLC01",8) || get(b+8)!=a->records || get(b+248)!=checksum(b)) goto corrupt;
            if (!pos) { encode(a,NULL,expected); if (memcmp(b,expected,RECORD)) goto corrupt; }
            else {
                struct lc_entry e={0}; e.slot=get(b+16); e.principal=get(b+24); e.state=(enum lc_state)b[32];
                memcpy(e.epoch,b+40,32); memcpy(e.boot,b+72,36); memcpy(e.user,b+108,36);
                memcpy(e.workspace,b+144,36); memcpy(e.launch,b+180,32); name(&e);
                if (strcmp(e.epoch,c->epoch) || !uuid(e.boot) || !uuid(e.user) || !uuid(e.workspace) || !hex(e.launch,32) || !e.slot || e.slot>MAX_SLOTS) goto corrupt;
                encode(a,&e,expected); if (memcmp(b,expected,RECORD)) goto corrupt;
                if (e.slot==a->count+1) {
                    if (e.state!=LC_RESERVED) goto corrupt;
                    uint64_t active=0;
                    for (uint64_t i=0;i<a->count;i++) {
                        if (!strcmp(a->entries[i].launch,e.launch) || a->entries[i].state==LC_FENCED) goto corrupt;
                        if (a->entries[i].state!=LC_RELEASED) {
                            if (!strcmp(a->entries[i].user,e.user) && !strcmp(a->entries[i].workspace,e.workspace)) goto corrupt;
                            active++;
                        }
                    }
                    if (active>=c->capacity) goto corrupt;
                    a->count++;
                } else {
                    if (e.slot>a->count) goto corrupt;
                    struct lc_entry old=a->entries[e.slot-1];
                    if (!legal(old.state,e.state)) goto corrupt;
                    old.state=e.state; encode(a,&old,expected);
                    if (memcmp(b,expected,RECORD)) goto corrupt;
                }
                a->entries[e.slot-1]=e;
            }
            a->records++;
        }
        /* No new reserve is possible until EVERY recovered live entry is fenced.
         * A failed fence append refuses open; no half-recovered handle escapes. */
        for (uint64_t i=0;i<a->count;i++) if (a->entries[i].state!=LC_RELEASED && a->entries[i].state!=LC_FENCED) {
            struct lc_entry e=a->entries[i]; e.state=LC_FENCED;
            if (append(a,&e)<0) goto bad;
            a->entries[i]=e;
        }
        /* Re-sync even an existing fenced log before returning authority. */
        if (fsync(fd)<0 || fsync(c->directory_fd)<0) goto bad;
    }
    *out=a; return 0;
corrupt: errno=EILSEQ;
bad: { int saved=errno; lc_close(a); return fail(saved); }
}
int lc_establish(const struct lc_config *c) { struct lc *a=NULL; if (setup(c,&a,1)<0) return -1; lc_close(a); return 0; }
int lc_open(const struct lc_config *c,struct lc **out) { return setup(c,out,0); }
int lc_reserve(struct lc *a,uint64_t principal,const char *user,const char *workspace,const char *launch,struct lc_entry *out) {
    if (!out || !uuid(user) || !uuid(workspace) || !hex(launch,32)) return fail(EINVAL);
    if (locked(a)<0) return -1;
    uint64_t active=0;
    for (uint64_t i=0;i<a->count;i++) {
        if (!strcmp(a->entries[i].launch,launch)) return unlock(a,fail(EEXIST));
        if (a->entries[i].state==LC_FENCED) return unlock(a,fail(EBUSY));
        if (a->entries[i].state!=LC_RELEASED) {
            if (!strcmp(a->entries[i].user,user) && !strcmp(a->entries[i].workspace,workspace)) return unlock(a,fail(EBUSY));
            active++;
        }
    }
    if (active>=a->c.capacity || a->count>=MAX_SLOTS) return unlock(a,fail(ENOSPC));
    struct lc_entry e={.slot=a->count+1,.principal=principal,.state=LC_RESERVED};
    memcpy(e.epoch,a->c.epoch,33); memcpy(e.boot,a->c.boot,37); memcpy(e.user,user,37);
    memcpy(e.workspace,workspace,37); memcpy(e.launch,launch,33); name(&e);
    if (append(a,&e)<0) return unlock(a,-1);
    a->entries[a->count++]=e; *out=e; return unlock(a,0);
}
int lc_get(struct lc *a,uint64_t slot,struct lc_entry *out) {
    if (!out) return fail(EINVAL);
    if (locked(a)<0) return -1;
    if (!slot || slot>a->count) return unlock(a,fail(ENOENT));
    *out=a->entries[slot-1]; return unlock(a,0);
}
int lc_transition(struct lc *a,uint64_t slot,enum lc_state next) {
    if (locked(a)<0) return -1;
    if (!slot || slot>a->count) return unlock(a,fail(ENOENT));
    struct lc_entry e=a->entries[slot-1];
    if (next==LC_RELEASED || !legal(e.state,next)) return unlock(a,fail(EINVAL));
    e.state=next; if (append(a,&e)<0) return unlock(a,-1);
    a->entries[slot-1]=e; return unlock(a,0);
}
int lc_reconcile(struct lc *a,uint64_t slot,enum lc_proof (*callback)(void *,const struct lc_entry *),void *ctx) {
    if (!callback) return fail(EINVAL);
    if (locked(a)<0) return -1;
    if (!slot || slot>a->count) return unlock(a,fail(ENOENT));
    struct lc_entry e=a->entries[slot-1];
    if (e.state==LC_RELEASED) return unlock(a,0);
    if (callback(ctx,&e)!=LC_ABSENT_AND_CLEAN) return unlock(a,fail(EAGAIN));
    e.state=LC_RELEASED; if (append(a,&e)<0) return unlock(a,-1);
    a->entries[slot-1]=e; return unlock(a,0);
}
