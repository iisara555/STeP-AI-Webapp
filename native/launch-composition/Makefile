CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
SOURCES = composition.c ../launch-lifecycle/lifecycle.c ../quota-broker/launch-request.c ../quota-broker/core.c
HEADERS = composition.h ../launch-lifecycle/lifecycle.h ../quota-broker/launch-request.h ../quota-broker/core.h
WRAPS = -Wl,--wrap=fsync -Wl,--wrap=fstatvfs
.DEFAULT_GOAL := all
.PHONY: all test analyze sanitize clean install install-check
# Deliberate review gate; never provide an installable composition by default.
install install-check:
	@echo 'REFUSED: synthetic composition only; trusted systemd incarnation backend and reviewed artifact pins required' >&2
	@exit 1
# No installed target or service linkage.
all: libstep-launch-composition.a
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
test: test-composition
	./test-composition
analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c composition.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c test-composition.c -o /dev/null
sanitize:
	$(CC) $(CFLAGS) -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -pthread $(SOURCES) test-composition.c $(WRAPS) -o test-sanitize
	./test-sanitize
clean:
	rm -f *.o *.a test-composition test-sanitize
