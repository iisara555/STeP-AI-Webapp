#!/bin/bash
# Unprivileged lifecycle test of install-quota-broker.sh. NEVER needs or uses root: it runs a
# derived copy whose paths point into a temp dir, with id/stat/install (root identity),
# findmnt/df/xfs_quota (mount facts), getent (principals) and systemctl replaced by recording
# stubs, and a stub broker "binary" + unit pinned by SHA-256. Root-ownership chain checks are
# stubbed out here (they are exercised by --dry-run and the real owner run).
# shellcheck disable=SC2016,SC2015  # stub bodies unexpanded; ok/bad chains are intentional
set -euo pipefail
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
src=$here/install-quota-broker.sh
[[ $(id -u) != 0 ]] || { echo "refusing to run as root" >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/install-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/stub" "$work/install" "$work/etc" "$work/mnt" "$work/systemd" "$work/run"
calls=$work/calls
me=$(id -un) uid=$(id -u) gid=$(id -g)
UUIDS=(12345678-1234-4234-8234-000000000000 12345678-1234-4234-8234-000000000001)

stub() { printf '#!/bin/bash\n%s\n' "$2" >"$work/stub/$1"; chmod 0755 "$work/stub/$1"; }
stub id '[[ $1 == -u ]] && { echo 0; exit 0; }; exec /usr/bin/id "$@"'
# Pretend every file is root-owned: replace the owner uid with 0 in any format.
# state/ was installed root:root; its group is shown as 0 too (install -g is stripped).
stub stat 'last=${!#}; a=(); for x in "$@"; do x=${x//%u/0}; [[ $last == */state ]] && x=${x//%g/0}; a+=("$x"); done; exec /usr/bin/stat "${a[@]}"'
stub install 'a=(); while (($#)); do case $1 in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; exec /usr/bin/install "${a[@]}"'
stub findmnt 'case "$*" in *FSTYPE*) echo xfs;; *OPTIONS*) echo rw,relatime,prjquota;; *UUID*) echo 6b52590c-aed0-4f2e-bcb1-204a09a49304;; esac'
stub df 'echo "Avail"; cat '"$work"'/avail'
stub xfs_quota 'echo "xfs_quota $*" >>'"$calls"'; cat '"$work"'/report'
stub getent 'case "$1 $2" in
"passwd '"$me"'") echo "'"$me"':x:'"$uid:$gid"'::/home:/bin/bash";;
"passwd step-runner") echo "step-runner:x:995:983::/:/usr/sbin/nologin";;
"group '"$gid"'") echo "'"$me"':x:'"$gid"':";;
*) exit 2;; esac'
stub systemctl 'echo "systemctl $*" >>'"$calls"'
case "$1" in
enable) mkdir -m 0700 '"$work"'/run/step-quota-broker
        python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind(\"'"$work"'/run/step-quota-broker/broker.sock\")"
        chmod 0660 '"$work"'/run/step-quota-broker/broker.sock; chmod 0710 '"$work"'/run/step-quota-broker;;
disable) rm -rf '"$work"'/run/step-quota-broker;;
esac; exit 0'

printf '#!/bin/bash\necho "broker $*" >>%s\n' "$calls" >"$work/install/step-quota-broker"
chmod 0755 "$work/install/step-quota-broker"
cp "$here/step-quota-broker.service" "$work/install/step-quota-broker.service"
bin_sum=$(sha256sum "$work/install/step-quota-broker" | cut -d' ' -f1)
unit_sum=$(sha256sum "$work/install/step-quota-broker.service" | cut -d' ' -f1)

