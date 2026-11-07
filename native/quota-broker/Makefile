CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test sanitize analyze clean
all: libstep-quota-core.a libstep-quota-xfs.a

core.o: core.c core.h
	$(CC) $(CFLAGS) -pthread -c core.c -o $@

libstep-quota-core.a: core.o
	$(AR) rcs $@ $<

xfs.o: xfs.c xfs.h core.h
	$(CC) $(CFLAGS) -c xfs.c -o $@

libstep-quota-xfs.a: xfs.o
	$(AR) rcs $@ $<

test: test-core test-xfs
	./test-core
	./test-xfs

test-xfs: xfs.c xfs.h core.c core.h test-xfs.c
	$(CC) $(CFLAGS) -pthread -DQB_XFS_TESTING core.c xfs.c test-xfs.c -o $@

test-core: core.c core.h test-core.c
	$(CC) $(CFLAGS) -pthread core.c test-core.c -Wl,--wrap=fsync -o $@

sanitize:
	$(MAKE) clean
	$(MAKE) test CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -fsanitize=address,undefined -fno-omit-frame-pointer'

analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c core.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_TESTING -fanalyzer -c xfs.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c xfs.c -o /dev/null

clean:
	rm -f test-core test-xfs core.o xfs.o libstep-quota-core.a libstep-quota-xfs.a
