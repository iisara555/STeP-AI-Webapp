CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
SOURCES = composition.c ../launch-lifecycle/lifecycle.c ../quota-broker/launch-request.c ../quota-broker/core.c
HEADERS = composition.h ../launch-lifecycle/lifecycle.h ../quota-broker/launch-request.h ../quota-broker/core.h
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=qbl_establish
# The reset fixture must never reach the production observer (test-reset-bus.c aborts).
RESET_WRAPS = -Wl,--wrap=lso_bus_snapshot -Wl,--wrap=lso_open
.DEFAULT_GOAL := all
.PHONY: all test analyze sanitize clean install install-check mutation pin-check pin-check-negative pin-check-phony
# Refuse any build that injects the observer test-hook macros.
ifneq ($(findstring LSO_,$(CC) $(CFLAGS) $(CPPFLAGS)),)
$(error REFUSED: LSO_ test macros in CC/CFLAGS/CPPFLAGS; the hook is only valid inside test-observer-deadline.c)
endif
# Deliberate review gate; never provide an installable composition by default.
install install-check:
	@echo 'REFUSED: synthetic composition only; trusted systemd incarnation backend and reviewed artifact pins required' >&2
	@exit 1
# No installed target or service linkage.
all: libstep-launch-composition.a libstep-systemd-observer.a libstep-create-reconcile.a
systemd-observer.o: systemd-observer.c systemd-observer.h $(HEADERS)
	$(CC) $(CFLAGS) -pthread -c $< -o $@
libstep-systemd-observer.a: systemd-observer.o
	$(AR) rcs $@ $<
create-reconcile.o: create-reconcile.c create-reconcile.h systemd-observer.h $(HEADERS)
	$(CC) $(CFLAGS) -pthread -c $< -o $@
libstep-create-reconcile.a: create-reconcile.o
	$(AR) rcs $@ $<
composition.o: composition.c $(HEADERS)
	$(CC) $(CFLAGS) -pthread -c composition.c -o $@
libstep-launch-composition.a: composition.o
	$(AR) rcs $@ $<
LIBS = libstep-launch-composition.a ../launch-lifecycle/libstep-lifecycle.a ../quota-broker/libstep-launch-request.a ../quota-broker/libstep-quota-core.a
../launch-lifecycle/libstep-lifecycle.a: ../launch-lifecycle/lifecycle.c ../launch-lifecycle/lifecycle.h
	$(MAKE) -C ../launch-lifecycle libstep-lifecycle.a
../quota-broker/libstep-launch-request.a: ../quota-broker/launch-request.c ../quota-broker/launch-request.h ../quota-broker/core.h
	$(MAKE) -C ../quota-broker libstep-launch-request.a
../quota-broker/libstep-quota-core.a: ../quota-broker/core.c ../quota-broker/core.h
	$(MAKE) -C ../quota-broker libstep-quota-core.a
test-composition: $(LIBS) $(HEADERS) test-composition.c ../quota-broker/test-core.c
	$(CC) $(CFLAGS) -pthread test-composition.c $(LIBS) $(WRAPS) -o $@
test-systemd-observer: test-systemd-observer.c test-composition.c systemd-observer.h libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread $< libstep-systemd-observer.a $(LIBS) $(WRAPS) -l:libsystemd.so.0 -o $@
test-observer-deadline: test-observer-deadline.c systemd-observer.c systemd-observer.h $(LIBS)
	$(CC) $(CFLAGS) -pthread $< $(LIBS) -l:libsystemd.so.0 -o $@
# The archive observer object must not carry the LSO_TESTING address/peer hook.
# pin-scan.sh fails closed: it refuses LTO objects (.gnu.lto_* bytecode hides
# static names), a missing/failing/silent readelf, nm or strings, an object
# without lso_bus_snapshot or the fixed bus address, and any lso_test_ name -
# each with its own reason.
pin-check: systemd-observer.o pin-scan.sh
	@sh ./pin-scan.sh systemd-observer.o
	@echo 'pin-check: systemd-observer.o has no test hook; system bus address and uid 0 pinned'
# Negative proof (see pin-negative.sh): bare -DLSO_TESTING stops at the exact
# #error, each scan arm alone refuses a hooked object (-g and -g0), LTO and
# tool failures refuse, make refuses LSO_ macros, make pin-check refuses.
pin-check-negative: systemd-observer.o systemd-observer.c systemd-observer.h pin-scan.sh pin-fake-tool.sh pin-negative.sh
	@CC='$(CC)' CFLAGS='$(CFLAGS)' MAKE='$(MAKE)' sh ./pin-negative.sh
