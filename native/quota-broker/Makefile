CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: custody-mutation custody-test custody-production-check acceptance-sql-test all test sanitize analyze clean acceptance acceptance-check acceptance-dry-run acceptance-wrapper-test service service-check service-dry-run service-script-test service-verify
all: libstep-launch-request.a libstep-quota-core.a libstep-quota-xfs.a libstep-quota-transport.a step-quota-broker step-quota-broker-fake

# Installable service binary: real core + REAL xfs adapter + transport + policy loader, fixed
# paths, euid 0 only. Reproducible (path-independent) so service/install-quota-broker.sh pins its
# SHA-256. Never run it as root from this user-writable tree; the owner installs root-owned copies.
SERVICE_CFLAGS = $(CFLAGS) -ffile-prefix-map=$(CURDIR)=. -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fPIE
SERVICE_SOURCES = core.c xfs.c transport.c policy.c broker-main.c
step-quota-broker: $(SERVICE_SOURCES) core.h xfs.h transport.h policy.h
	$(CC) $(SERVICE_CFLAGS) -pthread $(SERVICE_SOURCES) -pie -Wl,-z,relro,-z,now -Wl,--build-id=sha1 -o $@

service: step-quota-broker

service-verify: step-quota-broker
	bash service/verify-unit.sh ./step-quota-broker

# FAKE-adapter TESTING build of the same main: refuses root, directories as arguments, no
# quota/attribute syscalls. Used by test-broker and the TypeScript socket-client tests.
step-quota-broker-fake: core.c transport.c policy.c broker-main.c core.h transport.h policy.h
	$(CC) $(CFLAGS) -pthread -DQB_BROKER_TESTING core.c transport.c policy.c broker-main.c -Wl,--wrap=fstatvfs -o $@

custody-mutation:
	python3 mutation-custody.py

custody-test: step-quota-broker-fake
	python3 test-custody.py ./step-quota-broker-fake

# Check an actual production object, independently of the fake executable.
# Fail closed if inspection tools fail. No unit/installer repinning here.
custody-production-check:
	@set -eu; d=$$(mktemp -d "$${TMPDIR:?}/qb-production-XXXXXX"); trap 'rm -rf "$$d"' EXIT; \
	$(CC) $(SERVICE_CFLAGS) -c broker-main.c -o "$$d/main.o"; \
	nm "$$d/main.o" > "$$d/nm"; strings -a "$$d/main.o" > "$$d/strings"; \
	python3 check-custody-production.py "$$d/nm" "$$d/strings"; \
	$(CC) $(CFLAGS) -g0 -DQB_BROKER_TESTING -c broker-main.c -o "$$d/fake.o"; \
	nm "$$d/fake.o" > "$$d/nm"; strings -a "$$d/fake.o" > "$$d/strings"; \
	if python3 check-custody-production.py "$$d/nm" "$$d/strings" > "$$d/refused" 2>&1; then exit 1; fi; \
	python3 -c 'import pathlib,sys; assert "test seam in production" in pathlib.Path(sys.argv[1]).read_text()' "$$d/refused"

test-policy: policy.c policy.h core.h test-policy.c
	$(CC) $(CFLAGS) policy.c test-policy.c -o $@

test-broker: test-broker.c step-quota-broker-fake
	$(CC) $(CFLAGS) test-broker.c -o $@

# Unprivileged: pinned hashes in the install script must equal the built artifacts.
service-check: step-quota-broker
	@pinned=$$(sed -n 's/^readonly BIN_SHA256=\([0-9a-f]\{64\}\)$$/\1/p' service/install-quota-broker.sh); \
	actual=$$(sha256sum step-quota-broker | cut -d' ' -f1); \
	unit_pinned=$$(sed -n 's/^readonly UNIT_SHA256=\([0-9a-f]\{64\}\)$$/\1/p' service/install-quota-broker.sh); \
	unit_actual=$$(sha256sum service/step-quota-broker.service | cut -d' ' -f1); \
	echo "binary pinned=$$pinned actual=$$actual"; echo "unit   pinned=$$unit_pinned actual=$$unit_actual"; \
	test -n "$$pinned" && test "$$pinned" = "$$actual" && test "$$unit_pinned" = "$$unit_actual"

service-dry-run:
	bash service/install-quota-broker.sh --dry-run --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 0 --user 12345678-1234-4234-8234-000000000000

service-script-test:
	bash service/test-install-script.sh

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

test: custody-test custody-production-check test-launch-request test-launch test-core test-capacity-race test-xfs test-transport test-policy test-broker acceptance-sql-test
	./test-launch-request
	./test-launch
	./test-core
	./test-capacity-race
	./test-xfs
	./test-transport
	./test-policy
	./test-broker ./step-quota-broker-fake

