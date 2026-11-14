#!/bin/bash
# Owner-run installer for the native quota broker system service (step-quota-broker).
#
# Run ONLY the root-owned installed copy (see docs/native-quota-broker-service.md):
#   /usr/local/libexec/step-quota-broker/install --dry-run  --bytes-hard N --inodes-hard N --reserve-bytes N --user UUID...
#   sudo /usr/local/libexec/step-quota-broker/install --install --bytes-hard N --inodes-hard N --reserve-bytes N --user UUID...
#   sudo /usr/local/libexec/step-quota-broker/install --uninstall [--purge-empty]
#
# It executes nothing an unprivileged user can modify: it refuses unless this script, the
# broker binary and the unit file are root-owned copies in a root-owned, not group/other-writable
# directory chain, and the binary and unit match the SHA-256 values pinned below.
#
# --install (fresh hosts only; refuses if anything already exists):
#   1. checks principals (itsara 1000:1000 gateway, step-runner 995 workload), no overcommit
#      (users x bytes-hard <= available space), that
#      /mnt/step-work is an XFS mount root with project quota, and that NO project id in the
#      broker range already has a quota record (census, xfs_quota report)
#   2. creates /mnt/step-work/step-ai-broker (root 0755) with root/ (root:1000 0710; one
#      p<ID> per user, workspaces inside) and
#      state/ (root 0700)
#   3. writes /etc/step-quota-broker/policy (root 0644) from the parameters plus the measured
#      root device/inode, filesystem UUID and a fresh random epoch
#   4. runs the installed binary --bootstrap (once) and --check
#   5. installs /etc/systemd/system/step-quota-broker.service, daemon-reload, enable --now,
#      and checks the socket /run/step-quota-broker/broker.sock is root:1000 0660 in a 0710 dir
# --uninstall: stop+disable+remove the unit. KEEPS the policy, state journal and every p<ID>
#   (allocations are never recycled). --purge-empty additionally removes the policy and broker
#   directories, but only while root/ contains no p<ID> (i.e. nothing was ever allocated).
set -euo pipefail
IFS=$' \t\n'
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

readonly BIN_SHA256=65bc1819e38d747285aa77d13aa5e639251a3c098e0ac8de19e1fc62ad2aeae5
readonly UNIT_SHA256=2d86101468b2af0622680ffa5e1004ba1ef55239a82192a6e16f4f7082e39394
readonly INSTALL_DIR=/usr/local/libexec/step-quota-broker
readonly SELF_INSTALLED=$INSTALL_DIR/install
readonly BIN=$INSTALL_DIR/step-quota-broker
readonly UNIT_SRC=$INSTALL_DIR/step-quota-broker.service
readonly UNIT_NAME=step-quota-broker.service
readonly UNIT_DST=/etc/systemd/system/$UNIT_NAME
readonly POLICY_DIR=/etc/step-quota-broker
readonly MOUNT=/mnt/step-work
readonly BROKER_DIR=$MOUNT/step-ai-broker
readonly SOCKET=/run/step-quota-broker/broker.sock
readonly GATEWAY_NAME=itsara GATEWAY_UID=1000 GATEWAY_GID=1000
readonly WORKLOAD_NAME=step-runner WORKLOAD_UID=995 WORKLOAD_GID=983
# Broker project-id range; the old manual test project 424242 is outside it.
readonly FIRST_PROJECT=100000 LAST_PROJECT=199999
readonly TOOLS="findmnt stat sha256sum install systemctl getent xfs_quota od mktemp mv chmod rmdir id df"

usage() {
    echo "usage: $0 --dry-run|--install --bytes-hard BYTES --inodes-hard N --reserve-bytes N --user UUID [--user UUID...]" >&2
    echo "       $0 --uninstall [--purge-empty]" >&2
    exit 2
}
die() { echo "REFUSED: $*" >&2; exit 2; }

