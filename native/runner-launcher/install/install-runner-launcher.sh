#!/bin/bash
# Owner-run installer for the protected step-runner launcher (closes gate 5 of
# docs/native-quota-broker-service.md once --revoke-bwrap has run).
#
# Run ONLY the root-owned installed copy (see docs/step-runner-launcher.md):
#   /usr/local/libexec/step-runner-launch/install --dry-run [--app-source DIR --node-source FILE]
#   sudo /usr/local/libexec/step-runner-launch/install --install --app-source DIR --node-source FILE
#   sudo /usr/local/libexec/step-runner-launch/install --revoke-bwrap     # remove the any-arguments bwrap rule
#   sudo /usr/local/libexec/step-runner-launch/install --restore-bwrap    # undo --revoke-bwrap
#   sudo /usr/local/libexec/step-runner-launch/install --uninstall [--purge]   # undo --install
#
# Root executes nothing an unprivileged user can modify: this script, the launcher and the sudoers
# fragment must be root-owned copies in a root-owned, not group/other-writable directory chain,
# and the launcher and fragment must match the SHA-256 values pinned below. Root never executes the
# launcher (only step-runner does, in the smoke check). The app tree and the Node binary are READ
# AS the gateway account (runuser), so root never follows a path on the gateway's behalf; root only
# unpacks that stream into a fresh root-owned directory. The Node copy must match its pin.
#
# --install (fresh hosts only; refuses if anything already exists):
#   1. checks principals (itsara 1000:1000; step-runner 995:983 with no other group) and that
#      /usr/bin/bwrap is a root-owned, non-setuid, not group/other-writable file
#   2. stages /opt/step/app (node_modules harness server/src server/package.json package.json)
#      and /opt/step/node/bin/node, all root-owned, dirs 0755, files 0644/0755
#   3. creates /var/lib/step-runner-launch (root 0755) and sockets/ (itsara:itsara 0711)
#   4. installs /etc/sudoers.d/step-runner-launch (root 0440) after visudo -c -f, then visudo -c
#   5. smoke: the launcher run AS step-runner refuses a bare call and passes its credential and
#      trusted-path checks (no sandbox is started)
#   The old /etc/sudoers.d/step-runner (bwrap with ANY arguments) stays until --revoke-bwrap.
# --revoke-bwrap: moves the old rule (only if it is byte-identical to the pinned spike rule) to
#   $INSTALL_DIR/previous-step-runner.sudoers (root 0400); visudo -c.
# --restore-bwrap: puts that saved rule back (visudo -c -f first).
# --uninstall: removes /etc/sudoers.d/step-runner-launch. KEEPS /opt/step and the socket root
#   unless --purge (OFFLINE root-console maintenance only; see the runbook).
#   Purge preflights process absence and the complete socket layout before any removal.
set -euo pipefail
IFS=$' \t\n'
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

readonly LAUNCH_SHA256=fb19a64c0bd71aa7eb40b1ecee1c19efb1fd992c17f97d2b015842507bf1a54f
readonly SUDOERS_SHA256=af866337286102d4f687140999a910d08679eec143cb2cc3243136959d0b9a47
# Node 26.12.1 linux-x64 (the runtime the sandbox runs; never executed by root).
readonly NODE_SHA256=08f12d42fb304468e8ee86247fe686aae5b225836ea65e9d6566c11ae6ba2e8e
# spikes/057-step-runner-sudo/sudoers-step-runner, the rule being replaced.
readonly OLD_RULE_SHA256=1fe1d6f7aae20463ed3888197f16c64d02ebcbbe48d597353f1c4efb32132033
readonly INSTALL_DIR=/usr/local/libexec/step-runner-launch
readonly SELF_INSTALLED=$INSTALL_DIR/install
readonly LAUNCH=$INSTALL_DIR/launch
readonly SUDOERS_SRC=$INSTALL_DIR/sudoers-step-runner-launch
readonly OLD_RULE_SAVED=$INSTALL_DIR/previous-step-runner.sudoers
readonly SUDOERS_DIR=/etc/sudoers.d
readonly SUDOERS_DST=$SUDOERS_DIR/step-runner-launch
readonly OLD_RULE=$SUDOERS_DIR/step-runner
readonly STEP_DIR=/opt/step
readonly APP=$STEP_DIR/app
readonly NODE_DIR=$STEP_DIR/node/bin
readonly SOCKET_PARENT=/var/lib/step-runner-launch
readonly SOCKETS=$SOCKET_PARENT/sockets
readonly BWRAP=/usr/bin/bwrap
readonly GATEWAY_NAME=itsara GATEWAY_UID=1000 GATEWAY_GID=1000
readonly WORKLOAD_NAME=step-runner WORKLOAD_UID=995 WORKLOAD_GID=983
readonly APP_PARTS="node_modules harness server/src server/package.json package.json"
readonly APP_REQUIRED="node_modules/tsx/dist/loader.mjs server/src/register.mjs server/src/workspace/runtime-main.ts"
readonly TOOLS="stat sha256sum install getent id visudo runuser tar find chmod chown mv rm rmdir mktemp cmp cat pgrep"