test-xfs: xfs.c xfs.h core.c core.h test-xfs.c
	$(CC) $(CFLAGS) -pthread -DQB_XFS_TESTING core.c xfs.c test-xfs.c -o $@

test-capacity-race: core.c core.h test-core.c test-capacity-race.c
	$(CC) $(CFLAGS) -pthread core.c test-capacity-race.c -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -o $@

launch-request.o: launch-request.c launch-request.h core.h
	$(CC) $(CFLAGS) -pthread -c launch-request.c -o $@

libstep-launch-request.a: launch-request.o
	$(AR) rcs $@ $<

test-launch-request: core.c core.h test-core.c launch-request.c launch-request.h test-launch-request.c
	$(CC) $(CFLAGS) -pthread core.c launch-request.c test-launch-request.c -Wl,--wrap=clock_gettime -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=pthread_mutex_lock -o $@

test-launch: core.c core.h test-core.c test-launch.c
	$(CC) $(CFLAGS) -pthread core.c test-launch.c -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -Wl,--wrap=pthread_mutex_lock -o $@

test-core: core.c core.h test-core.c
	$(CC) $(CFLAGS) -pthread core.c test-core.c -Wl,--wrap=fsync -Wl,--wrap=fstatvfs -o $@

# Owner-run privileged acceptance binary: real core + REAL xfs adapter. Built
# reproducibly (path-independent debug info) so its SHA-256 can be pinned in
# acceptance/run-xfs-acceptance.sh. Never run it from this user-writable tree as
# root; the owner installs a root-owned copy (docs/native-quota-xfs-acceptance.md).
ACCEPTANCE_CFLAGS = $(CFLAGS) -ffile-prefix-map=$(CURDIR)=. -DQB_XFS_PRIVILEGED_ACCEPTANCE=1
# The full-pool history check runs SQLite (the engine Store's WAL mode) in the writer child:
# linked against the host runtime library libsqlite3.so.0 (no -dev header on this host; the
# few declarations used are in acceptance/sqlite3-min.h).
ACCEPTANCE_LIBS = -l:libsqlite3.so.0
xfs-acceptance: core.c core.h xfs.c xfs.h xfs-acceptance.c acceptance/sqlite3-min.h
	$(CC) $(ACCEPTANCE_CFLAGS) -pthread core.c xfs.c xfs-acceptance.c -Wl,--build-id=sha1 $(ACCEPTANCE_LIBS) -o $@

acceptance: xfs-acceptance

# Unprivileged self-test of the acceptance's writer-side SQLite code (same source, other main).
acceptance-sql-test: core.c core.h xfs.c xfs.h xfs-acceptance.c acceptance/sqlite3-min.h
	$(CC) $(CFLAGS) -Wno-unused-function -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -DQB_ACCEPTANCE_SQL_SELFTEST -pthread core.c xfs.c xfs-acceptance.c $(ACCEPTANCE_LIBS) -o test-acceptance-sql
	d=$$(mktemp -d "$${TMPDIR:-/tmp}/qb-sql-XXXXXX") && ./test-acceptance-sql "$$d"; rc=$$?; rm -rf "$$d"; exit $$rc

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
	$(CC) $(SAN_CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -pthread core.c xfs.c xfs-acceptance.c $(ACCEPTANCE_LIBS) -o xfs-acceptance-san
	./xfs-acceptance-san; test $$? -eq 2
	./xfs-acceptance-san --mount /nonexistent --writer-uid 995 --writer-gid 983; test $$? -eq 2
	rm -f xfs-acceptance-san
	# Service binary: only its unprivileged refusal paths can run here.
	$(CC) $(SAN_CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -pthread $(SERVICE_SOURCES) -o step-quota-broker-san
	./step-quota-broker-san --serve; test $$? -eq 2
	./step-quota-broker-san; test $$? -eq 2
	rm -f step-quota-broker-san

analyze:
	$(CC) $(CFLAGS) -pthread -fanalyzer -c launch-request.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c transport.c -o /dev/null
	$(CC) $(CFLAGS) -pthread -fanalyzer -c core.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_TESTING -fanalyzer -c xfs.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c xfs.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c xfs-acceptance.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c policy.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_XFS_PRIVILEGED_ACCEPTANCE=1 -fanalyzer -c broker-main.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_BROKER_TESTING -fanalyzer -c broker-main.c -o /dev/null
	$(CC) $(CFLAGS) -DQB_BROKER_TESTING -fanalyzer -c policy.c -o /dev/null

clean:
	rm -f launch-request.o libstep-launch-request.a test-launch-request test-launch test-capacity-race test-acceptance-sql test-core test-xfs test-transport test-policy test-broker step-quota-broker step-quota-broker-fake step-quota-broker-san xfs-acceptance xfs-acceptance-san core.o xfs.o transport.o libstep-quota-core.a libstep-quota-xfs.a libstep-quota-transport.a
