/* TESTING ONLY: stands in for /usr/bin/bwrap and reports what it received on fd 2. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static void link_of(int fd) {
    char path[64], got[4096];
    snprintf(path, sizeof path, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(path, got, sizeof got - 1);
    if (n < 0) n = 0;
    got[n] = 0;
    fprintf(stderr, "fd%d=%s\n", fd, got);
}

int main(int argc, char **argv) {
    int envc = 0;
    for (char **e = environ; e && *e; e++) envc++;
    fprintf(stderr, "envc=%d\n", envc);
    for (int i = 1; i < argc; i++) fprintf(stderr, "arg=%s\n", argv[i]);
    link_of(1);
    link_of(3);
    int extra = 0;
    for (int fd = 4; fd < 1024; fd++)
        if (fcntl(fd, F_GETFD) >= 0) extra++;
    fprintf(stderr, "extra_fds=%d\n", extra);
    fputs("stdin=", stderr);
    unsigned char buf[4096];
    ssize_t n;
    while ((n = read(0, buf, sizeof buf)) > 0)
        for (ssize_t i = 0; i < n; i++) fprintf(stderr, "%02x", buf[i]);
    fputs("\n", stderr);
    return 0;
}
