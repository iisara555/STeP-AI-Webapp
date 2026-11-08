CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test analyze sanitize clean
all: libstep-lifecycle.a
lifecycle.o: lifecycle.c lifecycle.h
	$(CC) $(CFLAGS) -pthread -c lifecycle.c -o $@
libstep-lifecycle.a: lifecycle.o
	$(AR) rcs $@ $<
test-lifecycle: lifecycle.c lifecycle.h test-lifecycle.c
	$(CC) $(CFLAGS) -pthread lifecycle.c test-lifecycle.c -o $@
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=pwrite
test-recovery: lifecycle.c lifecycle.h test-recovery.c
	$(CC) $(CFLAGS) -pthread lifecycle.c test-recovery.c $(WRAPS) -o $@
test: test-lifecycle test-recovery
	./test-lifecycle
	./test-recovery
analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c lifecycle.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-lifecycle.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-recovery.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread lifecycle.c test-lifecycle.c -o test-sanitize
	./test-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread lifecycle.c test-recovery.c $(WRAPS) -o test-recovery-sanitize
	./test-recovery-sanitize
clean:
	rm -f *.o *.a test-lifecycle test-recovery test-sanitize test-recovery-sanitize
