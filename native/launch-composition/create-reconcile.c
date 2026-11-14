#define _GNU_SOURCE
#include "create-reconcile.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
/* Exact create.c line formats (native/systemd-create/create.c):
 *   INTENT v1 <slot> <principal> <epoch> <boot> <user> <workspace> <launch> <unit> <bus id> <manager>\n
 *   JOB <job> /org/freedesktop/systemd1/job/<job>\n
 *   ANCHOR <job> <invocation> /system.slice/<unit>\n
 * Every field has a fixed width or a hard bound (decimal: overflow-checked,
 * manager < 128), so valid lines are at most 455/55/130 bytes; the whole
 * journal is capped at LCR_JOURNAL_MAX before parsing. */
#define JOB_PREFIX "/org/freedesktop/systemd1/job/"
#define CGROUP_PREFIX "/system.slice/"
struct lcr {
    struct lcr_config c;
    struct lso_ops ops;
    void *ops_context;
    int production, fd, absent, poisoned, seen, reset; /* reset: 0 not attempted, 1 done, -1 failed */
    struct lso *observer;
    size_t seen_length;
    char seen_bytes[LCR_JOURNAL_MAX];
};
struct span { const char *p; size_t n; };
static int is_hex(char c) { return (c>='0' && c<='9') || (c>='a' && c<='f'); }
static int hex32(struct span s) {
    if (s.n!=32) return 0;
    int nonzero=0;
    for (size_t i=0;i<32;i++) { if (!is_hex(s.p[i])) return 0; nonzero|=s.p[i]!='0'; }
    return nonzero;
}
static int uuid(struct span s) {
    if (s.n!=36) return 0;
    for (size_t i=0;i<36;i++) {
        if (i==8 || i==13 || i==18 || i==23) { if (s.p[i]!='-') return 0; }
        else if (!is_hex(s.p[i])) return 0;
    }
    return 1;
}
/* Canonical unsigned decimal: no sign, no leading zero, no overflow. */
static int decimal(struct span s,uint64_t max,int zero,uint64_t *out) {
    if (!s.n || (s.p[0]=='0' && s.n>1) || (s.p[0]=='0' && !zero)) return 0;
    uint64_t v=0;
    for (size_t i=0;i<s.n;i++) {
        if (s.p[i]<'0' || s.p[i]>'9') return 0;
        uint64_t d=(uint64_t)(s.p[i]-'0');
        if (v>(UINT64_MAX-d)/10) return 0;
        v=v*10+d;
    }
    if (v>max) return 0;
    *out=v; return 1;
}
/* Same rule as create.c unique_name: ":<digits>.<digits>", shorter than 128. */
static int unique_name(struct span s) {
    if (s.n>=128 || s.p[0]!=':') return 0;
    size_t dots=0, run=0;
    for (size_t i=1;i<s.n;i++) {
        if (s.p[i]>='0' && s.p[i]<='9') { run++; continue; }
        if (s.p[i]!='.' || !run) return 0;
        dots++; run=0;
    }
    return dots==1 && run>0;
}
static int equals(struct span s,const char *text) { return strlen(text)==s.n && !memcmp(s.p,text,s.n); }
static void store(char *out,struct span s) { memcpy(out,s.p,s.n); out[s.n]=0; }
/* Split exactly `count` fields separated by single spaces. Empty fields are
 * rejected by every field validator (none accepts length 0). */
