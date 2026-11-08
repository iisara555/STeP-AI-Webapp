/* Read-only host probe: runs the production owner check, unit path encoding,
 * property readers and cursor patterns of create.c against the REAL system bus
 * and libsystemd, and verifies every property name/type create.c sends or reads
 * against live introspection. Only Get/GetUnit/Introspect/GetNameOwner calls;
 * never StartTransientUnit, Subscribe or any mutation. Not part of `make test`. */
#include "create.c"
#include <assert.h>
static int failures;
#define CHECK(what,cond) do { int ok_=(cond); printf("%s %s\n",ok_ ? "ok  ":"FAIL",what); failures+=!ok_; } while (0)
static char xml[262144];
static int introspect(struct lsc *s,const char *path) {
    sd_bus_message *m=NULL; const char *x=NULL;
    int ok=sd_bus_call_method(s->bus,s->c.manager,path,"org.freedesktop.DBus.Introspectable","Introspect",NULL,&m,"")>=0 &&
        sd_bus_message_read(m,"s",&x)>0 && x && strlen(x)<sizeof xml && sd_bus_message_at_end(m,1)>0;
    if (ok) strcpy(xml,x);
    sd_bus_message_unref(m); return ok;
}
static int declared(const char *iface,const char *name,const char *type) {
    char head[160], want[200]; (void)snprintf(head,sizeof head,"<interface name=\"%s\">",iface);
    const char *b=strstr(xml,head); if (!b) return 0;
    const char *e=strstr(b,"</interface>"); if (!e) return 0;
    (void)snprintf(want,sizeof want,"<property name=\"%s\" type=\"%s\"",name,type);
    const char *p=strstr(b,want); return p && p<e;
}
static int lookup(struct lsc *s,const char *unit,char *path,size_t n) {
    sd_bus_message *m=NULL; const char *p=NULL;
    int ok=sd_bus_call_method(s->bus,s->c.manager,MANAGER,MI,"GetUnit",NULL,&m,"s",unit)>=0 && sd_bus_message_read(m,"o",&p)>0 &&
        p && strlen(p)<n && sd_bus_message_at_end(m,1)>0;
    if (ok) strcpy(path,p);
    sd_bus_message_unref(m); return ok;
}
/* Same sd-bus call pattern as fixed_matches, without the value comparison. */
static int scalar(struct lsc *s,const struct fixed *f) {
    sd_bus_message *m=NULL; char type[2]={f->type,0}; int ok=get(s,f->iface,f->name,type,&m);
    if (ok && f->type=='s') { const char *v=NULL; ok=sd_bus_message_read(m,"s",&v)>0 && v; }
    else if (ok && f->type=='b') { int v=-1; ok=sd_bus_message_read(m,"b",&v)>0 && (v==0 || v==1); }
    else if (ok && f->type=='u') { uint32_t v; ok=sd_bus_message_read(m,"u",&v)>0; }
    else if (ok) { uint64_t v; ok=sd_bus_message_read(m,"t",&v)>0; }
    ok=ok && property_end(m); sd_bus_message_unref(m); return ok;
}
/* exec_start's exact cursor sequence, accepting any argv. */
static int exec_shape(struct lsc *s) {
    sd_bus_message *m=NULL; const char *path=NULL, *arg=NULL; int ignore=-1, argc=0; uint64_t t[4]; uint32_t pid; int32_t code,status;
    int ok=get(s,SI,"ExecStart","a(sasbttttuii)",&m) && sd_bus_message_enter_container(m,'a',"(sasbttttuii)")>0 &&
        sd_bus_message_enter_container(m,'r',"sasbttttuii")>0 && sd_bus_message_read(m,"s",&path)>0 && path &&
        sd_bus_message_enter_container(m,'a',"s")>0;
    while (ok && sd_bus_message_at_end(m,0)==0) { ok=sd_bus_message_read(m,"s",&arg)>0; argc++; }
    ok=ok && argc>0 && sd_bus_message_exit_container(m)>0 &&
        sd_bus_message_read(m,"bttttuii",&ignore,&t[0],&t[1],&t[2],&t[3],&pid,&code,&status)>0 && (ignore==0 || ignore==1) &&
        sd_bus_message_at_end(m,0)>0 && sd_bus_message_exit_container(m)>0 &&
        sd_bus_message_at_end(m,0)>0 && sd_bus_message_exit_container(m)>0 && property_end(m);
    if (ok) printf("     ExecStart %s argc=%d ignore=%d\n",path,argc,ignore);
    sd_bus_message_unref(m); return ok;
}
static int observe_tail(struct lsc *s) {
    sd_bus_message *m=NULL; const void *bytes=NULL; size_t n=0; uint32_t job=1; const char *p=NULL;
    int ok=get(s,UI,"InvocationID","ay",&m) && sd_bus_message_read_array(m,'y',&bytes,&n)>0 && n==16 && property_end(m);
    sd_bus_message_unref(m); m=NULL;
    ok=ok && get(s,UI,"Job","(uo)",&m) && sd_bus_message_read(m,"(uo)",&job,&p)>0 && p && property_end(m);
    if (ok) printf("     Job %u %s\n",job,p);
    sd_bus_message_unref(m); return ok;
}
int main(void) {
    struct lsc s; memset(&s,0,sizeof s);
    if (sd_bus_new(&s.bus)<0 || sd_bus_set_address(s.bus,"unix:path=/run/dbus/system_bus_socket")<0 ||
        sd_bus_set_bus_client(s.bus,1)<0 || sd_bus_start(s.bus)<0 || sd_bus_set_method_call_timeout(s.bus,2000000)<0) { puts("FAIL connect"); return 1; }
    sd_id128_t id; sd_bus_message *m=NULL; const char *name=NULL;
    assert(sd_bus_get_bus_id(s.bus,&id)>=0);
    for (size_t i=0;i<16;i++) (void)snprintf(s.c.bus_id+2*i,3,"%02x",(unsigned)id.bytes[i]);
    assert(sd_bus_call_method(s.bus,"org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetNameOwner",NULL,&m,"s","org.freedesktop.systemd1")>=0);
    assert(sd_bus_message_read(m,"s",&name)>0 && strlen(name)<sizeof s.c.manager); strcpy(s.c.manager,name); sd_bus_message_unref(m);
    CHECK("manager unique name passes unique_name()",unique_name(s.c.manager,sizeof s.c.manager));
    CHECK("owner(): peer uid 0, bus id, GetNameOwner, GetConnectionUnixUser 0",owner(&s));
    strcpy(s.c.bus_id,"ffffffffffffffffffffffffffffffff");
    CHECK("owner() refuses a different expected bus id",!owner(&s));
    static const char *const units[]={"dbus.service","systemd-journald.service"};
    char path[256], enc[256];
    for (size_t i=0;i<2;i++) {
        CHECK(units[i],lookup(&s,units[i],path,sizeof path) && unit_object_path(units[i],enc,sizeof enc) && !strcmp(path,enc));
    }
    assert(lookup(&s,"dbus.service",path,sizeof path)); strcpy(s.unit_path,path);
    CHECK("Introspect dbus.service",introspect(&s,path));
    const struct fixed *tables[]={FIXED,EFFECTIVE}; size_t sizes[]={sizeof FIXED/sizeof *FIXED,sizeof EFFECTIVE/sizeof *EFFECTIVE};
    for (size_t t=0;t<2;t++) for (size_t i=0;i<sizes[t];i++) {
        char what[160], type[2]={tables[t][i].type,0};
        (void)snprintf(what,sizeof what,"introspected %s %s %s",tables[t][i].iface+24,tables[t][i].name,type);
        CHECK(what,declared(tables[t][i].iface,tables[t][i].name,type));
        (void)snprintf(what,sizeof what,"real Get+read+property_end %s",tables[t][i].name); CHECK(what,scalar(&s,&tables[t][i]));
    }
    static const struct { const char *iface, *name, *type; } complex_[]={
        {SI,"IPAddressDeny","a(iayu)"}, {SI,"RestrictAddressFamilies","(bas)"}, {SI,"SystemCallFilter","(bas)"},
        {SI,"SystemCallArchitectures","as"}, {SI,"ExecStart","a(sasbttttuii)"}, {SI,"MainPID","u"}, {SI,"ControlGroup","s"},
        {UI,"DropInPaths","as"}, {UI,"InvocationID","ay"}, {UI,"Job","(uo)"},
    };
    for (size_t i=0;i<sizeof complex_/sizeof *complex_;i++) {
        char what[160]; (void)snprintf(what,sizeof what,"introspected %s %s %s",complex_[i].iface+24,complex_[i].name,complex_[i].type);
        CHECK(what,declared(complex_[i].iface,complex_[i].name,complex_[i].type));
    }
    CHECK("ExecStart cursor sequence (dbus.service)",exec_shape(&s));
    CHECK("InvocationID read_array + Job (uo) (dbus.service)",observe_tail(&s));
    CHECK("DropInPaths empty via strv_prop (dbus.service)",strv_prop(&s,UI,"DropInPaths",NULL,0));
    char cg[512]; CHECK("ControlGroup via string_prop (dbus.service)",string_prop(&s,SI,"ControlGroup",cg,sizeof cg) && !strcmp(cg,"/system.slice/dbus.service"));
    assert(lookup(&s,"systemd-journald.service",path,sizeof path)); strcpy(s.unit_path,path);
    CHECK("IPAddressDeny=any recognised by deny_any (journald)",deny_any(&s));
    static const char *const native[]={"native"};
    CHECK("SystemCallArchitectures=native via strv_prop (journald)",strv_prop(&s,SI,"SystemCallArchitectures",native,1));
    CHECK("journald broad filter rejected by syscall_filter",!syscall_filter(&s));
    CHECK("journald address families rejected by no_families",!no_families(&s));
    sd_bus_unref(s.bus);
    printf("host-probe: %d failure(s); read-only, no unit created\n",failures);
    return failures ? 1:0;
}