MODE='' BYTES='' INODES='' RESERVE='' PURGE=0
GRANTS=()
while (($#)); do
    case $1 in
    --dry-run|--install|--uninstall) [[ -z $MODE ]] || usage; MODE=${1#--} ;;
    --bytes-hard) (($# >= 2)) || usage; [[ -z $BYTES ]] || usage; BYTES=$2; shift ;;
    --inodes-hard) (($# >= 2)) || usage; [[ -z $INODES ]] || usage; INODES=$2; shift ;;
    --reserve-bytes) (($# >= 2)) || usage; [[ -z $RESERVE ]] || usage; RESERVE=$2; shift ;;
    --user) (($# >= 2)) || usage; GRANTS+=("$2"); shift ;;
    --purge-empty) PURGE=1 ;;
    *) usage ;;
    esac
    shift
done
[[ -n $MODE ]] || usage
if [[ $MODE == uninstall ]]; then
    [[ -z $BYTES && -z $INODES && -z $RESERVE && ${#GRANTS[@]} == 0 ]] || usage
else
    (( ! PURGE )) || usage
    # Same bounds as the native policy parser (policy.c); it re-validates everything.
    if ! [[ $BYTES =~ ^[1-9][0-9]{3,12}$ ]] || (( BYTES < 4096 || BYTES > 1099511627776 || BYTES % 4096 )); then
        die "--bytes-hard must be a multiple of 4096 in 4096..1099511627776 (placeholder: 16106127360 = 15 GiB per user)"
    fi
    if ! [[ $INODES =~ ^[1-9][0-9]{0,7}$ ]] || (( INODES > 10000000 )); then
        die "--inodes-hard must be 1..10000000 (placeholder: 750000 per user)"
    fi
    if ! [[ $RESERVE =~ ^(0|[1-9][0-9]{0,15})$ ]] || (( RESERVE > 1125899906842624 )); then
        die "--reserve-bytes must be a canonical decimal in 0..1125899906842624 (choose protected headroom)"
    fi
    (( ${#GRANTS[@]} >= 1 && ${#GRANTS[@]} <= 512 )) || die "need 1..512 --user UUIDs (one quota pool per user)"
    declare -A seen=()
    for g in "${GRANTS[@]}"; do
        [[ $g =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
            die "user '$g' is not a canonical lowercase UUID"
        [[ -z ${seen[$g]:-} ]] || die "duplicate user $g"
        seen[$g]=1
    done
fi

trusted() { # root-owned and not group/other-writable
    local meta
    meta=$(stat -L -c '%u %a' -- "$1" 2>/dev/null) || return 1
    [[ ${meta%% *} == 0 ]] || return 1
    (( (8#${meta#* } & 8#022) == 0 ))
}
trusted_chain() {
    local p=$1
    trusted "$p" || { echo "untrusted (not root-owned or group/other-writable): $p"; return 1; }
    while [[ $p != / ]]; do
        p=$(dirname -- "$p")
        trusted "$p" || { echo "untrusted ancestor: $p"; return 1; }
    done
}
hash_of() { sha256sum -- "$1" | cut -d' ' -f1; }

if [[ $MODE == dry-run ]]; then
    echo "DRY RUN - nothing is created, changed, started or stopped (uid $(id -u))."
    echo "Pinned SHA-256: binary $BIN_SHA256"
    echo "                unit   $UNIT_SHA256"
    for f in "$BIN" "$UNIT_SRC"; do
        if [[ -f $f ]]; then
            want=$BIN_SHA256; [[ $f == "$UNIT_SRC" ]] && want=$UNIT_SHA256
            [[ $(hash_of "$f") == "$want" ]] && m="matches pin" || m="DOES NOT MATCH ($(hash_of "$f"))"
            t=$(trusted_chain "$f") && t="root-owned chain ok" || t="$t -> a real run would REFUSE"
            echo "  $f: $m; $t"
        else
            echo "  $f: not present (a real run would REFUSE)"
        fi
    done
    for t in $TOOLS; do command -v "$t" >/dev/null || echo "MISSING tool: $t (a real run would REFUSE)"; done
    echo "Gateway $GATEWAY_NAME: expected $GATEWAY_UID:$GATEWAY_GID, found $(getent passwd "$GATEWAY_NAME" | cut -d: -f3,4)"
    echo "Workload $WORKLOAD_NAME: expected $WORKLOAD_UID:$WORKLOAD_GID, found $(getent passwd "$WORKLOAD_NAME" | cut -d: -f3,4)"
    avail=$(df --output=avail -B1 -- "$MOUNT" 2>/dev/null | tail -n 1 | tr -d ' ')
    echo "Capacity: ${#GRANTS[@]} users x $BYTES = $(( ${#GRANTS[@]} * BYTES )) bytes committed + reserve $RESERVE; ${avail:-?} available (a real run REFUSES overcommit)"
    echo "Mount $MOUNT: $(findmnt -n -o TARGET,FSTYPE,OPTIONS,UUID --mountpoint "$MOUNT" 2>/dev/null || echo 'NOT A MOUNT POINT (a real run would REFUSE)')"
    for p in "$POLICY_DIR" "$BROKER_DIR" "$UNIT_DST"; do
        [[ -e $p ]] && echo "EXISTS: $p (a real --install would REFUSE; fresh hosts only)"
    done
    cat <<EOF
Policy that --install would write to $POLICY_DIR/policy (root 0644):
  version=2  epoch=<16 random bytes>  mount_uuid=<UUID of $MOUNT>
  root_device/root_inode=<of $BROKER_DIR/root after creation>
  bytes_hard=$BYTES  inodes_hard=$INODES  first_project=$FIRST_PROJECT  last_project=$LAST_PROJECT
  gateway_uid=$GATEWAY_UID  gateway_gid=$GATEWAY_GID  workload_uid=$WORKLOAD_UID
  reserve_bytes=$RESERVE
  # users are durable journal grants, never policy lines
Steps of a real --install (root only):
  1. refuse unless uid 0, this file is $SELF_INSTALLED, it/binary/unit are root-owned
     (chain not group/other-writable), and binary+unit match the pins
  2. refuse unless principals match, $MOUNT is an XFS mount root with prjquota, and
     xfs_quota -x -c 'report -p -b -i -n -N' $MOUNT lists no id in $FIRST_PROJECT..$LAST_PROJECT
     (census needs root; not run in a dry run)
  3. install -d root:root 0755 $BROKER_DIR; root:$GATEWAY_GID 0710 root/; root:root 0700 state/
  4. write the policy via mktemp + chmod 0644 + mv -T (root-owned $POLICY_DIR 0755)
  5. $BIN --bootstrap; $BIN --add-user UUID (each initial user); $BIN --check
  6. install -m 0644 unit to $UNIT_DST; systemctl daemon-reload; systemctl enable --now $UNIT_NAME
  7. require $SOCKET root:$GATEWAY_GID 0660 in a root:$GATEWAY_GID 0710 directory
Undo: sudo $SELF_INSTALLED --uninstall   (keeps policy/state/p<ID>; add --purge-empty only if
      nothing was ever allocated)
EOF
    exit 0
fi

[[ $(id -u) == 0 ]] || die "must run as root (sudo $SELF_INSTALLED ...); use --dry-run to preview"
self=$(readlink -f -- "${BASH_SOURCE[0]}")
[[ $self == "$SELF_INSTALLED" ]] || die "run only the installed copy $SELF_INSTALLED (this is $self)"
for f in "$self" "$BIN" "$UNIT_SRC"; do
    [[ -f $f && ! -L $f ]] || die "$f is not a regular file"
    msg=$(trusted_chain "$f") || die "$msg"
done
[[ $(hash_of "$BIN") == "$BIN_SHA256" ]] || die "binary SHA-256 $(hash_of "$BIN") != pinned $BIN_SHA256"
[[ $(hash_of "$UNIT_SRC") == "$UNIT_SHA256" ]] || die "unit SHA-256 $(hash_of "$UNIT_SRC") != pinned $UNIT_SHA256"
for t in $TOOLS; do command -v "$t" >/dev/null || die "missing tool $t"; done

if [[ $MODE == uninstall ]]; then
    if [[ -e $UNIT_DST ]]; then
        systemctl disable --now "$UNIT_NAME" || die "could not stop/disable $UNIT_NAME"
        rm -f -- "$UNIT_DST"
        systemctl daemon-reload
        echo "removed $UNIT_DST (service stopped and disabled)"
    else
        echo "no $UNIT_DST; nothing to stop"
    fi
    if (( PURGE )); then
        [[ ! -s $BROKER_DIR/state/journal ]] || die "state journal contains grants/events; NOT purging (ids never recycled)"
        if [[ -d $BROKER_DIR/root ]] && [[ -n $(ls -A -- "$BROKER_DIR/root") ]]; then
            die "$BROKER_DIR/root contains allocated project directories; NOT purging (ids are never recycled; see docs)"
        fi
        rm -f -- "$BROKER_DIR/state/manifest" "$BROKER_DIR/state/journal" "$POLICY_DIR/policy"
        for d in "$BROKER_DIR/root" "$BROKER_DIR/state" "$BROKER_DIR" "$POLICY_DIR"; do
            [[ ! -e $d ]] || rmdir -- "$d"
        done
        echo "purged empty policy and broker directories"
    else
        echo "kept $POLICY_DIR and $BROKER_DIR (allocation journal and workspace data)"
    fi
    echo "binaries remain in $INSTALL_DIR; remove with: sudo rm -r $INSTALL_DIR"
    exit 0
fi

# ---- --install ----
[[ $(getent passwd "$GATEWAY_NAME" | cut -d: -f3,4) == "$GATEWAY_UID:$GATEWAY_GID" ]] ||
    die "$GATEWAY_NAME is not $GATEWAY_UID:$GATEWAY_GID"
[[ $(getent passwd "$WORKLOAD_NAME" | cut -d: -f3,4) == "$WORKLOAD_UID:$WORKLOAD_GID" ]] ||
    die "$WORKLOAD_NAME is not $WORKLOAD_UID:$WORKLOAD_GID"
# The gateway group must contain no other user, or they could traverse the broker root.
members=$(getent group "$GATEWAY_GID" | cut -d: -f4)
[[ -z $members || $members == "$GATEWAY_NAME" ]] || die "group $GATEWAY_GID has other members: $members"
fs=$(findmnt -n -o FSTYPE --mountpoint "$MOUNT") || die "$MOUNT is not a mount point"
[[ $fs == xfs ]] || die "$MOUNT is $fs, not xfs"
opts=$(findmnt -n -o OPTIONS --mountpoint "$MOUNT")
[[ ,$opts, == *,prjquota,* || ,$opts, == *,pquota,* ]] || die "$MOUNT is not mounted with prjquota ($opts)"
fsuuid=$(findmnt -n -o UUID --mountpoint "$MOUNT")
[[ $fsuuid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "unexpected filesystem UUID '$fsuuid'"
for p in "$POLICY_DIR" "$BROKER_DIR" "$UNIT_DST"; do
    [[ ! -e $p && ! -L $p ]] || die "$p already exists (fresh install only; see --uninstall)"
done
# No overcommit: every user's full pool must fit in the space available right now.
avail=$(df --output=avail -B1 -- "$MOUNT" | tail -n 1 | tr -d ' ')
[[ $avail =~ ^[0-9]+$ ]] || die "could not read available space of $MOUNT"
committed=$(( ${#GRANTS[@]} * BYTES ))
(( committed <= avail && RESERVE <= avail - committed )) || die "overcommit: ${#GRANTS[@]} users x $BYTES = $committed bytes + reserve $RESERVE > $avail available on $MOUNT"
echo "capacity: ${#GRANTS[@]} users x $BYTES = $committed bytes committed of $avail available"
# Census: no existing project quota record (usage or limits) inside the broker range.
report=$(xfs_quota -x -c 'report -p -b -i -n -N' "$MOUNT") || die "xfs_quota report failed"
while read -r id _; do
    [[ $id =~ ^#([0-9]+)$ ]] || continue
    n=${BASH_REMATCH[1]}
    (( n < FIRST_PROJECT || n > LAST_PROJECT )) || die "census: project $n already has a quota record inside $FIRST_PROJECT..$LAST_PROJECT"
done <<<"$report"
echo "census: no quota record in $FIRST_PROJECT..$LAST_PROJECT"

created=()
# shellcheck disable=SC2329  # EXIT trap handler
on_exit() {
    local rc=$?
    if (( rc != 0 && ${#created[@]} )); then
        echo "INSTALL FAILED (exit $rc) after creating: ${created[*]}" >&2
        echo "Inspect, then undo with: sudo $SELF_INSTALLED --uninstall --purge-empty" >&2
    fi
}
trap on_exit EXIT

install -d -o root -g root -m 0755 -- "$BROKER_DIR"; created+=("$BROKER_DIR")
install -d -o root -g "$GATEWAY_GID" -m 0710 -- "$BROKER_DIR/root"
install -d -o root -g root -m 0700 -- "$BROKER_DIR/state"
[[ $(stat -c '%u:%g %a' -- "$BROKER_DIR/root") == "0:$GATEWAY_GID 710" ]] || die "root/ has wrong owner/mode"
[[ $(stat -c '%u:%g %a' -- "$BROKER_DIR/state") == "0:0 700" ]] || die "state/ has wrong owner/mode"
read -r dev ino < <(stat -c '%d %i' -- "$BROKER_DIR/root")
epoch=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
[[ $epoch =~ ^[0-9a-f]{32}$ && $epoch != 00000000000000000000000000000000 ]] || die "bad epoch"

install -d -o root -g root -m 0755 -- "$POLICY_DIR"; created+=("$POLICY_DIR")
tmp=$(mktemp -- "$POLICY_DIR/.policy.XXXXXXXX")
{
    echo "# step-quota-broker policy, written by $SELF_INSTALLED on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Immutable after bootstrap: the state manifest binds every value below."
    echo "version=2"
    echo "epoch=$epoch"
    echo "mount_uuid=$fsuuid"
    echo "root_device=$dev"
    echo "root_inode=$ino"
    echo "bytes_hard=$BYTES"
    echo "inodes_hard=$INODES"
    echo "first_project=$FIRST_PROJECT"
    echo "last_project=$LAST_PROJECT"
    echo "gateway_uid=$GATEWAY_UID"
    echo "gateway_gid=$GATEWAY_GID"
    echo "workload_uid=$WORKLOAD_UID"
    echo "reserve_bytes=$RESERVE"
} >"$tmp"
chmod 0644 -- "$tmp"
mv -f -T -- "$tmp" "$POLICY_DIR/policy"
echo "wrote $POLICY_DIR/policy (sha256 $(hash_of "$POLICY_DIR/policy"))"

"$BIN" --bootstrap
for g in "${GRANTS[@]}"; do "$BIN" --add-user "$g"; done
"$BIN" --check

install -o root -g root -m 0644 -- "$UNIT_SRC" "$UNIT_DST"; created+=("$UNIT_DST")
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
systemctl is-active --quiet "$UNIT_NAME" || die "$UNIT_NAME is not active (journalctl -u $UNIT_NAME)"
[[ $(stat -c '%u:%g %a %F' -- "$(dirname -- "$SOCKET")") == "0:$GATEWAY_GID 710 directory" ]] ||
    die "socket directory has wrong owner/mode"
[[ $(stat -c '%u:%g %a %F' -- "$SOCKET") == "0:$GATEWAY_GID 660 socket" ]] || die "socket has wrong owner/mode"
created=()
echo "INSTALLED: $UNIT_NAME active; socket $SOCKET (root:$GATEWAY_GID 0660, dir 0710)"
echo "Undo: sudo $SELF_INSTALLED --uninstall"
