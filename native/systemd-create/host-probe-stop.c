/* Read-only host probe for stop.c: runs the production owner(), invocation-path
 * lookup (GetUnitByInvocationID with an ay argument through sd_bus_call, error
 * name handling) and verify() readers against the REAL system bus and
 * libsystemd, and checks every method/property signature stop.c uses against
 * live introspection. Only Get/GetUnitByInvocationID/ListUnitsByPatterns/
 * Introspect/GetNameOwner calls; never Kill, Stop, Subscribe or any mutation.
 * Not part of `make test`. */
#include "stop.c"
#include <assert.h>
extern int sd_bus_message_enter_container(sd_bus_message *,char,const char *);
static int failures;
#define CHECK(what,cond) do { int ok_=(cond); printf("%s %s\n",ok_ ? "ok  ":"FAIL",what); failures+=!ok_; } while (0)
static char xml[262144];
static int introspect(struct las *s,const char *path) {
    sd_bus_message *m=NULL; const char *x=NULL;
    int ok=sd_bus_call_method(s->bus,s->c.manager,path,"org.freedesktop.DBus.Introspectable","Introspect",NULL,&m,"")>=0 &&
        sd_bus_message_read(m,"s",&x)>0 && x && strlen(x)<sizeof xml && sd_bus_message_at_end(m,1)>0;
    if (ok) strcpy(xml,x);
    sd_bus_message_unref(m); return ok;
}
static const char *block(const char *iface,const char *kind,const char *name,const char **end) {
    char head[160], tag[160]; (void)snprintf(head,sizeof head,"<interface name=\"%s\">",iface);
    const char *b=strstr(xml,head); if (!b) return NULL;
    const char *e=strstr(b,"</interface>"); if (!e) return NULL;
    (void)snprintf(tag,sizeof tag,"<%s name=\"%s\"",kind,name);
    const char *p=strstr(b,tag); if (!p || p>e) return NULL;
    *end=strstr(p,kind[0]=='p' ? "/>":kind[0]=='m' ? "</method>":"</signal>"); return *end ? p:NULL;
}
static int property(const char *iface,const char *name,const char *type) {
    char want[200]; const char *end=NULL; (void)snprintf(want,sizeof want,"<property name=\"%s\" type=\"%s\"",name,type);
    const char *p=block(iface,"property",name,&end); return p && !strncmp(p,want,strlen(want));
}
/* args: "in:s,in:i" or "in:s,out:o" (method) / "u,o,s,s" (signal), in order, nothing else */
static int member(const char *iface,const char *kind,const char *name,const char *const *args,size_t n) {
    const char *end=NULL, *p=block(iface,kind,name,&end); if (!p) return 0;
    for (size_t i=0;i<n;i++) {
        char want[96]; const char *colon=strchr(args[i],':');
        p=strstr(p,"<arg type=\""); if (!p || p>end) return 0;
        if (colon) (void)snprintf(want,sizeof want,"<arg type=\"%s\" name=\"",colon+1); else (void)snprintf(want,sizeof want,"<arg type=\"%s\"",args[i]);
        if (strncmp(p,want,strlen(want))) return 0;
        const char *close=strstr(p,"/>"); if (!close) return 0;
        if (colon) { char dir[32]; (void)snprintf(dir,sizeof dir,"direction=\"%.*s\"",(int)(colon-args[i]),args[i]); const char *d=strstr(p,dir); if (!d || d>close) return 0; }
        p=close;
    }
    const char *more=strstr(p,"<arg "); return !more || more>end;
}
static int invocation_of(struct las *s,const char *unit,char *hexout) {
    char path[256]; sd_bus_message *m=NULL; const void *b=NULL; size_t n=0;
    if (!object_path(unit,path,sizeof path)) return 0;
    int ok=sd_bus_get_property(s->bus,s->c.manager,path,UI,"InvocationID",NULL,&m,"ay")>=0 && sd_bus_message_read_array(m,'y',&b,&n)>0 && n==16;
    if (ok) for (size_t i=0;i<16;i++) (void)snprintf(hexout+2*i,3,"%02x",(unsigned)((const unsigned char *)b)[i]);
    sd_bus_message_unref(m); return ok && hex(hexout);
}
static void target(struct las *s,const char *unit,const char *invocation) {
    (void)snprintf(s->unit,sizeof s->unit,"%s",unit); (void)snprintf(s->cgroup,sizeof s->cgroup,"/system.slice/%s",unit);
    (void)snprintf(s->c.invocation,sizeof s->c.invocation,"%s",invocation);
    for (size_t i=0;i<16;i++) { unsigned v=0; (void)sscanf(invocation+2*i,"%2x",&v); s->invocation[i]=(unsigned char)v; }
    assert(object_path(invocation,s->invocation_path,sizeof s->invocation_path));
    s->deadline=now()+ATTEMPT_US; memset(&s->receipt,0,sizeof s->receipt);
}
/* First loaded failed (else inactive) service that still has an InvocationID. */
static int stopped_unit(struct las *s,char *unit,size_t un,char *invocation) {
    static const char *const states[]={"failed","inactive"};
    for (size_t k=0;k<2;k++) {
        sd_bus_message *m=NULL; int found=0;
        if (sd_bus_call_method(s->bus,s->c.manager,MANAGER,MI,"ListUnitsByPatterns",NULL,&m,"asas",1,states[k],1,"*.service")<0) return 0;
        if (sd_bus_message_enter_container(m,'a',"(ssssssouso)")>0) {
            const char *id,*d,*l,*a,*sub,*f,*jt,*jp; const char *path=NULL; uint32_t job;
            while (!found && sd_bus_message_read(m,"(ssssssouso)",&id,&d,&l,&a,&sub,&f,&path,&job,&jt,&jp)>0)
                if (strlen(id)<un && invocation_of(s,id,invocation)) { strcpy(unit,id); found=1; }
        }
        sd_bus_message_unref(m); if (found) return 1;
    }
    return 0;
}
int main(void) {
    struct las s; memset(&s,0,sizeof s); s.deadline=now()+ATTEMPT_US;
    if (sd_bus_new(&s.bus)<0 || sd_bus_set_address(s.bus,"unix:path=/run/dbus/system_bus_socket")<0 ||
        sd_bus_set_bus_client(s.bus,1)<0 || !budget(&s) || sd_bus_start(s.bus)<0 || ready(s.bus,s.deadline)!=1) { puts("FAIL connect"); return 1; }
    sd_id128_t id; sd_bus_message *m=NULL; const char *name=NULL;
    assert(sd_bus_get_bus_id(s.bus,&id)>=0);
    for (size_t i=0;i<16;i++) (void)snprintf(s.c.bus_id+2*i,3,"%02x",(unsigned)id.bytes[i]);
    assert(sd_bus_call_method(s.bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetNameOwner",NULL,&m,"s","org.freedesktop.systemd1")>=0);
    assert(sd_bus_message_read(m,"s",&name)>0 && strlen(name)<sizeof s.c.manager); strcpy(s.c.manager,name); sd_bus_message_unref(m);
    s.deadline=now()+ATTEMPT_US;
    CHECK("manager unique name passes unique_name()",unique_name(s.c.manager,sizeof s.c.manager));
    CHECK("owner(): peer uid 0, bus id, GetNameOwner, GetConnectionUnixUser 0",owner(&s)==LAS_R_NONE);
    /* signatures stop.c sends or reads, from live introspection */
    CHECK("Introspect manager",introspect(&s,MANAGER));
    static const char *const by_inv[]={"in:ay","out:o"}, *const removed_[]={"u","o","s","s"}, *const subscribe[]={NULL};
    CHECK("Manager.GetUnitByInvocationID(ay) -> o",member(MI,"method","GetUnitByInvocationID",by_inv,2));
    CHECK("Manager.JobRemoved signal (uoss)",member(MI,"signal","JobRemoved",removed_,4));
    CHECK("Manager.Subscribe() no arguments",member(MI,"method","Subscribe",subscribe,0));
    char inv[33]={0};
    CHECK("dbus.service InvocationID",invocation_of(&s,"dbus.service",inv));
    target(&s,"dbus.service",inv);
    CHECK("Introspect dbus.service via its invocation path",introspect(&s,s.invocation_path));
    static const char *const kill_[]={"in:s","in:i"}, *const stop_[]={"in:s","out:o"};
    CHECK("Unit.Kill(s whom, i signal) on the invocation path",member(UI,"method","Kill",kill_,2));
    CHECK("Unit.Stop(s mode) -> o on the invocation path",member(UI,"method","Stop",stop_,2));
    CHECK("Unit.Id s",property(UI,"Id","s")); CHECK("Unit.InvocationID ay",property(UI,"InvocationID","ay"));
    CHECK("Unit.ActiveState s",property(UI,"ActiveState","s")); CHECK("Unit.Job (uo)",property(UI,"Job","(uo)"));
    CHECK("Service.ControlGroup s",property(SI,"ControlGroup","s"));
    /* production readers on real replies */
    CHECK("by_invocation(): GetUnitByInvocationID returns exactly the encoded invocation path",by_invocation(&s)==LAS_R_NONE);
    CHECK("verify(BEFORE) accepts active dbus.service (id, invocation, cgroup, no job)",verify(&s,BEFORE)==LAS_R_NONE);
    target(&s,"dbus.service",inv);
    CHECK("verify(AFTER) refuses an active unit (STATE)",verify(&s,AFTER)==LAS_R_STATE);
    target(&s,"systemd-journald.service",inv);
    CHECK("verify() refuses another unit's name for this invocation (REPLACED)",verify(&s,BEFORE)==LAS_R_REPLACED);
    target(&s,"dbus.service","0123456789abcdef0123456789abcdef");
    CHECK("unknown invocation: NoUnitForInvocationID error name -> REPLACED",by_invocation(&s)==LAS_R_REPLACED);
    char unit[100], sinv[33]={0};
    if (stopped_unit(&s,unit,sizeof unit,sinv)) {
        printf("     stopped unit %s invocation %s\n",unit,sinv);
        target(&s,unit,sinv);
        enum las_reason r=verify(&s,AFTER);
        CHECK("verify(AFTER) accepts a loaded inactive/failed unit by invocation path",r==LAS_R_NONE);
        printf("     ActiveState %s\n",s.receipt.state);
        char cg[512]={0}; target(&s,unit,sinv);
        CHECK("its ControlGroup is \"\" (pruned): BEFORE-cgroup equality cannot hold after stop",
            string_prop(&s,SI,"ControlGroup",cg,sizeof cg)==LAS_R_NONE && !*cg);
    } else puts("skip no loaded inactive/failed service with an InvocationID");
    sd_bus_unref(s.bus);
    printf("host-probe-stop: %d failure(s); read-only, no Kill/Stop sent\n",failures);
    return failures ? 1:0;
}
