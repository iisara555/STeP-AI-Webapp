CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
SOURCES = composition.c ../launch-lifecycle/lifecycle.c ../quota-broker/launch-request.c ../quota-broker/core.c
HEADERS = composition.h ../launch-lifecycle/lifecycle.h ../quota-broker/launch-request.h ../quota-broker/core.h
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=qbl_establish
.DEFAULT_GOAL := all
.PHONY: all test analyze sanitize clean install install-check mutation
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
test-systemd-bus: test-systemd-bus.c systemd-observer.c systemd-observer.h $(LIBS)
	$(CC) $(CFLAGS) -pthread $< $(LIBS) -o $@
test-create-reconcile: test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread $< libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) -l:libsystemd.so.0 -o $@
test-reset-composition: test-reset-composition.c test-reset-bus.c test-create-reconcile.c test-composition.c create-reconcile.h systemd-observer.h $(HEADERS) ../systemd-create/test-stop.c ../systemd-create/stop.c ../systemd-create/stop.h libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS)
	$(CC) $(CFLAGS) -pthread test-reset-composition.c test-reset-bus.c libstep-create-reconcile.a libstep-systemd-observer.a $(LIBS) $(WRAPS) -o $@
test: test-composition test-systemd-observer test-systemd-bus test-create-reconcile test-reset-composition
	./test-composition
	./test-systemd-observer
	./test-systemd-bus
	./test-create-reconcile
	./test-reset-composition
analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-reset-composition.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-reset-bus.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c create-reconcile.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-create-reconcile.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-systemd-bus.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c systemd-observer.c -o /dev/null
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
clean:
	rm -f test-reset-composition test-reset-sanitize *.o *.a test-composition test-sanitize test-systemd-observer test-observer-sanitize test-systemd-bus test-bus-sanitize test-create-reconcile test-reconcile-sanitize
# Delete each guarded check of create-reconcile.c in a scratch copy and
# require test-create-reconcile to fail.
MUTATION_LISTS = mutation/mutations.json mutation/reset-composition-mutations.json
mutation:
	@d=$$(mktemp -d) && s=0 && for l in $(MUTATION_LISTS); do \
	  python3 mutation/run.py $(CURDIR)/../.. after $$l $$d/after.json >> $$d/log || s=1; done; \
	  cat $$d/log; bad=$$(grep -cv ' KILLED' $$d/log); rm -rf $$d; \
	  if [ $$s -ne 0 ] || [ $$bad -ne 0 ]; then echo "mutation: $$bad not killed" >&2; exit 1; fi; echo 'mutation: all killed'
