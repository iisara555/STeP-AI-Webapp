CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test analyze sanitize clean install install-check host-check pin-check mutation
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
# Checks both the symbol table and raw bytes, because -O2 can fold the hook
# variables away; the hook also plants a `used` marker that survives.
PIN_REFUSE = nm $(1) | grep -q 'lsc_test_' || strings -a $(1) | grep -q 'lsc_test_'
pin-check: create.o
	@if $(call PIN_REFUSE,create.o); then echo 'REFUSED: test hook in create.o' >&2; exit 1; fi
	@echo 'pin-check: create.o has no test hook; keeper root "/" and uid 0 pinned'
# Negative proof: (a) -DLSC_TESTING alone must not compile; (b) an object built
# with the hook the way the fixture enables it must be refused by the same check.
pin-check-negative: create.c create.h
	@if $(CC) $(CFLAGS) -DLSC_TESTING -c create.c -o pin-neg-a.o 2>/dev/null; then rm -f pin-neg-a.o; echo 'FAIL: LSC_TESTING compiled outside the fixture' >&2; exit 1; fi
	@$(CC) $(CFLAGS) -DLSC_TESTING -DLSC_FIXTURE_INCLUDE -c create.c -o pin-neg-b.o
	@if $(call PIN_REFUSE,pin-neg-b.o); then rm -f pin-neg-b.o; echo 'pin-check-negative: hooked builds refused'; else rm -f pin-neg-b.o; echo 'FAIL: hooked object passed pin-check' >&2; exit 1; fi
test: test-create test-keeper test-link pin-check pin-check-negative
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
# Delete each guarded check in a scratch copy and require test-create to fail.
mutation:
	@d=$$(mktemp -d) && python3 mutation/run.py $(CURDIR)/../.. after mutation/mutations.json $$d/after.json > $$d/log; \
	  s=$$?; cat $$d/log; bad=$$(grep -cv ' KILLED' $$d/log); rm -rf $$d; \
	  if [ $$s -ne 0 ] || [ $$bad -ne 0 ]; then echo "mutation: $$bad not killed" >&2; exit 1; fi; echo 'mutation: all killed'
