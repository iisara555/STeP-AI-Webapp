CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
SOURCES = composition.c ../launch-lifecycle/lifecycle.c ../quota-broker/launch-request.c ../quota-broker/core.c
HEADERS = composition.h ../launch-lifecycle/lifecycle.h ../quota-broker/launch-request.h ../quota-broker/core.h
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=qbl_establish
.DEFAULT_GOAL := all
.PHONY: all test analyze sanitize clean install install-check
# Deliberate review gate; never provide an installable composition by default.
install install-check:
	@echo 'REFUSED: synthetic composition only; trusted systemd incarnation backend and reviewed artifact pins required' >&2
	@exit 1
# No installed target or service linkage.
all: libstep-launch-composition.a libstep-systemd-observer.a
systemd-observer.o: systemd-observer.c systemd-observer.h $(HEADERS)
	$(CC) $(CFLAGS) -pthread -c $< -o $@
libstep-systemd-observer.a: systemd-observer.o
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
test: test-composition test-systemd-observer test-systemd-bus
	./test-composition
	./test-systemd-observer
	./test-systemd-bus
analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-systemd-bus.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c systemd-observer.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-systemd-observer.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c composition.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-composition.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-composition.c $(WRAPS) -o test-sanitize
	./test-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) systemd-observer.c test-systemd-observer.c $(WRAPS) -l:libsystemd.so.0 -o test-observer-sanitize
	./test-observer-sanitize
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-systemd-bus.c -o test-bus-sanitize
	./test-bus-sanitize
clean:
	rm -f *.o *.a test-composition test-sanitize test-systemd-observer test-observer-sanitize test-systemd-bus test-bus-sanitize