derive() { # $1 = mismatch to break the binary pin
    local b=$bin_sum
    [[ ${1:-} == mismatch ]] && b=$(printf '%064d' 1)
    sed -e "s|^readonly BIN_SHA256=.*|readonly BIN_SHA256=$b|" \
        -e "s|^readonly UNIT_SHA256=.*|readonly UNIT_SHA256=$unit_sum|" \
        -e "s|^readonly INSTALL_DIR=.*|readonly INSTALL_DIR=$work/install|" \
        -e "s|^readonly UNIT_DST=.*|readonly UNIT_DST=$work/systemd/\$UNIT_NAME|" \
        -e "s|^readonly POLICY_DIR=.*|readonly POLICY_DIR=$work/etc/step-quota-broker|" \
        -e "s|^readonly MOUNT=.*|readonly MOUNT=$work/mnt|" \
        -e "s|^readonly SOCKET=.*|readonly SOCKET=$work/run/step-quota-broker/broker.sock|" \
        -e "s|^readonly GATEWAY_NAME=.*|readonly GATEWAY_NAME=$me GATEWAY_UID=$uid GATEWAY_GID=$gid|" \
        -e "s|^export PATH=.*|export PATH=$work/stub:/usr/sbin:/usr/bin:/sbin:/bin|" \
        -e 's|^trusted_chain() {$|trusted_chain() { return 0; }\ntrusted_chain_real() {|' \
        "$src" >"$work/install/install"
    chmod 0755 "$work/install/install"
}
fails=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fails=1; }
run() { : >"$calls"; set +e; "$work/install/install" "$@" >"$work/out" 2>&1; rc=$?; set -e; }
params=(--bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 0 --user "${UUIDS[0]}" --user "${UUIDS[1]}")
nothing_created() { [[ ! -e $work/mnt/step-ai-broker && ! -e $work/etc/step-quota-broker && ! -e $work/systemd/step-quota-broker.service ]]; }

echo 300000000000 >"$work/avail"
printf 'Project quota on /x\n#0 0 0 0 00 [------]\n#424242 1024 0 0 00 [------]\n' >"$work/report"
derive

run --install --bytes-hard 16106127361 --inodes-hard 750000 --user "${UUIDS[0]}"
[[ $rc == 2 ]] && grep -q 'multiple of 4096' "$work/out" && nothing_created && ok "unaligned byte limit refused" || bad "byte limit ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 10000001 --user "${UUIDS[0]}"
[[ $rc == 2 ]] && nothing_created && ok "inode limit out of range refused" || bad "inode limit ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 0 --user 12345678-1234-4234-8234-00000000000G
[[ $rc == 2 ]] && grep -q "not a canonical lowercase UUID" "$work/out" && nothing_created && ok "non-canonical user UUID refused" || bad "uuid ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 0 --user "${UUIDS[0]}" --user "${UUIDS[0]}"
[[ $rc == 2 ]] && grep -q duplicate "$work/out" && ok "duplicate user refused" || bad "duplicate ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 750000
[[ $rc == 2 ]] && ok "missing reserve/users refused" || bad "no users ($rc)"

run --install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 0
[[ $rc == 2 ]] && grep -q 'need 1..512' "$work/out" && nothing_created && ok "no users refused" || bad "no users ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 1125899906842625 --user "${UUIDS[0]}"
[[ $rc == 2 ]] && grep -q 'reserve-bytes' "$work/out" && nothing_created && ok "reserve out of range refused" || bad "reserve range ($rc)"
run --install --bytes-hard 16106127360 --inodes-hard 750000 --reserve-bytes 300000000000 --user "${UUIDS[0]}"
[[ $rc == 2 ]] && grep -q overcommit "$work/out" && nothing_created && ok "reserve included in pre-install admission" || bad "reserve capacity ($rc)"

echo 30000000000 >"$work/avail" # < 2 x 15 GiB
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q overcommit "$work/out" && nothing_created && ok "overcommit refused before any change" || bad "overcommit ($rc)"
echo 300000000000 >"$work/avail"

printf '#0 0 0 0 00 [------]\n#100005 4 0 0 00 [------]\n' >"$work/report"
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'census: project 100005' "$work/out" && nothing_created &&
    ok "census conflict in range refused before any change" || bad "census ($rc)"
printf 'Project quota on /x\n#0 0 0 0 00 [------]\n#424242 1024 0 0 00 [------]\n' >"$work/report"

derive mismatch
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'binary SHA-256' "$work/out" && nothing_created && ! grep -q broker "$calls" &&
    ok "pinned hash mismatch refuses, binary never run" || bad "hash ($rc)"
derive