# Both checks are phony: a stray file named pin-check/pin-check-negative must
# not let make skip them.
pin-check-phony: systemd-observer.o
	@rm -f pin-check pin-check-negative; touch pin-check pin-check-negative; \
	  out=$$($(MAKE) -s pin-check pin-check-negative 2>&1); s=$$?; rm -f pin-check pin-check-negative; \
	  case $$s:$$out in 0:*'pin-check: systemd-observer.o has no test hook'*'pin-check-negative: hooked, LTO and tool-failure observer builds refused'*) \
	    echo 'pin-check-phony: pin-check and pin-check-negative ran despite same-named files';; \
	  *) printf '%s\n' "$$out" >&2; echo 'FAIL: pin-check/pin-check-negative skipped or failed' >&2; exit 1;; esac
test-systemd-bus: test-systemd-bus.c systemd-observer.c systemd-observer.h $(LIBS)
	$(CC) $(CFLAGS) -pthread $< $(LIBS) -o $@
test-create-reconcile: test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread $< libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) -l:libsystemd.so.0 -o $@
test-reset-composition: test-reset-composition.c test-reset-bus.c test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h $(HEADERS) ../systemd-create/test-stop.c ../systemd-create/stop.c ../systemd-create/stop.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread test-reset-composition.c test-reset-bus.c libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) $(RESET_WRAPS) -o $@
test: test-composition test-systemd-observer test-systemd-bus test-create-reconcile test-reset-composition test-observer-deadline pin-check-phony
	./test-composition
	./test-systemd-observer
	./test-systemd-bus
	./test-create-reconcile
	./test-reset-composition
	./test-observer-deadline
analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-reset-composition.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-reset-bus.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c create-reconcile.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-create-reconcile.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-systemd-bus.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c systemd-observer.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c test-observer-deadline.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-systemd-observer.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c composition.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-composition.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) systemd-observer.c create-reconcile.c test-reset-composition.c test-reset-bus.c $(WRAPS) $(RESET_WRAPS) -o test-reset-sanitize
	./test-reset-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-composition.c $(WRAPS) -o test-sanitize
	./test-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) systemd-observer.c test-systemd-observer.c $(WRAPS) -l:libsystemd.so.0 -o test-observer-sanitize
	./test-observer-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-systemd-bus.c -o test-bus-sanitize
	./test-bus-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) systemd-observer.c create-reconcile.c test-create-reconcile.c $(WRAPS) -l:libsystemd.so.0 -o test-reconcile-sanitize
	./test-reconcile-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-observer-deadline.c -l:libsystemd.so.0 -o test-observer-deadline-sanitize
	./test-observer-deadline-sanitize
clean:
	rm -f test-reset-composition test-reset-sanitize *.o *.a test-composition test-sanitize test-systemd-observer test-observer-sanitize test-systemd-bus test-bus-sanitize test-create-reconcile test-reconcile-sanitize test-observer-deadline test-observer-deadline-sanitize pin-check pin-check-negative
# Delete each guarded check in a scratch copy (under $TMPDIR) and require its
# check to fail. Default check: the list entry's fixture binary; the pin list
# (pin-scan.sh, Makefile tripwire/.PHONY, hook marker/#error) runs
# make pin-check-phony, which runs pin-check and pin-check-negative.
MUTATION_LISTS = mutation/mutations.json mutation/reset-composition-mutations.json mutation/observer-deadline-mutations.json mutation/observer-pin-mutations.json
mutation:
	@set -eu; s=0; \
	  d=$$(mktemp -d "$${TMPDIR:?TMPDIR must name a private scratch directory}/lc-mutation.XXXXXX") || { echo 'mutation: NOT RUN (no scratch directory)' >&2; exit 1; }; \
	  expected=$$(python3 -c 'import json,sys; print(sum(1 for f in sys.argv[1:] for m in json.load(open(f)) if "after_find" in m))' $(MUTATION_LISTS)) || { rm -rf -- "$$d"; echo 'mutation: NOT RUN (unreadable list)' >&2; exit 1; }; \
	  for l in $(MUTATION_LISTS); do \
	    python3 mutation/run.py "$(CURDIR)/../.." after "$$l" "$$d/after.json" >> "$$d/log" || s=1; done; \
	  touch "$$d/log"; cat "$$d/log"; \
	  total=$$(wc -l < "$$d/log"); killed=$$(grep -c ' KILLED' "$$d/log" || true); rm -rf -- "$$d"; \
	  if [ "$$s" -ne 0 ] || [ "$$expected" -eq 0 ] || [ "$$total" -ne "$$expected" ] || [ "$$killed" -ne "$$expected" ]; then \
	    echo "mutation: FAILED ($$killed killed, $$total results, $$expected expected)" >&2; exit 1; fi; \
	  echo "mutation: all $$total killed"
