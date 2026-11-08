CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test analyze sanitize clean install install-check host-check pin-check
all: libstep-systemd-create.a step-container-keeper test-link
create.o: create.c create.h ../launch-lifecycle/lifecycle.h
	$(CC) $(CFLAGS) -c $< -o $@
libstep-systemd-create.a: create.o
	$(AR) rcs $@ $<
step-container-keeper: keeper.c
	$(CC) $(CFLAGS) $< -o $@
test-link: test-link.c create.o
	$(CC) $(CFLAGS) $^ -l:libsystemd.so.0 -o $@
test-create: test-create.c test-create.trace create.c create.h
	$(CC) $(CFLAGS) $< -o $@
test-keeper: test-keeper.c keeper.c
	$(CC) $(CFLAGS) $< -o $@
host-probe: host-probe.c create.c create.h
	$(CC) $(CFLAGS) $< -l:libsystemd.so.0 -o $@
# The archive object must not carry the LSC_TESTING scratch-root hook.
pin-check: create.o
	@if nm create.o | grep -q 'lsc_test_'; then echo 'REFUSED: test hook in create.o' >&2; exit 1; fi
	@echo 'pin-check: create.o has no test hook; keeper root "/" and uid 0 pinned'
test: test-create test-keeper test-link pin-check
	./test-create
	./test-keeper
	./test-link
# Read-only queries of the live system bus (Get/GetUnit/Introspect only).
host-check: host-probe
	./host-probe
analyze:
	$(CC) $(CFLAGS) -fanalyzer -c create.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c keeper.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-create.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-keeper.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c host-probe.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-create.c -o test-sanitize
	./test-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-keeper.c -o test-keeper-sanitize
	./test-keeper-sanitize
install install-check:
	@printf '%s\n' 'REFUSED: production unavailable; exclusive authority/recovery, stop, credential transition, runtime composition, host acceptance of the hardened unit, review and artifact pins missing' >&2
	@exit 1
clean:
	rm -f *.o *.a step-container-keeper test-create test-keeper test-link test-sanitize test-keeper-sanitize host-probe
