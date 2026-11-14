#!/bin/sh
# Negative proof for pin-scan.sh and the Makefile LSO_ tripwire. Run by
# `make pin-check-negative` with CC, CFLAGS and MAKE in the environment; needs a
# clean production systemd-observer.o in the current directory. Every refusal
# must give the expected reason, so one layer cannot mask a deleted check in
# another. Scratch lives under $TMPDIR only (required, never /tmp).
set -u
: "${CC:?}" "${CFLAGS:?}" "${MAKE:=make}"
[ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ] || { echo 'pin-negative.sh: TMPDIR must name a private scratch directory' >&2; exit 1; }
d=$(mktemp -d "$TMPDIR/observer-pin-neg.XXXXXX") || exit 1
trap 'rm -rf "$d"' EXIT
fails=0
fail() { printf 'FAIL: %s\n' "$*" >&2; fails=$((fails+1)); }
# expect <name> <reason|ACCEPT> <object> [VAR=value ...]: run pin-scan.sh on it
expect() {
    name=$1 want=$2 obj=$3; shift 3
    err=$(env "$@" sh ./pin-scan.sh "$obj" 2>&1 >/dev/null); s=$?
    if [ "$want" = ACCEPT ]; then
        [ $s -eq 0 ] || fail "$name: clean object refused: $err"
    elif [ $s -eq 0 ]; then
        fail "$name: accepted, want refusal ($want)"
    else
        case $err in *"$want"*) ;; *) fail "$name: refused for the wrong reason: $err (want $want)" ;; esac
    fi
}
fake="sh $(pwd)/pin-fake-tool.sh"
src=systemd-observer.c
# positive control: the production object passes with the real tools
expect production ACCEPT systemd-observer.o
# (a) -DLSO_TESTING alone stops at the exact #error, with and without debug info
for g in '' -g0; do
    if err=$($CC $CFLAGS $g -DLSO_TESTING -c $src -o "$d/a.o" 2>&1); then
        fail "(a$g) LSO_TESTING compiled outside the fixture"
    else
        case $err in *'#error "LSO_TESTING is only valid when systemd-observer.c is #included by test-observer-deadline.c"'*) ;;
        *) fail "(a$g) LSO_TESTING build failed without the #error: $err" ;; esac
    fi
done
# (b) a hooked object is refused, with debug info and with -g0 (there only the
#     used marker carries the name); each arm alone must refuse it
for g in '' -g0; do
    $CC $CFLAGS $g -DLSO_TESTING -DLSO_FIXTURE_INCLUDE -c $src -o "$d/b.o" || { fail "(b$g) hooked build failed"; continue; }
    expect "(b$g) hooked" 'test hook symbol' "$d/b.o"
    expect "(b$g) hooked, nm misses it" 'test hook bytes' "$d/b.o" "NM=$fake hide nm"
    expect "(b$g) hooked, strings misses it" 'test hook symbol' "$d/b.o" "STRINGS=$fake hide strings"
done
# (c) LTO bytecode hides the hook from nm and strings: refuse any LTO object,
#     slim or fat (fat objects also carry ordinary symbols and bytes)
for lto in '-flto' '-flto -ffat-lto-objects'; do
    if $CC $CFLAGS $lto -c $src -o "$d/lto.o"; then expect "(c) production $lto" 'LTO' "$d/lto.o"; else fail "(c) $lto build failed"; fi
    if $CC $CFLAGS $lto -g0 -DLSO_TESTING -DLSO_FIXTURE_INCLUDE -c $src -o "$d/lto-h.o"; then
        expect "(c) hooked $lto -g0" 'LTO' "$d/lto-h.o"
    else
        fail "(c) hooked $lto build failed"
    fi
done
# (d) fail closed: a missing, failing or silent tool refuses even a clean object
for t in NM:nm STRINGS:strings READELF:readelf; do
    v=${t%%:*} tool=${t#*:}
    expect "(d) $tool missing" "$tool failed" systemd-observer.o "$v=$d/no-such-$tool"
    expect "(d) $tool fails after full output" "$tool failed" systemd-observer.o "$v=$fake fail $tool"
    expect "(d) $tool silent" "$tool output lacks" systemd-observer.o "$v=true"
done
# (e) make itself refuses LSO_ macros in CC/CFLAGS/CPPFLAGS (dry run: builds nothing)
for var in "CFLAGS=$CFLAGS -DLSO_TESTING -DLSO_FIXTURE_INCLUDE" "CC=$CC -DLSO_TESTING" "CPPFLAGS=-DLSO_FIXTURE_INCLUDE"; do
    if err=$($MAKE -s -n "$var" systemd-observer.o 2>&1); then
        fail "(e) make accepted $var"
    else
        case $err in *'REFUSED: LSO_ test macros'*) ;; *) fail "(e) make failed for another reason: $err" ;; esac
    fi
done
# (f) `make pin-check` itself refuses a hooked systemd-observer.o (scratch copy
#     of the tree; the object is newer than its sources, so make only scans it)
t=$d/tree/launch-composition
mkdir -p "$t" "$d/tree/launch-lifecycle" "$d/tree/quota-broker" &&
    cp Makefile systemd-observer.c systemd-observer.h composition.h pin-scan.sh "$t/" &&
    cp ../launch-lifecycle/lifecycle.h "$d/tree/launch-lifecycle/" &&
    cp ../quota-broker/launch-request.h ../quota-broker/core.h "$d/tree/quota-broker/" || fail '(f) copy failed'
for o in systemd-observer.o "$d/b.o"; do
    cp "$o" "$t/systemd-observer.o" && touch "$t/systemd-observer.o"
    err=$($MAKE -s -C "$t" pin-check 2>&1); s=$?
    if [ "$o" = systemd-observer.o ]; then
        [ $s -eq 0 ] || fail "(f) make pin-check refused the production object: $err"
    else
        case $s:$err in 0:*) fail '(f) make pin-check accepted a hooked systemd-observer.o' ;; *'REFUSED: systemd-observer.o: test hook symbol'*) ;;
        *) fail "(f) make pin-check failed for another reason: $err" ;; esac
    fi
done
[ $fails -eq 0 ] || { echo "pin-check-negative: $fails failure(s)" >&2; exit 1; }
echo 'pin-check-negative: hooked, LTO and tool-failure observer builds refused'
