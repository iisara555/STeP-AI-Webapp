CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test sanitize analyze clean acceptance acceptance-check acceptance-dry-run acceptance-wrapper-test
all: libstep-quota-core.a libstep-quota-xfs.a libstep-quota-transport.a

transport.o: transport.c transport.h core.h
	$(CC) $(CFLAGS) -pthread -c transport.c -o $@

libstep-quota-transport.a: transport.o
	$(AR) rcs $@ $<

test-transport: core.c core.h transport.c transport.h test-transport.c
	$(CC) $(CFLAGS) -pthread core.c transport.c test-transport.c -o $@

core.o: core.c core.h
	$(CC) $(CFLAGS) -pthread -c core.c -o $@

libstep-quota-core.a: core.o
	$(AR) rcs $@ $<

xfs.o: xfs.c xfs.h core.h
	$(CC) $(CFLAGS) -c xfs.c -o $@

libstep-quota-xfs.a: xfs.o
	$(AR) rcs $@ $<

test: test-core test-xfs test-transport
	./test-core
	./test-xfs
	./test-transport

test-xfs: xfs.c xfs.h core.c core.h test-xfs.c
	$(CC) $(CFLAGS) -pthread -DQB_XFS_TESTING core.c xfs.c test-xfs.c -o $@

test-core: core.c core.h test-core.c
	$(CC) $(CFLAGS) -pthread core.c test-core.c -Wl,--wrap=fsync -o $@

# Owner-run privileged acceptance binary: real core + REAL xfs adapter. Built
# reproducibly (path-independent debug info) so its SHA-256 can be pinned in
# acceptance/run-xfs-acceptance.sh. Never run it from this user-writable tree as
# root; the owner installs a root-owned copy (docs/native-quota-xfs-acceptance.md).
ACCEPTANCE_CFLAGS = $(CFLAGS) -ffile-prefix-map=$(CURDIR)=. -DQB_XFS_PRIVILEGED_ACCEPTANCE=1
xfs-acceptance: core.c core.h xfs.c xfs.h xfs-acceptance.c
	$(CC) $(ACCEPTANCE_CFLAGS) -pthread core.c xfs.c xfs-acceptance.c -Wl,--build-id=sha1 -o $@

acceptance: xfs-acceptance

# Unprivileged: pinned hash in the wrapper must equal the built binary.
acceptance-check: xfs-acceptance
	@pinned=$$(sed -n 's/^readonly BIN_SHA256=\([0-9a-f]\{64\}\)$$/\1/p' acceptance/run-xfs-acceptance.sh); \
	actual=$$(sha256sum xfs-acceptance | cut -d' ' -f1); \
	echo "pinned=$$pinned"; echo "actual=$$actual"; test -n "$$pinned" && test "$$pinned" = "$$actual"

acceptance-dry-run:
	bash acceptance/run-xfs-acceptance.sh --dry-run

# Unprivileged lifecycle test of the wrapper with stubbed privileged tools.
acceptance-wrapper-test:
	bash acceptance/test-run-wrapper.sh

SAN_CFLAGS = -std=c11 -O1 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -fsanitize=address,undefined -fno-omit-frame-pointer
sanitize:
	$(MAKE) clean
	$(MAKE) test CFLAGS='$(SAN_CFLAGS)'
	# Acceptance binary: only its unprivileged refusal paths can run here.
	$(CC) $(SAN_CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -pthread core.c xfs.c xfs-acceptance.c -o xfs-acceptance-san
	./xfs-acceptance-san; test $$? -eq 2
	./xfs-acceptance-san --mount /nonexistent --writer-uid 995 --writer-gid 983; test $$? -eq 2
	rm -f xfs-acceptance-san

analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c transport.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c core.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_TESTING -fanalyzer -c xfs.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c xfs.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c xfs-acceptance.c -o /dev/null

clean:
	rm -f test-core test-xfs test-transport xfs-acceptance xfs-acceptance-san core.o xfs.o transport.o libstep-quota-core.a libstep-quota-xfs.a libstep-quota-transport.a