run --install "${params[@]}"
policy=$work/etc/step-quota-broker/policy
read -r dev ino < <(/usr/bin/stat -c '%d %i' "$work/mnt/step-ai-broker/root")
if [[ $rc == 0 && $(/usr/bin/stat -c %a "$policy") == 644 ]] &&
   grep -qx 'bytes_hard=16106127360' "$policy" && grep -qx 'inodes_hard=750000' "$policy" &&
   grep -qx 'version=2' "$policy" && grep -qx 'reserve_bytes=0' "$policy" && ! grep -q '^user=' "$policy" && grep -qx "root_device=$dev" "$policy" &&
   grep -qx "root_inode=$ino" "$policy" && grep -qx 'mount_uuid=6b52590c-aed0-4f2e-bcb1-204a09a49304' "$policy" &&
   grep -qE '^epoch=[0-9a-f]{32}$' "$policy" && grep -qx "gateway_gid=$gid" "$policy" &&
   [[ $(/usr/bin/stat -c %a "$work/mnt/step-ai-broker") == 755 ]] &&
   [[ $(/usr/bin/stat -c %a "$work/mnt/step-ai-broker/root") == 710 ]] &&
   [[ $(/usr/bin/stat -c %a "$work/mnt/step-ai-broker/state") == 700 ]] &&
   grep -q "^xfs_quota -x -c report -p -b -i -n -N $work/mnt$" "$calls" &&
   diff <(grep -E '^(broker|systemctl)' "$calls") <(printf '%s\n' 'broker --bootstrap' "broker --add-user ${UUIDS[0]}" "broker --add-user ${UUIDS[1]}" 'broker --check' \
        'systemctl daemon-reload' 'systemctl enable --now step-quota-broker.service' \
        'systemctl is-active --quiet step-quota-broker.service') >/dev/null &&
   cmp -s "$work/systemd/step-quota-broker.service" "$here/step-quota-broker.service"; then
    ok "install: policy values/modes, dirs, census, bootstrap+check, unit enabled, socket verified"
else bad "install ($rc): $(cat "$work/out")"; fi

run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'already exists' "$work/out" && ok "second install refused (fresh hosts only)" || bad "reinstall ($rc)"

run --uninstall
[[ $rc == 0 && ! -e $work/systemd/step-quota-broker.service && -f $policy && -d $work/mnt/step-ai-broker/state ]] &&
    grep -q 'systemctl disable --now step-quota-broker.service' "$calls" &&
    ok "uninstall stops/removes the unit, keeps policy and state" || bad "uninstall ($rc)"
mkdir "$work/mnt/step-ai-broker/root/p100000"
run --uninstall --purge-empty
[[ $rc == 2 && -d $work/mnt/step-ai-broker/root/p100000 && -f $policy ]] &&
    ok "purge refused once a user pool exists (ids never recycled)" || bad "purge with allocation ($rc)"
rmdir "$work/mnt/step-ai-broker/root/p100000"
printf 'grant\n' >"$work/mnt/step-ai-broker/state/journal"
run --uninstall --purge-empty
[[ $rc == 2 && -f $policy ]] && grep -q 'journal contains grants/events' "$work/out" &&
    ok "purge refused for journal grants even before first workspace" || bad "purge with grant ($rc)"
: >"$work/mnt/step-ai-broker/state/manifest"; : >"$work/mnt/step-ai-broker/state/journal"
run --uninstall --purge-empty
[[ $rc == 0 && ! -e $work/mnt/step-ai-broker && ! -e $work/etc/step-quota-broker ]] &&
    ok "purge-empty removes an unused install completely" || bad "purge-empty ($rc): $(cat "$work/out")"

set +e; bash "$src" --install "${params[@]}" >"$work/out" 2>&1; rc=$?; set -e
[[ $rc == 2 ]] && grep -q 'must run as root' "$work/out" && ok "unprivileged real run refused" || bad "unprivileged ($rc)"
set +e; bash "$src" --dry-run "${params[@]}" >"$work/out" 2>&1; rc=$?; set -e
[[ $rc == 0 ]] && grep -q 'DRY RUN' "$work/out" && ok "dry run without privilege" || bad "dry run ($rc)"
exit "$fails"