usage() {
    echo "usage: $0 --dry-run [--app-source DIR --node-source FILE]" >&2
    echo "       $0 --install --app-source DIR --node-source FILE" >&2
    echo "       $0 --revoke-bwrap | --restore-bwrap | --uninstall [--purge]" >&2
    exit 2
}
die() { echo "REFUSED: $*" >&2; exit 2; }

MODE='' APP_SRC='' NODE_SRC='' PURGE=0
while (($#)); do
    case $1 in
    --dry-run|--install|--revoke-bwrap|--restore-bwrap|--uninstall) [[ -z $MODE ]] || usage; MODE=${1#--} ;;
    --app-source) (($# >= 2)) || usage; [[ -z $APP_SRC ]] || usage; APP_SRC=$2; shift ;;
    --node-source) (($# >= 2)) || usage; [[ -z $NODE_SRC ]] || usage; NODE_SRC=$2; shift ;;
    --purge) PURGE=1 ;;
    *) usage ;;
    esac
    shift
done
[[ -n $MODE ]] || usage
case $MODE in
install) [[ -n $APP_SRC && -n $NODE_SRC ]] && (( ! PURGE )) || usage ;;
dry-run) (( ! PURGE )) || usage ;;
uninstall) [[ -z $APP_SRC && -z $NODE_SRC ]] || usage ;;
*) [[ -z $APP_SRC && -z $NODE_SRC ]] && (( ! PURGE )) || usage ;;
esac
for p in "$APP_SRC" "$NODE_SRC"; do
    [[ -z $p || ( $p == /* && $p != *$'\n'* ) ]] || die "source paths must be absolute: $p"
done

trusted() { # root-owned and not group/other-writable; never follow a symlink
    local meta
    [[ ! -L $1 ]] || return 1
    meta=$(stat -c '%u %a' -- "$1" 2>/dev/null) || return 1
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
check_app_source() { # read as the gateway account: root never resolves these paths itself
    local part
    for part in $APP_PARTS $APP_REQUIRED; do
        runuser -u "$GATEWAY_NAME" -- test -e "$APP_SRC/$part" || { echo "missing $APP_SRC/$part"; return 1; }
    done
}

if [[ $MODE == dry-run ]]; then
    echo "DRY RUN - nothing is created, changed or removed (uid $(id -u))."
    echo "Pinned SHA-256: launcher $LAUNCH_SHA256"
    echo "                sudoers  $SUDOERS_SHA256"
    echo "                node     $NODE_SHA256"
    for f in "$LAUNCH" "$SUDOERS_SRC" "$SELF_INSTALLED"; do
        if [[ -f $f ]]; then
            case $f in "$LAUNCH") want=$LAUNCH_SHA256 ;; "$SUDOERS_SRC") want=$SUDOERS_SHA256 ;; *) want='' ;; esac
            m=''; [[ -n $want ]] && { [[ $(hash_of "$f") == "$want" ]] && m="matches pin; " || m="DOES NOT MATCH ($(hash_of "$f")); "; }
            t=$(trusted_chain "$f") && t="root-owned chain ok" || t="$t -> a real run would REFUSE"
            echo "  $f: $m$t"
        else
            echo "  $f: not present (a real run would REFUSE)"
        fi
    done
    for t in $TOOLS; do command -v "$t" >/dev/null || echo "MISSING tool: $t (a real run would REFUSE)"; done
    echo "Gateway $GATEWAY_NAME: expected $GATEWAY_UID:$GATEWAY_GID, found $(getent passwd "$GATEWAY_NAME" | cut -d: -f3,4)"
    echo "Workload $WORKLOAD_NAME: expected $WORKLOAD_UID:$WORKLOAD_GID (groups $WORKLOAD_GID), found $(getent passwd "$WORKLOAD_NAME" | cut -d: -f3,4) (groups $(id -G "$WORKLOAD_NAME" 2>/dev/null))"
    echo "bwrap $BWRAP: $(stat -c '%U:%G %a' -- "$BWRAP" 2>/dev/null || echo MISSING)"
    for p in "$APP" "$STEP_DIR/node" "$SOCKET_PARENT" "$SUDOERS_DST"; do
        [[ -e $p ]] && echo "EXISTS: $p (a real --install would REFUSE; fresh hosts only)"
    done
    [[ -e $OLD_RULE ]] && echo "Old any-arguments rule $OLD_RULE is present (remove with --revoke-bwrap after --install)"
    if [[ -n $NODE_SRC ]]; then
        [[ -f $NODE_SRC && $(hash_of "$NODE_SRC") == "$NODE_SHA256" ]] && echo "node source $NODE_SRC matches pin" ||
            echo "node source $NODE_SRC DOES NOT match the pin (a real run would REFUSE)"
    fi
    if [[ -n $APP_SRC ]]; then
        for part in $APP_PARTS $APP_REQUIRED; do [[ -e $APP_SRC/$part ]] || echo "app source lacks $part (a real run would REFUSE)"; done
    fi
    cat <<EOF
Steps of a real --install (root only):
  1. refuse unless uid 0, this file is $SELF_INSTALLED, it/launcher/fragment are root-owned
     (chain not group/other-writable) and launcher+fragment match the pins
  2. refuse unless principals match, $WORKLOAD_NAME has no group but $WORKLOAD_GID, $BWRAP is a
     trusted non-setuid file, and none of $APP $STEP_DIR/node $SOCKET_PARENT $SUDOERS_DST exist
  3. read the Node binary as $GATEWAY_NAME into $INSTALL_DIR, require the pin, install as $NODE_DIR/node
  4. tar the app parts as $GATEWAY_NAME, unpack as root into a fresh dir, normalise to root 0755/0644,
     refuse anything but files/dirs/symlinks, rename to $APP
  5. install -d $SOCKET_PARENT (root 0755) and $SOCKETS ($GATEWAY_UID:$GATEWAY_GID 0711)
  6. copy the fragment to a dotted temp name in $SUDOERS_DIR (ignored by sudo), visudo -c -f,
     rename to $SUDOERS_DST, visudo -c (removed again on failure)
  7. smoke: runuser -u $WORKLOAD_NAME -- $LAUNCH must refuse (usage; then broker-root/workspace)
Then: sudo $SELF_INSTALLED --revoke-bwrap   (undo: --restore-bwrap)
Undo install: sudo $SELF_INSTALLED --uninstall (keeps app/Node/sockets)
Purge: OFFLINE root-console maintenance only; see docs/step-runner-launcher.md.
EOF
    exit 0
fi

[[ $(id -u) == 0 ]] || die "must run as root (sudo $SELF_INSTALLED ...); use --dry-run to preview"
self=$(readlink -f -- "${BASH_SOURCE[0]}")
[[ $self == "$SELF_INSTALLED" ]] || die "run only the installed copy $SELF_INSTALLED (this is $self)"
for f in "$self" "$LAUNCH" "$SUDOERS_SRC"; do
    [[ -f $f && ! -L $f ]] || die "$f is not a regular file"
    msg=$(trusted_chain "$f") || die "$msg"
done
[[ $(hash_of "$LAUNCH") == "$LAUNCH_SHA256" ]] || die "launcher SHA-256 $(hash_of "$LAUNCH") != pinned $LAUNCH_SHA256"
[[ $(hash_of "$SUDOERS_SRC") == "$SUDOERS_SHA256" ]] || die "sudoers SHA-256 $(hash_of "$SUDOERS_SRC") != pinned $SUDOERS_SHA256"
for t in $TOOLS; do command -v "$t" >/dev/null || die "missing tool $t"; done

# Protect every destination before install/chown/remove. In particular, install -d would
# otherwise take over an existing writable /opt/step or follow its symlink as root.
# These parents are immutable to the gateway after validation (root-owned ancestor chains).
for p in "$SUDOERS_DIR" "$(dirname -- "$STEP_DIR")" "$(dirname -- "$SOCKET_PARENT")"; do
    [[ -d $p && ! -L $p ]] || die "destination parent is not a real directory: $p"
    msg=$(trusted_chain "$p") || die "$msg"
done
for p in "$STEP_DIR" "$SOCKET_PARENT"; do
    if [[ -e $p || -L $p ]]; then
        [[ -d $p && ! -L $p ]] && trusted "$p" || die "untrusted destination: $p"
        msg=$(trusted_chain "$p") || die "$msg"
    fi
done

# Writes $2 as a sudoers.d entry from source $1: dotted temp name (skipped by sudo), 0440, checked.
put_sudoers() {
    local tmp
    tmp=$(mktemp -- "$SUDOERS_DIR/.step-runner-launch.XXXXXXXX")
    cat -- "$1" >"$tmp"
    chmod 0440 -- "$tmp"
    visudo -c -f "$tmp" || { rm -f -- "$tmp"; die "visudo rejected $1"; }
    mv -f -T -- "$tmp" "$2"
    visudo -c || { rm -f -- "$2"; die "visudo -c failed with $2 in place; removed it again"; }
}

if [[ $MODE == revoke-bwrap ]]; then
    [[ -f $SUDOERS_DST ]] && cmp -s -- "$SUDOERS_DST" "$SUDOERS_SRC" ||
        die "the launcher rule $SUDOERS_DST is not installed; run --install first"
    if [[ ! -e $OLD_RULE ]]; then echo "no $OLD_RULE; nothing to revoke"; exit 0; fi
    [[ -f $OLD_RULE && ! -L $OLD_RULE ]] || die "$OLD_RULE is not a regular file; not touching it"
    [[ $(hash_of "$OLD_RULE") == "$OLD_RULE_SHA256" ]] ||
        die "$OLD_RULE differs from the pinned spike rule; not touching it (inspect it yourself)"
    [[ ! -e $OLD_RULE_SAVED ]] || die "$OLD_RULE_SAVED already exists"
    install -o root -g root -m 0400 -- "$OLD_RULE" "$OLD_RULE_SAVED"
    rm -f -- "$OLD_RULE"
    visudo -c || { install -o root -g root -m 0440 -- "$OLD_RULE_SAVED" "$OLD_RULE"; rm -f -- "$OLD_RULE_SAVED"; die "visudo -c failed; restored $OLD_RULE"; }
    echo "REVOKED: $OLD_RULE (bwrap with any arguments) removed; saved as $OLD_RULE_SAVED"
    echo "Undo: sudo $SELF_INSTALLED --restore-bwrap"
    exit 0
fi

if [[ $MODE == restore-bwrap ]]; then
    [[ -f $OLD_RULE_SAVED ]] || die "no saved rule $OLD_RULE_SAVED"
    [[ ! -e $OLD_RULE ]] || die "$OLD_RULE already exists"
    [[ $(hash_of "$OLD_RULE_SAVED") == "$OLD_RULE_SHA256" ]] || die "saved rule does not match its pin"
    put_sudoers "$OLD_RULE_SAVED" "$OLD_RULE"
    rm -f -- "$OLD_RULE_SAVED"
    echo "RESTORED: $OLD_RULE (bwrap with any arguments; gate 5 is open again)"
    exit 0
fi

if [[ $MODE == uninstall ]]; then
    # OFFLINE MAINTENANCE REQUIRED for --purge: the owner must first stop/fence all
    # gateway and workload sessions, services, timers and login/cron entry points,
    # and keep them fenced until purge finishes (see the owner runbook). Empty
    # sockets alone do NOT prove quiescence and this script is not a launch fence.
    # Preflight ALL layout refusals before removing even the sudoers rule.
    if (( PURGE )); then
        visudo -c || die "visudo -c failed before purge; nothing removed"
        # Snapshot checks are defense in depth, NOT a fence against later spawn.
        # Check real AND effective IDs; fail closed on pgrep errors as well.
        for ids in -u -U; do
            set +e
            pgrep "$ids" "$GATEWAY_UID,$WORKLOAD_UID" >/dev/null
            rc=$?
            set -e
            [[ $rc == 1 ]] || die "gateway/workload processes still present or process check failed; offline maintenance required"
        done
        if [[ -e $SOCKETS || -L $SOCKETS ]]; then
            [[ -d $SOCKETS && ! -L $SOCKETS ]] || die "$SOCKETS is not a real directory"
            entries=$(find "$SOCKETS" -mindepth 1 -maxdepth 1 -print -quit) || die "cannot inspect $SOCKETS"
            [[ -z $entries ]] ||
                die "$SOCKETS is not empty (a gateway may be running); not purging it"
        fi
        if [[ -d $SOCKET_PARENT ]]; then
            entries=$(find "$SOCKET_PARENT" -mindepth 1 -maxdepth 1 ! -name sockets -print -quit) || die "cannot inspect $SOCKET_PARENT"
            [[ -z $entries ]] ||
                die "$SOCKET_PARENT has unexpected entries; not purging it"
        fi
    fi
    if [[ -e $SUDOERS_DST ]]; then
        rm -f -- "$SUDOERS_DST"
        visudo -c || die "visudo -c failed after removing $SUDOERS_DST"
        echo "removed $SUDOERS_DST"
    else
        echo "no $SUDOERS_DST"
    fi
    [[ -e $OLD_RULE ]] || echo "note: $OLD_RULE is absent, so no step-runner launch is possible now (fail closed); --restore-bwrap would reopen the any-arguments rule"
    if (( PURGE )); then
        rm -rf -- "$APP" "$STEP_DIR/node"
        [[ ! -d $STEP_DIR ]] || rmdir -- "$STEP_DIR" 2>/dev/null || echo "kept non-empty $STEP_DIR"
        if [[ -d $SOCKETS ]]; then
            rmdir -- "$SOCKETS" 2>/dev/null || die "$SOCKETS is not empty (a gateway may be running); not purging it"
        fi
        [[ ! -d $SOCKET_PARENT ]] || rmdir -- "$SOCKET_PARENT"
        echo "purged $APP, $STEP_DIR/node and $SOCKET_PARENT"
    else
        echo "kept $APP, $STEP_DIR/node and $SOCKETS (purge requires offline root-console maintenance; see the runbook)"
    fi
    echo "launcher and scripts remain in $INSTALL_DIR; remove with: sudo rm -r $INSTALL_DIR"
    exit 0
fi

# ---- --install ----
[[ $(getent passwd "$GATEWAY_NAME" | cut -d: -f3,4) == "$GATEWAY_UID:$GATEWAY_GID" ]] ||
    die "$GATEWAY_NAME is not $GATEWAY_UID:$GATEWAY_GID"
[[ $(getent passwd "$WORKLOAD_NAME" | cut -d: -f3,4) == "$WORKLOAD_UID:$WORKLOAD_GID" ]] ||
    die "$WORKLOAD_NAME is not $WORKLOAD_UID:$WORKLOAD_GID"
[[ $(id -G "$WORKLOAD_NAME") == "$WORKLOAD_GID" ]] || die "$WORKLOAD_NAME has other groups: $(id -G "$WORKLOAD_NAME")"
[[ -f $BWRAP && ! -L $BWRAP ]] || die "$BWRAP is not a regular file"
msg=$(trusted_chain "$BWRAP") || die "$msg"
(( (8#$(stat -c %a -- "$BWRAP") & 8#6000) == 0 )) || die "$BWRAP is setuid/setgid; the launcher refuses that"
for p in "$APP" "$STEP_DIR/node" "$SOCKET_PARENT" "$SUDOERS_DST"; do
    [[ ! -e $p && ! -L $p ]] || die "$p already exists (fresh install only; see --uninstall --purge)"
done
msg=$(check_app_source) || die "app source: $msg"

created=()
# shellcheck disable=SC2329  # EXIT trap handler
on_exit() {
    local rc=$?
    rm -f -- "${node_tmp:-}"
    [[ -z ${app_tmp:-} ]] || rm -rf -- "$app_tmp"
    if (( rc != 0 && ${#created[@]} )); then
        echo "INSTALL FAILED (exit $rc) after creating: ${created[*]}" >&2
        echo "Inspect, then undo with: sudo $SELF_INSTALLED --uninstall --purge" >&2
    fi
}
trap on_exit EXIT

# Node: read as the gateway account into a root-owned temp file; only the copy is hashed and used.
node_tmp=$(mktemp -- "$INSTALL_DIR/.node.XXXXXXXX")
runuser -u "$GATEWAY_NAME" -- cat -- "$NODE_SRC" >"$node_tmp" || die "could not read $NODE_SRC as $GATEWAY_NAME"
[[ $(hash_of "$node_tmp") == "$NODE_SHA256" ]] || die "node SHA-256 $(hash_of "$node_tmp") != pinned $NODE_SHA256"

install -d -o root -g root -m 0755 -- "$STEP_DIR"; created+=("$STEP_DIR")
install -d -o root -g root -m 0755 -- "$STEP_DIR/node" "$NODE_DIR"
install -o root -g root -m 0755 -- "$node_tmp" "$NODE_DIR/node"
rm -f -- "$node_tmp"; node_tmp=''
[[ $(hash_of "$NODE_DIR/node") == "$NODE_SHA256" ]] || die "installed node does not match its pin"

# App: archived by the gateway account, unpacked by root into a fresh root-owned directory.
app_tmp=$(mktemp -d -- "$STEP_DIR/.app.XXXXXXXX")
# shellcheck disable=SC2086  # APP_PARTS is a fixed word list
runuser -u "$GATEWAY_NAME" -- tar -C "$APP_SRC" -cf - -- $APP_PARTS |
    tar -C "$app_tmp" -xf - --no-same-owner --no-same-permissions --no-overwrite-dir ||
    die "could not copy the app from $APP_SRC"
odd=$(find "$app_tmp" ! -type f ! -type d ! -type l -print -quit)
[[ -z $odd ]] || die "app contains a special file: ${odd#"$app_tmp"/}"
chown -R -h root:root -- "$app_tmp"
find "$app_tmp" -type d -exec chmod 0755 -- {} +
find "$app_tmp" -type f -perm /0111 -exec chmod 0755 -- {} +
find "$app_tmp" -type f ! -perm /0111 -exec chmod 0644 -- {} +
for part in $APP_REQUIRED; do [[ -f $app_tmp/$part ]] || die "staged app lacks $part"; done
mv -T -- "$app_tmp" "$APP"; app_tmp=''; created+=("$APP")

install -d -o root -g root -m 0755 -- "$SOCKET_PARENT"; created+=("$SOCKET_PARENT")
install -d -o "$GATEWAY_UID" -g "$GATEWAY_GID" -m 0711 -- "$SOCKETS"
[[ $(stat -c '%u:%g %a' -- "$SOCKETS") == "$GATEWAY_UID:$GATEWAY_GID 711" ]] || die "$SOCKETS has wrong owner/mode"

put_sudoers "$SUDOERS_SRC" "$SUDOERS_DST"; created+=("$SUDOERS_DST")

# Smoke, as step-runner only: a bare call must be a usage refusal; a well-formed request with
# /dev/null as fd 1 must get past the credential and trusted-path checks and refuse later.
set +e
out=$(runuser -u "$WORKLOAD_NAME" -- "$LAUNCH" </dev/null 2>&1 >/dev/null); rc=$?
set -e
[[ $rc == 2 && $out == *"REFUSED usage"* ]] || die "launcher smoke (bare call) gave $rc: $out"
set +e
out=$(runuser -u "$WORKLOAD_NAME" -- "$LAUNCH" v1 p100000/00000000-0000-4000-8000-000000000000 \
    00000000000000000000000000000000 65536 </dev/null 2>&1 >/dev/null); rc=$?
set -e
[[ $rc == 2 && ( $out == *"REFUSED broker-root"* || $out == *"REFUSED workspace"* ) ]] ||
    die "launcher smoke (request) gave $rc: $out"
created=()
echo "INSTALLED: $LAUNCH (sha256 $LAUNCH_SHA256), $SUDOERS_DST, $APP, $NODE_DIR/node, $SOCKETS"
echo "The old any-arguments rule $OLD_RULE is still present: sudo $SELF_INSTALLED --revoke-bwrap"
echo "Undo: sudo $SELF_INSTALLED --uninstall (purge only from the offline root console; see the runbook)"
