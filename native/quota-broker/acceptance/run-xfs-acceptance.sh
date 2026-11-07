#!/bin/bash
# Owner-run XFS project-quota acceptance for native/quota-broker (core + real adapter).
#
# Run ONLY the root-owned installed copy:
#   sudo /usr/local/libexec/step-xfs-acceptance/run            # real run (root)
#   /usr/local/libexec/step-xfs-acceptance/run --dry-run       # plan only, no privilege
#
# It executes nothing that an unprivileged user can modify: it refuses unless this
# script, the binary and every ancestor directory are root-owned and not group/other
# writable, copies the binary into a fresh root-only 0700 directory and verifies the
# copy's SHA-256 against the value pinned below before executing it.
#
# It touches nothing else on the host: one temp dir under /var/tmp holding a sparse
# image, one loop device and one mount on a root-only mountpoint (all removed by the
# EXIT trap), plus the log /var/tmp/step-xfs-acceptance.log (replaced atomically).
set -euo pipefail
IFS=$' \t\n'
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

readonly BIN_SHA256=874a5a809c5464ffa60f00d310287ee73f9e0ca57f60157c151850f11b1dea70
readonly INSTALL_DIR=/usr/local/libexec/step-xfs-acceptance
readonly SELF_INSTALLED=$INSTALL_DIR/run
readonly BIN_SRC=$INSTALL_DIR/xfs-acceptance
readonly LOG=/var/tmp/step-xfs-acceptance.log
readonly TMP_PARENT=/var/tmp
readonly WRITER_NAME=step-runner WRITER_UID=995 WRITER_GID=983
# mkfs.xfs >= 5.19 (here 6.18) refuses filesystems smaller than 300 MB without
# fstests-only overrides, so the sparse image is 320 MiB, not 256 MiB.
readonly IMAGE_MIB=320
readonly TIMEOUT_S=600
readonly TOOLS="mkfs.xfs losetup mount umount mountpoint findmnt sha256sum timeout truncate install mktemp getent stat tee"

usage() { echo "usage: $0 [--dry-run]" >&2; exit 2; }
DRY_RUN=0
case $# in
0) ;;
1) [[ $1 == --dry-run ]] || usage; DRY_RUN=1 ;;
*) usage ;;
esac

