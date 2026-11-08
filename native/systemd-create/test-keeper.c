#define _POSIX_C_SOURCE 200809L
#define main keeper_main
#define getuid fixture_uid
#define geteuid fixture_euid
#define pause fixture_pause
#include "keeper.c"
#undef main
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
static uid_t real_uid, effective_uid;
static jmp_buf escaped;
static int paused;
uid_t fixture_uid(void) { return real_uid; }
uid_t fixture_euid(void) { return effective_uid; }
int fixture_pause(void) { paused++; longjmp(escaped,1); }
int main(void) {
    char *argv[]={"keeper",NULL};
    real_uid=effective_uid=1000; assert(keeper_main(1,argv)==64);
    real_uid=0; assert(keeper_main(1,argv)==64);
    effective_uid=0; assert(keeper_main(2,argv)==64);
    if (!setjmp(escaped)) (void)keeper_main(1,argv);
    assert(paused==1); puts("keeper: identity, argument refusal and pause-only loop passed"); return 0;
}