static int fields(struct span line,struct span *f,size_t count) {
    size_t at=0;
    for (size_t i=0;i<count;i++) {
        size_t start=at;
        while (at<line.n && line.p[at]!=' ') at++;
        f[i]=(struct span){line.p+start,at-start};
        if (at==line.n) return i+1==count; /* last field ends the line exactly */
        at++;
    }
    return 0; /* more separators than fields */
}
static int intent(struct span line,struct lcr_journal *j) {
    struct span f[12]={{0}};
    if (!fields(line,f,12) || !equals(f[0],"INTENT") || !equals(f[1],"v1") ||
        !decimal(f[2],UINT64_MAX,0,&j->slot) || !decimal(f[3],UINT64_MAX,1,&j->principal) ||
        !hex32(f[4]) || !uuid(f[5]) || !uuid(f[6]) || !uuid(f[7]) || !hex32(f[8]) ||
        !hex32(f[10]) || !unique_name(f[11])) return 0;
    store(j->epoch,f[4]); store(j->boot,f[5]); store(j->user,f[6]); store(j->workspace,f[7]);
    store(j->launch,f[8]); store(j->bus_id,f[10]); store(j->manager,f[11]);
    char unit[100];
    (void)snprintf(unit,sizeof unit,"step-lc-%s-%016llx.service",j->epoch,(unsigned long long)j->slot);
    if (!equals(f[9],unit)) return 0; /* the unit is derived, never chosen */
    memcpy(j->unit,unit,sizeof unit);
    return 1;
}
static int job(struct span line,struct lcr_journal *j) {
    struct span f[3]={{0}}; uint64_t n=0;
    if (!fields(line,f,3) || !equals(f[0],"JOB") || !decimal(f[1],UINT32_MAX,0,&n)) return 0;
    if (f[2].n!=sizeof JOB_PREFIX-1+f[1].n || memcmp(f[2].p,JOB_PREFIX,sizeof JOB_PREFIX-1) ||
        memcmp(f[2].p+sizeof JOB_PREFIX-1,f[1].p,f[1].n)) return 0;
    j->job=(unsigned)n; return 1;
}
static int anchor(struct span line,struct lcr_journal *j) {
    struct span f[4]={{0}}; uint64_t n=0; char cgroup[sizeof j->cgroup];
    if (!fields(line,f,4) || !equals(f[0],"ANCHOR") || !decimal(f[1],UINT32_MAX,0,&n) ||
        n!=j->job || !hex32(f[2])) return 0;
    (void)snprintf(cgroup,sizeof cgroup,CGROUP_PREFIX "%s",j->unit);
    if (!equals(f[3],cgroup)) return 0;
    store(j->invocation,f[2]); memcpy(j->cgroup,cgroup,sizeof cgroup); return 1;
}
int lcr_parse(const char *bytes,size_t length,struct lcr_journal *j,enum lcr_reason *reason) {
    enum lcr_reason ignored; if (!reason) reason=&ignored;
    *reason=LCR_R_GRAMMAR;
    if (!bytes || !j) return -1;
    memset(j,0,sizeof *j);
    if (length>LCR_JOURNAL_MAX) { *reason=LCR_R_JOURNAL; return -1; }
    size_t at=0; int lines=0;
    while (at<length) {
        const char *end=memchr(bytes+at,'\n',length-at);
        if (!end) { *reason=LCR_R_TORN; return -1; } /* partial final write */
        struct span line={bytes+at,(size_t)(end-(bytes+at))};
        int ok=lines==0 ? intent(line,j):lines==1 ? job(line,j):lines==2 ? anchor(line,j):0;
        if (!ok) { *reason=LCR_R_GRAMMAR; return -1; }
        lines++; at+=line.n+1;
    }
    *reason=LCR_R_NONE; return lines;
}
int lcr_open_with_ops(const struct lcr_config *c,const struct lso_ops *ops,void *ctx,struct lcr **out) {
    if (!out) { errno=EINVAL; return -1; }
    *out=NULL;
    if (!c || !c->owner || !c->slot || !ops || !ops->snapshot) { errno=EINVAL; return -1; }
    int mode=fcntl(c->journal_fd,F_GETFL);
    if (mode<0 || ((mode&O_ACCMODE)!=O_RDONLY && (mode&O_ACCMODE)!=O_RDWR)) { errno=EBADF; return -1; }
    struct lcr *h=calloc(1,sizeof *h); if (!h) return -1;
    h->c=*c; h->ops=*ops; h->ops_context=ctx;
    h->fd=fcntl(c->journal_fd,F_DUPFD_CLOEXEC,3);
    /* Excludes holders on other open file descriptions (an in-flight creator). */
    if (h->fd<0 || flock(h->fd,LOCK_EX|LOCK_NB)<0) {
        int saved=errno; if (h->fd>=0) close(h->fd); free(h); errno=saved; return -1;
    }
    *out=h; return 0;
}
int lcr_open(const struct lcr_config *c,struct lcr **out) {
    if (out) *out=NULL;
    if (!c || c->trusted_uid!=0) { errno=EPERM; return -1; }
    const struct lso_ops ops={.snapshot=lso_bus_snapshot};
    if (lcr_open_with_ops(c,&ops,NULL,out)<0) return -1;
    (*out)->production=1; return 0;
}
static int read_journal(struct lcr *h,char *buf,size_t *n) {
    struct stat st;
    if (fstat(h->fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=h->c.trusted_uid || (st.st_mode&07777)!=0600 ||
        st.st_nlink!=1 || st.st_size<0 || st.st_size>LCR_JOURNAL_MAX) return 0;
    /* One byte beyond st_size detects growth since fstat. */
    ssize_t r=pread(h->fd,buf,(size_t)st.st_size+1,0);
    if (r<0 || r!=st.st_size) return 0;
    *n=(size_t)r; return 1;
}
static int bound(const struct lc_entry *e,const struct lcr_journal *j) {
    char unit[100];
    (void)snprintf(unit,sizeof unit,"%s.service",e->container);
    /* unit is derived from the journal's epoch+slot by the grammar and the
     * container from the ledger's, so the unit comparison binds both. */
    return !strcmp(unit,j->unit) && e->principal==j->principal && !strcmp(e->boot,j->boot)
        && !strcmp(e->user,j->user) && !strcmp(e->workspace,j->workspace) &&
        !strcmp(e->launch,j->launch);
}
static int boot_matches(struct lcr *h,const char *boot) {
    struct stat st; char b[39]={0};
    if (fstat(h->c.boot_fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=h->c.trusted_uid ||
        (st.st_mode&022)) return 0;
    return pread(h->c.boot_fd,b,sizeof b-1,0)==37 && b[36]=='\n' && !memcmp(b,boot,36);
}
enum class { C_LIVE, C_CANDIDATE };
/* One read-only snapshot through the observer's seam, classified against the
 * journal's own bus/manager/unit/invocation/cgroup. */
static enum lcr_reason classify(struct lcr *h,const struct lcr_journal *j,int *out) {
    struct lso_snapshot s; memset(&s,0,sizeof s);
    if (h->ops.snapshot(h->ops_context,j->unit,j->manager,&s)<0 ||
        !memchr(s.bus_id,0,sizeof s.bus_id) || !memchr(s.manager,0,sizeof s.manager) ||
        !memchr(s.invocation,0,sizeof s.invocation) || !memchr(s.cgroup,0,sizeof s.cgroup) ||
        !memchr(s.state,0,sizeof s.state) || (s.missing!=0 && s.missing!=1)) return LCR_R_QUERY;
    if (strcmp(s.bus_id,j->bus_id)) return LCR_R_BUS;
    if (strcmp(s.manager,j->manager)) return LCR_R_MANAGER;
    if (s.missing) return LCR_R_COLLECTED;
    /* ControlGroup must be the journal's path, or "" for a stopped unit whose
     * cgroup systemd pruned (systemd 259). "" is never evidence: a candidate
     * still needs the observer's pinned-descriptor proof. Another nonempty
     * path, or "" on an active unit, is not this incarnation. */
    int exact_cgroup=!strcmp(s.cgroup,j->cgroup);
    if (strcmp(s.invocation,j->invocation) || (!exact_cgroup && s.cgroup[0])) return LCR_R_INVOCATION;
    if (s.job) return LCR_R_TRANSIENT;
    if (!strcmp(s.state,"active")) { if (!exact_cgroup) return LCR_R_INVOCATION; *out=C_LIVE; return LCR_R_NONE; }
    if (!strcmp(s.state,"inactive") || !strcmp(s.state,"failed")) { *out=C_CANDIDATE; return LCR_R_NONE; }
    return LCR_R_TRANSIENT;
}
static int observer(struct lcr *h,const struct lc_entry *e,const struct lcr_journal *j) {
    if (h->observer) return 1;
    /* A lost descriptor (cgroup_fd < 0) makes both lso_open variants fail. */
    struct lso_config c={.entry=*e,.boot_fd=h->c.boot_fd,.cgroup_fd=h->c.cgroup_fd,.trusted_uid=h->c.trusted_uid,
        .cgroup_device=h->c.cgroup_device,.cgroup_inode=h->c.cgroup_inode,.context=h->c.context,
        .lifetime_fenced=h->c.lifetime_fenced};
    memcpy(c.bus_id,j->bus_id,sizeof c.bus_id); memcpy(c.manager,j->manager,sizeof c.manager);
    memcpy(c.invocation,j->invocation,sizeof c.invocation); memcpy(c.cgroup,j->cgroup,sizeof c.cgroup);
    int rc=h->production ? lso_open(&c,&h->observer):lso_open_with_ops(&c,&h->ops,h->ops_context,&h->observer);
    return rc==0;
}
static int verdict(enum lcr_verdict *v,enum lcr_reason *r,enum lcr_verdict value,enum lcr_reason why,int rc) {
    *v=value; *r=why; return rc;
}
int lcr_reconcile(struct lcr *h,enum lcr_verdict *v,enum lcr_reason *r) {
    enum lcr_verdict vi; enum lcr_reason ri;
    if (!v) v=&vi;
    if (!r) r=&ri;
    *v=LCR_UNKNOWN; *r=LCR_R_JOURNAL;
    if (!h) { errno=EINVAL; return -1; }
    if (h->poisoned) return verdict(v,r,LCR_UNKNOWN,LCR_R_CHANGED,0);
    char bytes[LCR_JOURNAL_MAX+1]; size_t n=0;
    if (!read_journal(h,bytes,&n)) return verdict(v,r,LCR_UNKNOWN,LCR_R_JOURNAL,0);
    /* The observer was built from earlier bytes: any later change is UNKNOWN forever. */
    if (h->seen && (n!=h->seen_length || memcmp(bytes,h->seen_bytes,n))) {
        h->poisoned=1; return verdict(v,r,LCR_UNKNOWN,LCR_R_CHANGED,0);
    }
    if (!h->seen) { memcpy(h->seen_bytes,bytes,n); h->seen_length=n; h->seen=1; }
    struct lcr_journal j; enum lcr_reason why;
    int lines=lcr_parse(bytes,n,&j,&why);
    if (lines<0) return verdict(v,r,LCR_UNKNOWN,why,0);
    if (lines==0) return verdict(v,r,LCR_UNKNOWN,LCR_R_EMPTY,0);
    if (lines==1) return verdict(v,r,LCR_UNKNOWN,LCR_R_NO_JOB,0);
    if (lines==2) return verdict(v,r,LCR_UNKNOWN,LCR_R_NO_ANCHOR,0);
    struct lc_entry e;
    if (lco_get(h->c.owner,h->c.slot,&e)<0) return verdict(v,r,LCR_UNKNOWN,LCR_R_LEDGER,-1);
    if (!bound(&e,&j)) return verdict(v,r,LCR_UNKNOWN,LCR_R_LEDGER,0);
    if (e.state==LC_RELEASED) return verdict(v,r,LCR_ALREADY_RELEASED,LCR_R_RELEASED,0);
    if (!boot_matches(h,j.boot)) return verdict(v,r,LCR_UNKNOWN,LCR_R_BOOT,0);
    int c=-1;
    why=classify(h,&j,&c);
    if (why==LCR_R_NONE && c==C_LIVE) return verdict(v,r,LCR_ANCHORED,LCR_R_NONE,0);
    /* A collected unit counts only as cleanup evidence after this handle's own
     * absence receipt; otherwise nothing but an exact candidate may proceed. */
    if (!(why==LCR_R_COLLECTED && h->absent) && !(why==LCR_R_NONE && c==C_CANDIDATE))
        return verdict(v,r,LCR_UNKNOWN,why,0);
    if (!observer(h,&e,&j)) return verdict(v,r,LCR_UNKNOWN,LCR_R_NO_PIN,0);
    if (!h->absent) {
        if (lso_absent(h->observer,&e)!=1) return verdict(v,r,LCR_UNKNOWN,LCR_R_UNPROVEN,0);
        h->absent=1;
    }
    /* Separately gated post-absence step, only while the exact unit is still
     * loaded (why NONE = candidate; a collected unit never reaches it). One
     * attempt per handle, consumed before the call; the receipt, fence and
     * pins are re-validated immediately before it. */
    if (why==LCR_R_NONE && h->c.reset) {
        if (h->reset<0) return verdict(v,r,LCR_UNKNOWN,LCR_R_RESET,0);
        if (!h->reset) {
            if (lso_absent(h->observer,&e)!=1) return verdict(v,r,LCR_UNKNOWN,LCR_R_UNPROVEN,0);
            h->reset=-1;
            if (h->c.reset(h->c.reset_context,&e,&j,lso_absent,h->observer)!=1) return verdict(v,r,LCR_UNKNOWN,LCR_R_RESET,0);
            h->reset=1;
        }
    }
    /* Release only inside the lifecycle ledger, after absence AND cleanup. */
    if (lso_reconcile(h->observer,h->c.owner,h->c.slot)<0) return verdict(v,r,LCR_UNKNOWN,LCR_R_UNPROVEN,0);
    return verdict(v,r,LCR_ABSENT_PROVEN,LCR_R_NONE,0);
}
void lcr_close(struct lcr *h) {
    if (!h) return;
    lso_close(h->observer);
    (void)flock(h->fd,LOCK_UN); close(h->fd); free(h);
}