# owner uid 0 and no group/other write bit (and for dirs: also no sticky tricks needed)
trusted() {
    local meta
    meta=$(stat -L -c '%u %a %F' -- "$1" 2>/dev/null) || return 1
    local uid=${meta%% *} rest=${meta#* } mode
    mode=${rest%% *}
    [[ $uid == 0 ]] || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
}
trusted_chain() {
    local p=$1
    trusted "$p" || { echo "untrusted (not root-owned or group/other-writable): $p"; return 1; }
    while [[ $p != / ]]; do
        p=$(dirname -- "$p")
        trusted "$p" || { echo "untrusted ancestor: $p"; return 1; }
    done
}

if (( DRY_RUN )); then
    echo "DRY RUN — nothing is executed, created, mounted or changed (running as uid $(id -u))."
    echo "Pinned binary SHA-256: $BIN_SHA256"
    if [[ -r $BIN_SRC ]]; then
        actual=$(sha256sum -- "$BIN_SRC" | cut -d' ' -f1)
        [[ $actual == "$BIN_SHA256" ]] && m=matches || m="DOES NOT MATCH ($actual)"
        echo "Installed binary $BIN_SRC: present, hash $m"
        trusted_chain "$BIN_SRC" >/dev/null && echo "  owner/permissions: root-owned, not group/other-writable (ok)" \
            || echo "  owner/permissions: $(trusted_chain "$BIN_SRC") -> a real run would REFUSE"
    else
        echo "Installed binary $BIN_SRC: not present (a real run would REFUSE)"
    fi
    for t in $TOOLS; do command -v "$t" >/dev/null || echo "MISSING tool: $t (a real run would REFUSE)"; done
    w=$(getent passwd "$WRITER_NAME" | cut -d: -f3,4 || true)
    echo "Writer identity $WRITER_NAME: expected $WRITER_UID:$WRITER_GID, found ${w:-none}"
    cat <<EOF
Planned steps of a real run (requires root; refuses otherwise):
  1. refuse unless uid 0, this file is $SELF_INSTALLED, and it, $BIN_SRC and all
     ancestors are root-owned and not group/other-writable; refuse unless
     $WRITER_NAME is $WRITER_UID:$WRITER_GID
  2. T=\$(mktemp -d $TMP_PARENT/step-xfs-acceptance.XXXXXXXX); require root:root mode 0700
  3. install -o root -g root -m 0700 $BIN_SRC \$T/xfs-acceptance; sha256 of the COPY must equal the pin
  4. truncate -s ${IMAGE_MIB}M \$T/image; mkfs.xfs -q -L stepxfsacc \$T/image   (the image file only)
  5. losetup --find --show \$T/image                                           (new loop device)
  6. mkdir -m 0700 \$T/mnt; mount -t xfs -o pquota,nodev,nosuid,noexec <loop> \$T/mnt
  7. timeout -k 15 $TIMEOUT_S \$T/xfs-acceptance --mount \$T/mnt --writer-uid $WRITER_UID --writer-gid $WRITER_GID
     (writer checks drop to $WRITER_UID:$WRITER_GID, no groups, no capabilities, no_new_privs;
      mount-refusal checks run in a private mount namespace)
  8. EXIT trap, always: umount \$T/mnt; losetup -d every loop device backed by \$T/image;
     write $LOG (root-owned, mode 0644, atomic rename); rm -rf --one-file-system \$T
Exit status: 0 all checks PASS; 1 a check FAILED; 2 refused; 124 timeout.
EOF
    exit 0
fi

[[ $(id -u) == 0 ]] || { echo "REFUSED: must run as root (sudo $SELF_INSTALLED); use --dry-run to preview" >&2; exit 2; }

self=$(readlink -f -- "${BASH_SOURCE[0]}")
[[ $self == "$SELF_INSTALLED" ]] || { echo "REFUSED: run only the installed copy $SELF_INSTALLED (this is $self)" >&2; exit 2; }
msg=$(trusted_chain "$self") || { echo "REFUSED: $msg" >&2; exit 2; }
[[ -f $BIN_SRC && ! -L $BIN_SRC ]] || { echo "REFUSED: $BIN_SRC is not a regular file" >&2; exit 2; }
msg=$(trusted_chain "$BIN_SRC") || { echo "REFUSED: $msg" >&2; exit 2; }
for t in $TOOLS; do command -v "$t" >/dev/null || { echo "REFUSED: missing $t" >&2; exit 2; }; done
[[ $(getent passwd "$WRITER_NAME" | cut -d: -f3,4) == "$WRITER_UID:$WRITER_GID" ]] ||
    { echo "REFUSED: $WRITER_NAME is not $WRITER_UID:$WRITER_GID" >&2; exit 2; }

T=
CLEAN_OK=1
BIN_PID=
TAIL_PID=
OUT_SAVED=0
log() {
    local line
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
    if [[ -n $T && -d $T ]]; then printf '%s\n' "$line" | tee -a -- "$T/log"; else printf '%s\n' "$line"; fi
}
# shellcheck disable=SC2329  # invoked from the EXIT trap
publish_log() {
    [[ -n $T && -f $T/log ]] || return 0
    local tmp
    tmp=$(mktemp "$TMP_PARENT/.step-xfs-acceptance.log.XXXXXXXX") || return 1
    if cat -- "$T/log" >"$tmp" && chmod 0644 -- "$tmp" && mv -f -T -- "$tmp" "$LOG"; then
        return 0
    fi
    rm -f -- "$tmp"
    return 1
}
save_output() {
    if (( ! OUT_SAVED )) && [[ -f $T/binary.out ]]; then
        cat -- "$T/binary.out" >>"$T/log"
        OUT_SAVED=1
    fi
}
# shellcheck disable=SC2329  # EXIT trap handler
cleanup() {
    local rc=$?
    set +e
    trap - EXIT INT TERM HUP
    if [[ -n $BIN_PID ]] && kill -0 "$BIN_PID" 2>/dev/null; then
        log "interrupted: stopping the acceptance binary before cleanup"
        kill -TERM "$BIN_PID"
        wait "$BIN_PID"
    fi
    [[ -n $TAIL_PID ]] && kill "$TAIL_PID" 2>/dev/null && wait "$TAIL_PID" 2>/dev/null
    if [[ -n $T && -d $T ]]; then
        save_output
        if mountpoint -q "$T/mnt"; then
            for _ in 1 2 3 4 5 6 7 8 9 10; do umount "$T/mnt" 2>/dev/null && break; sleep 1; done
            if mountpoint -q "$T/mnt"; then
                log "CLEANUP ERROR: $T/mnt is still mounted"; CLEAN_OK=0
            else log "cleanup: unmounted $T/mnt"; fi
        fi
        if [[ -e $T/image ]]; then
            while read -r dev; do
                [[ -n $dev ]] || continue
                if losetup -d "$dev"; then log "cleanup: detached $dev"
                else log "CLEANUP ERROR: losetup -d $dev failed"; fi
            done < <(losetup -j "$T/image" -n -O NAME 2>/dev/null)
            if [[ -n $(losetup -j "$T/image" -n -O NAME 2>/dev/null) ]]; then
                log "CLEANUP ERROR: loop device still attached to $T/image"; CLEAN_OK=0
            fi
        fi
        if (( CLEAN_OK )); then
            log "cleanup: removing $T; exit status $rc"
            publish_log || echo "could not write $LOG" >&2
            rm -rf --one-file-system -- "$T" || echo "CLEANUP ERROR: could not remove $T" >&2
        else
            log "CLEANUP INCOMPLETE: left $T in place; inspect with: findmnt $T/mnt; losetup -j $T/image"
            publish_log || echo "could not write $LOG" >&2
            (( rc )) || rc=3
        fi
        [[ -e $T ]] || echo "log: $LOG"
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

T=$(mktemp -d "$TMP_PARENT/step-xfs-acceptance.XXXXXXXX")
T=$(readlink -f -- "$T")
[[ $(stat -c '%u:%g %a' -- "$T") == "0:0 700" ]] || { echo "REFUSED: $T is not root:root 0700" >&2; exit 2; }
: >"$T/log"
log "step-xfs-acceptance start; kernel $(uname -r); $(mkfs.xfs -V); $(losetup --version)"
log "work dir $T"

install -o root -g root -m 0700 -- "$BIN_SRC" "$T/xfs-acceptance"
actual=$(sha256sum -- "$T/xfs-acceptance" | cut -d' ' -f1)
if [[ $actual != "$BIN_SHA256" ]]; then
    log "REFUSED: binary SHA-256 $actual != pinned $BIN_SHA256"; exit 2
fi
log "binary copy verified: sha256 $actual"

truncate -s "${IMAGE_MIB}M" -- "$T/image"
mkfs.xfs -q -L stepxfsacc "$T/image"
log "created ${IMAGE_MIB} MiB sparse image and XFS filesystem in $T/image"
loop=$(losetup --find --show "$T/image")
log "attached $loop"
mkdir -m 0700 -- "$T/mnt"
mount -t xfs -o pquota,nodev,nosuid,noexec "$loop" "$T/mnt"
log "mounted: $(findmnt -n -o SOURCE,TARGET,FSTYPE,OPTIONS "$T/mnt")"

log "running acceptance binary (timeout ${TIMEOUT_S}s)"
# Background + wait so an INT/TERM/HUP trap fires at once; the trap stops the
# binary (timeout forwards the signal, then SIGKILL after 15 s) BEFORE unmounting.
timeout -k 15 "$TIMEOUT_S" "$T/xfs-acceptance" --mount "$T/mnt" \
    --writer-uid "$WRITER_UID" --writer-gid "$WRITER_GID" </dev/null >"$T/binary.out" 2>&1 &
BIN_PID=$!
tail -n +1 --pid="$BIN_PID" -f -- "$T/binary.out" &
TAIL_PID=$!
set +e
wait "$BIN_PID"
rc=$?
BIN_PID=
wait "$TAIL_PID"
TAIL_PID=
set -e
save_output
case $rc in
0) log "ACCEPTANCE PASSED" ;;
124) log "ACCEPTANCE TIMED OUT after ${TIMEOUT_S}s" ;;
*) log "ACCEPTANCE FAILED (binary exit $rc)" ;;
esac
exit "$rc"
