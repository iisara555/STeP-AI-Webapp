CC ?= cc
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -D_FORTIFY_SOURCE=3 -fstack-protector-strong
.PHONY: all test sanitize analyze clean install-check install-dry-run install-script-test sudoers-check
all: launch launch-testing fake-bwrap test-launcher

# Installed launcher: fixed configuration, no environment input. Reproducible (path-independent)
# so install/install-runner-launcher.sh pins its SHA-256. Never run it from this user-writable
# tree as root; the owner installs a root-owned copy (docs/step-runner-launcher.md).
LAUNCH_CFLAGS = $(CFLAGS) -ffile-prefix-map=$(CURDIR)=. -fPIE
launch: launcher.c launch-main.c launcher.h
	$(CC) $(LAUNCH_CFLAGS) launcher.c launch-main.c -pie -Wl,-z,relro,-z,now -Wl,--build-id=sha1 -o $@
	@# The installed build must never consult the environment.
	@! nm -D $@ | grep -Ew 'getenv|secure_getenv' || { echo "launch must not read the environment" >&2; rm -f $@; exit 1; }

# TESTING build: scratch-prefixed paths from SRL_TEST_ROOT, caller's uid as every principal;
# refuses root and uid 995. Never installed.
launch-testing: launcher.c launch-main.c testing-config.c launcher.h testing-config.h
	$(CC) $(CFLAGS) -DSRL_TESTING launcher.c launch-main.c testing-config.c -o $@

fake-bwrap: fake-bwrap.c
	$(CC) $(CFLAGS) fake-bwrap.c -o $@

test-launcher: test-launcher.c launcher.c testing-config.c launcher.h testing-config.h
	$(CC) $(CFLAGS) test-launcher.c launcher.c testing-config.c -o $@

test: test-launcher launch-testing fake-bwrap launch
	./test-launcher ./launch-testing ./fake-bwrap
	@# The production build refuses outside the runner account (no fds/paths touched).
	./launch v1 p100000/0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1f 00112233445566778899aabbccddeeff 65536 </dev/null; test $$? -eq 2
	./launch-testing; test $$? -eq 2

SAN_CFLAGS = -std=c11 -O1 -g -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -fsanitize=address,undefined -fno-omit-frame-pointer
sanitize:
	$(MAKE) clean
	$(MAKE) test-launcher launch-testing fake-bwrap CFLAGS='$(SAN_CFLAGS)'
	ASAN_OPTIONS=detect_leaks=1 ./test-launcher ./launch-testing ./fake-bwrap
	$(CC) $(SAN_CFLAGS) launcher.c launch-main.c -o launch-san
	./launch-san; test $$? -eq 2
	./launch-san v1 p100000/0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1f 00112233445566778899aabbccddeeff 65536 </dev/null; test $$? -eq 2
	rm -f launch-san
	$(MAKE) clean

analyze:
	$(CC) $(CFLAGS) -fanalyzer -c launcher.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c launch-main.c -o /dev/null
	$(CC) $(CFLAGS) -DSRL_TESTING -fanalyzer -c launch-main.c -o /dev/null
	$(CC) $(CFLAGS) -fanalyzer -c testing-config.c -o /dev/null

# Unprivileged: the pins in the installer must equal the built launcher and the sudoers fragment.
install-check: launch
	@pinned=$$(sed -n 's/^readonly LAUNCH_SHA256=\([0-9a-f]\{64\}\)$$/\1/p' install/install-runner-launcher.sh); \
	actual=$$(sha256sum launch | cut -d' ' -f1); \
	s_pinned=$$(sed -n 's/^readonly SUDOERS_SHA256=\([0-9a-f]\{64\}\)$$/\1/p' install/install-runner-launcher.sh); \
	s_actual=$$(sha256sum install/sudoers-step-runner-launch | cut -d' ' -f1); \
	echo "launch  pinned=$$pinned actual=$$actual"; echo "sudoers pinned=$$s_pinned actual=$$s_actual"; \
	test -n "$$pinned" && test "$$pinned" = "$$actual" && test "$$s_pinned" = "$$s_actual"

# Parses the sudoers fragment with the host's visudo (sudo-rs) on a scratch copy; no root.
sudoers-check:
	@tmp=$$(mktemp "$${TMPDIR:-/tmp}/sudoers-check.XXXXXX"); cp install/sudoers-step-runner-launch "$$tmp"; \
	visudo -c -f "$$tmp"; rc=$$?; rm -f "$$tmp"; exit $$rc

install-dry-run:
	bash install/install-runner-launcher.sh --dry-run

install-script-test:
	bash install/test-install-script.sh

clean:
	rm -f launch launch-testing launch-san fake-bwrap test-launcher
