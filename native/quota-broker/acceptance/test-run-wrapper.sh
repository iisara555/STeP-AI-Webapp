#!/bin/bash
# Unprivileged lifecycle test of run-xfs-acceptance.sh. NEVER needs or uses root:
# it runs a derived copy as the invoking user with id/stat/install (root identity),
# mkfs.xfs/losetup/mount/umount/mountpoint/findmnt replaced by recording stubs and
# a stub "binary" pinned by SHA-256. (Ubuntu's AppArmor userns restriction forbids
# an unprivileged uid_map, so a fake-root user namespace is not used.) It proves the EXIT trap
# always unmounts, detaches and removes the temp dir and publishes a 0644 log, on
# pass, fail, hash mismatch and SIGTERM. Ownership/ancestor trust checks are
# stubbed out here (they are exercised by --dry-run and the real owner run).
# shellcheck disable=SC2016  # stub bodies are intentionally unexpanded
set -euo pipefail
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
src=$here/run-xfs-acceptance.sh
[[ $(id -u) != 0 ]] || { echo "refusing to run as root" >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/wrapper-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/stub" "$work/install" "$work/tmp"
calls=$work/calls state=$work/state
mkdir "$state"

stub() { printf '#!/bin/bash\n%s\n' "$2" >"$work/stub/$1"; chmod 0755 "$work/stub/$1"; }
stub mkfs.xfs 'echo "mkfs.xfs $*" >>'"$calls"'; [[ $1 == -V ]] && echo "mkfs.xfs version stub"; exit 0'
stub losetup 'echo "losetup $*" >>'"$calls"'
case $1 in
--version) echo "losetup stub";;
--find) touch '"$state"'/loop; echo /dev/loop99;;
-j) [[ -e '"$state"'/loop ]] && echo /dev/loop99; exit 0;;
-d) rm -f '"$state"'/loop;;
esac'
stub mount 'echo "mount $*" >>'"$calls"'; touch '"$state"'/mounted'
stub umount 'echo "umount $*" >>'"$calls"'; rm -f '"$state"'/mounted'
stub mountpoint '[[ -e '"$state"'/mounted ]]'
stub findmnt 'echo "/dev/loop99 $5 xfs rw,pquota"'
stub id '[[ $1 == -u ]] && { echo 0; exit 0; }; exec /usr/bin/id "$@"'
stub stat 'if [[ $2 == "%u:%g %a" ]]; then echo "0:0 $(/usr/bin/stat -c %a -- "$4")"; else exec /usr/bin/stat "$@"; fi'
stub install 'a=(); while (($#)); do case $1 in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; exec /usr/bin/install "${a[@]}"'

make_case() { # $1 = binary body
    printf '#!/bin/bash\n%s\n' "$1" >"$work/install/xfs-acceptance"
    chmod 0755 "$work/install/xfs-acceptance"
    local sum
    sum=$(sha256sum "$work/install/xfs-acceptance" | cut -d' ' -f1)
    [[ ${2:-} == mismatch ]] && sum=$(printf '%064d' 1)
    sed -e "s|^readonly BIN_SHA256=.*|readonly BIN_SHA256=$sum|" \
        -e "s|^readonly INSTALL_DIR=.*|readonly INSTALL_DIR=$work/install|" \
        -e "s|^readonly LOG=.*|readonly LOG=$work/acceptance.log|" \
        -e "s|^readonly TMP_PARENT=.*|readonly TMP_PARENT=$work/tmp|" \
        -e "s|^export PATH=.*|export PATH=$work/stub:/usr/sbin:/usr/bin:/sbin:/bin|" \
        -e "s|^readonly WRITER_NAME=.*|readonly WRITER_NAME=$(id -un) WRITER_UID=$(id -u) WRITER_GID=$(id -g)|" \
        -e 's|^trusted_chain() {$|trusted_chain() { return 0; }\ntrusted_chain_real() {|' \
        "$src" >"$work/install/run"
    chmod 0755 "$work/install/run"
    : >"$calls"; rm -f "$state"/* "$work/acceptance.log"
}
fails=0
expect() { # name expected_rc actual_rc
    local ok=1
    [[ $2 == "$3" ]] || ok=0
    [[ ! -e $state/mounted && ! -e $state/loop ]] || ok=0
    [[ -z $(ls -A "$work/tmp") ]] || ok=0
    [[ -f $work/acceptance.log && $(stat -c %a "$work/acceptance.log") == 644 ]] || ok=0
    if (( ok )); then echo "ok - $1 (rc=$3, unmounted, detached, temp removed, log 0644)"
    else echo "not ok - $1 (rc=$3 expected $2; mounted=$([[ -e $state/mounted ]] && echo y) loop=$([[ -e $state/loop ]] && echo y) tmp=$(ls -A "$work/tmp"))"; fails=1; fi
}
run() { "$work/install/run" >"$work/out" 2>&1; }

make_case 'echo "PASS stub: $*"; echo "RESULT: PASS"; exit 0'
set +e; run; rc=$?; set -e
expect "passing binary" 0 "$rc"
grep -q -- "--mount $work/tmp/step-xfs-acceptance\.[A-Za-z0-9]*/mnt --writer-uid" "$work/acceptance.log" ||
    { echo "not ok - binary argv not logged"; fails=1; }
grep -q '^mount -t xfs -o pquota,nodev,nosuid,noexec /dev/loop99 ' "$calls" || { echo "not ok - mount argv"; fails=1; }

make_case 'echo "FAIL stub"; exit 1'
set +e; run; rc=$?; set -e
expect "failing binary" 1 "$rc"

make_case 'echo never-run; exit 0' mismatch
set +e; run; rc=$?; set -e
expect "pinned hash mismatch refuses" 2 "$rc"
if grep -q '^mkfs.xfs -q' "$calls" || grep -q never-run "$work/out"; then echo "not ok - acted after mismatch"; fails=1; fi

make_case 'trap "echo binary-got-TERM; exit 143" TERM; echo "started"; sleep 30 & wait'
start=$SECONDS
set +e
"$work/install/run" >"$work/out" 2>&1 &
pid=$!
for _ in $(seq 50); do [[ -e $state/mounted ]] && break; sleep 0.1; done
sleep 0.5; kill -TERM "$pid"; wait "$pid"; rc=$?
set -e
expect "SIGTERM during run" 130 "$rc"
if (( SECONDS - start < 20 )) && grep -q binary-got-TERM "$work/acceptance.log" &&
   grep -q 'interrupted: stopping' "$work/acceptance.log"; then
    echo "ok - SIGTERM stopped the binary first (output kept in log) and cleanup ran promptly"
else echo "not ok - SIGTERM handling ($((SECONDS - start))s)"; fails=1; fi
pkill -f "$work/tmp/" 2>/dev/null || true

set +e; bash "$src" >"$work/out" 2>&1; rc=$?; set -e
if [[ $rc == 2 ]] && grep -q 'REFUSED: must run as root' "$work/out"; then echo "ok - unprivileged real run refused (rc=2)"
else echo "not ok - unprivileged refusal rc=$rc"; fails=1; fi
exit "$fails"
