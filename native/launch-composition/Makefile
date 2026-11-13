CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
SOURCES = composition.c ../launch-lifecycle/lifecycle.c ../quota-broker/launch-request.c ../quota-broker/core.c
HEADERS = composition.h ../launch-lifecycle/lifecycle.h ../quota-broker/launch-request.h ../quota-broker/core.h
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=qbl_establish
.DEFAULT_GOAL := all
.PHONY: all test analyze sanitize clean install install-check mutation pin-check pin-check-negative
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
# Fails closed: tool failure, missing expected symbol/string, LTO, or hook name.
PIN_OBJ ?= systemd-observer.o
pin-check: $(PIN_OBJ)
	@sec=$$(readelf -W -S $(PIN_OBJ) 2>&1) || { echo "REFUSED: readelf failed" >&2; exit 1; }; \
	 case "$$sec" in *" .text "*) ;; *) echo "REFUSED: no .text" >&2; exit 1;; esac; \
	 case "$$sec" in *.gnu.lto_*) echo "REFUSED: LTO object" >&2; exit 1;; esac; \
	 sym=$$(nm -a $(PIN_OBJ) 2>&1) || { echo "REFUSED: nm failed" >&2; exit 1; }; \
	 case "$$sym" in *" T lso_bus_snapshot"*) ;; *) echo "REFUSED: nm lacks lso_bus_snapshot" >&2; exit 1;; esac; \
	 str=$$(strings -a $(PIN_OBJ) 2>&1) || { echo "REFUSED: strings failed" >&2; exit 1; }; \
	 case "$$str" in *system_bus_socket*) ;; *) echo "REFUSED: strings lacks bus address" >&2; exit 1;; esac; \
	 case "$$sym" in *lso_test_*) echo "REFUSED: observer test hook symbol in $(PIN_OBJ)" >&2; exit 1;; esac; \
	 case "$$str" in *lso_test_*) echo "REFUSED: observer test hook bytes in $(PIN_OBJ)" >&2; exit 1;; esac
	@echo "pin-check: $(PIN_OBJ) has no test hook; system bus address and uid 0 pinned"
# Negative proof: bare -DLSO_TESTING stops at the #error (exact text), and a
# hooked object built as the fixture enables it (-g and -g0) is refused.
pin-check-negative: systemd-observer.c systemd-observer.h
	@if $(CC) $(CFLAGS) -DLSO_TESTING -c systemd-observer.c -o pin-neg-a.o 2>pin-neg-a.err; then rm -f pin-neg-a.o pin-neg-a.err; echo "FAIL: LSO_TESTING compiled outside the fixture" >&2; exit 1; fi; \
	 grep -q "LSO_TESTING is only valid" pin-neg-a.err || { cat pin-neg-a.err >&2; rm -f pin-neg-a.err; echo "FAIL: wrong refusal" >&2; exit 1; }; rm -f pin-neg-a.err
	@for g in -g -g0; do \
	  $(CC) $(CFLAGS) $$g -DLSO_TESTING -DLSO_FIXTURE_INCLUDE -c systemd-observer.c -o pin-neg-b.o || exit 1; \
	  if $(MAKE) -s pin-check PIN_OBJ=pin-neg-b.o >/dev/null 2>pin-neg-b.err; then rm -f pin-neg-b.o pin-neg-b.err; echo "FAIL: hooked object ($$g) passed pin-check" >&2; exit 1; fi; \
	  grep -q "observer test hook" pin-neg-b.err || { cat pin-neg-b.err >&2; rm -f pin-neg-b.o pin-neg-b.err; echo "FAIL: wrong pin refusal ($$g)" >&2; exit 1; }; \
	  rm -f pin-neg-b.o pin-neg-b.err; done
	@echo "pin-check-negative: hooked observer builds refused at -g and -g0"
test-systemd-bus: test-systemd-bus.c systemd-observer.c systemd-observer.h $(LIBS)
	$(CC) $(CFLAGS) -pthread $< $(LIBS) -o $@
test-create-reconcile: test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread $< libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) -l:libsystemd.so.0 -o $@
test-reset-composition: test-reset-composition.c test-reset-bus.c test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h $(HEADERS) ../systemd-create/test-stop.c ../systemd-create/stop.c ../systemd-create/stop.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread test-reset-composition.c test-reset-bus.c libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) -o $@
test: test-composition test-systemd-observer test-systemd-bus test-create-reconcile test-reset-composition test-observer-deadline pin-check pin-check-negative
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
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) systemd-observer.c create-reconcile.c test-reset-composition.c test-reset-bus.c $(WRAPS) -o test-reset-sanitize
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
	rm -f test-reset-composition test-reset-sanitize *.o *.a test-composition test-sanitize test-systemd-observer test-observer-sanitize test-systemd-bus test-bus-sanitize test-create-reconcile test-reconcile-sanitize test-observer-deadline test-observer-deadline-sanitize pin-neg-a.o pin-neg-a.err pin-neg-b.o pin-neg-b.err
# Delete each guarded check of create-reconcile.c in a scratch copy and
# require test-create-reconcile to fail.
MUTATION_LISTS = mutation/mutations.json mutation/reset-composition-mutations.json mutation/observer-deadline-mutations.json
mutation:
	@d=$$(mktemp -d) && s=0 && for l in $(MUTATION_LISTS); do \
	  python3 mutation/run.py $(CURDIR)/../.. after $$l $$d/after.json >> $$d/log || s=1; done; \
	  cat $$d/log; bad=$$(grep -cv ' KILLED' $$d/log); rm -rf $$d; \
	  if [ $$s -ne 0 ] || [ $$bad -ne 0 ]; then echo "mutation: $$bad not killed" >&2; exit 1; fi; echo 'mutation: all killed'
