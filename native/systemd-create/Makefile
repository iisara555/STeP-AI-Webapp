CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
# Tripwire: the LSC_TESTING hook is only valid inside test-create.c / test-stop.c
# (which #defines it); refuse any build that injects LSC_* macros.
ifneq ($(findstring LSC_,$(CC) $(CFLAGS) $(CPPFLAGS)),)
$(error REFUSED: LSC_ test macros in CC/CFLAGS/CPPFLAGS; the hook is only valid inside test-create.c and test-stop.c)
endif
.PHONY: all test analyze sanitize clean install install-check host-check pin-check pin-check-negative pin-check-phony mutation
all: libstep-systemd-create.a libstep-systemd-stop.a step-container-keeper test-link
create.o: create.c create.h ../launch-lifecycle/lifecycle.h
	$(CC) $(CFLAGS) -c $< -o $@
libstep-systemd-create.a: create.o
	$(AR) rcs $@ $<
stop.o: stop.c stop.h ../launch-lifecycle/lifecycle.h
	$(CC) $(CFLAGS) -c $< -o $@
libstep-systemd-stop.a: stop.o
	$(AR) rcs $@ $<
step-container-keeper: keeper.c
	$(CC) $(CFLAGS) $< -o $@
test-link: test-link.c create.o stop.o
	$(CC) $(CFLAGS) $^ -l:libsystemd.so.0 -o $@
test-create: test-create.c test-create.trace create.c create.h
	$(CC) $(CFLAGS) $< -o $@
test-stop: test-stop.c stop.c stop.h
	$(CC) $(CFLAGS) $< -o $@
test-deadline-create: test-deadline.c create.c create.h
	$(CC) $(CFLAGS) $< -l:libsystemd.so.0 -o $@
test-deadline-stop: test-deadline.c stop.c stop.h
	$(CC) $(CFLAGS) -DTEST_STOP $< -l:libsystemd.so.0 -o $@
test-keeper: test-keeper.c keeper.c
	$(CC) $(CFLAGS) $< -o $@
host-probe: host-probe.c create.c create.h
	$(CC) $(CFLAGS) $< -l:libsystemd.so.0 -o $@
host-probe-stop: host-probe-stop.c stop.c stop.h
	$(CC) $(CFLAGS) $< -l:libsystemd.so.0 -o $@
# The archive object must not carry the LSC_TESTING scratch-root hook.
# pin-scan.sh fails closed: it refuses LTO objects (.gnu.lto_* bytecode hides
# names from nm/strings), any nm/strings/readelf failure or empty output, and a
# hook name in the symbol table OR the raw bytes (-O2 folds the hook variables
# away; the hook also plants a `used` marker that survives).
pin-check: create.o stop.o pin-scan.sh
	@sh ./pin-scan.sh create.o
	@sh ./pin-scan.sh stop.o
	@echo 'pin-check: create.o has no test hook; keeper root "/" and uid 0 pinned'
	@echo 'pin-check: stop.o has no test hook; journal uid 0 pinned'
# Negative proof (see pin-negative.sh): bare -DLSC_TESTING stops at the #error,
# hooked objects (-g and -g0, each scan arm alone), LTO objects and failing or
# missing tools are refused, and make refuses LSC_ macros in CC/CFLAGS/CPPFLAGS.
pin-check-negative: create.o create.c create.h stop.o stop.c stop.h pin-scan.sh pin-fake-tool.sh pin-negative.sh
	@CC='$(CC)' CFLAGS='$(CFLAGS)' MAKE='$(MAKE)' sh ./pin-negative.sh
# Both checks are phony: a stray file named pin-check/pin-check-negative must
# not make them up to date (vacuous). Proven by running them with such files.
pin-check-phony: create.o stop.o
	@rm -f pin-check pin-check-negative; touch pin-check pin-check-negative; \
	  out=$$($(MAKE) -s pin-check pin-check-negative 2>&1); s=$$?; rm -f pin-check pin-check-negative; \
	  case $$s:$$out in 0:*'pin-check: create.o has no test hook'*'pin-check: stop.o has no test hook'*'pin-check-negative: hooked, LTO and tool-failure builds refused'*) \
	    echo 'pin-check-phony: pin-check and pin-check-negative ran despite same-named files';; \
	  *) printf '%s\n' "$$out" >&2; echo 'FAIL: pin-check/pin-check-negative skipped or failed' >&2; exit 1;; esac
test: test-create test-stop test-keeper test-link pin-check-phony test-deadline-create test-deadline-stop
	./test-create
	./test-stop
	./test-keeper
	./test-link
	./test-deadline-create
	./test-deadline-stop
# Read-only queries of the live system bus (Get/GetUnit/GetUnitByInvocationID/
# ListUnitsByPatterns/Introspect only; never Kill/Stop/StartTransientUnit).
host-check: host-probe host-probe-stop
	./host-probe
	./host-probe-stop
analyze:
	$(CC) $(CFLAGS) -fanalyzer -c create.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c keeper.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-create.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c stop.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-stop.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-keeper.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-deadline.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -DTEST_STOP -c test-deadline.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c host-probe.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c host-probe-stop.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-create.c -o test-sanitize
	./test-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-stop.c -o test-stop-sanitize
	./test-stop-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-keeper.c -o test-keeper-sanitize
	./test-keeper-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer test-deadline.c -l:libsystemd.so.0 -o test-deadline-create-sanitize
	./test-deadline-create-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -DTEST_STOP test-deadline.c -l:libsystemd.so.0 -o test-deadline-stop-sanitize
	./test-deadline-stop-sanitize
install install-check:
	@printf '%s\n' 'REFUSED: production unavailable; exclusive authority/recovery, stop-journal reconciliation and host acceptance of stop, credential transition, runtime composition, host acceptance of the hardened unit, review and artifact pins missing' >&2
	@exit 1
clean:
	rm -f test-deadline-create test-deadline-stop test-deadline-create-sanitize test-deadline-stop-sanitize *.o *.a step-container-keeper test-create test-keeper test-link test-sanitize test-keeper-sanitize test-stop test-stop-sanitize host-probe host-probe-stop pin-check pin-check-negative
# Delete each guarded check in a scratch copy and require its check to fail:
# mutations.json -> test-create; pin-mutations.json (pin-scan.sh, Makefile,
# hook marker/#error) -> make pin-check-phony (runs pin-check and the negatives).
MUTATION_LISTS = mutation/mutations.json mutation/pin-mutations.json mutation/stop-mutations.json mutation/reset-mutations.json mutation/deadline-mutations.json
mutation:
	@d=$$(mktemp -d) && s=0 && for l in $(MUTATION_LISTS); do \
	  python3 mutation/run.py $(CURDIR)/../.. after $$l $$d/after.json >> $$d/log || s=1; done; \
	  cat $$d/log; total=$$(wc -l < $$d/log); bad=$$(grep -cv ' KILLED' $$d/log); rm -rf $$d; \
	  if [ $$s -ne 0 ] || [ $$bad -ne 0 ]; then echo "mutation: $$bad of $$total not killed" >&2; exit 1; fi; \
	  echo "mutation: all $$total killed"
