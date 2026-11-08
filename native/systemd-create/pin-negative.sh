#!/bin/sh
# Negative proof for pin-scan.sh and the Makefile LSC_ tripwire. Run by
# `make pin-check-negative` with CC, CFLAGS and MAKE in the environment; needs a
# clean production create.o in the current directory. Every refusal must give
# the expected reason, so one layer cannot mask a deleted check in another.
set -u
: "${CC:?}" "${CFLAGS:?}" "${MAKE:=make}"
d=$(mktemp -d "${TMPDIR:-/tmp}/pin-neg.XXXXXX") || exit 1
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
# positive control: the production object passes with the real tools
expect production ACCEPT create.o
# (a) -DLSC_TESTING alone stops at the #error, with and without debug info
for g in '' -g0; do
    if err=$($CC $CFLAGS $g -DLSC_TESTING -c create.c -o "$d/a.o" 2>&1); then
        fail "(a$g) LSC_TESTING compiled outside the fixture"
    else
        case $err in *'#error "LSC_TESTING is only valid when create.c is #included by test-create.c"'*) ;;
        *) fail "(a$g) LSC_TESTING build failed without the #error: $err" ;; esac
    fi
done
# (b) a hooked object is refused, with debug info and with -g0 (there only the
#     used marker carries the name); each arm alone must refuse it
for g in '' -g0; do
    $CC $CFLAGS $g -DLSC_TESTING -DLSC_FIXTURE_INCLUDE -c create.c -o "$d/b.o" || { fail "(b$g) hooked build failed"; continue; }
    expect "(b$g) hooked" 'test hook' "$d/b.o"
    expect "(b$g) hooked, nm misses it" 'test hook bytes' "$d/b.o" "NM=$fake hide nm"
    expect "(b$g) hooked, strings misses it" 'test hook symbol' "$d/b.o" "STRINGS=$fake hide strings"
done
# (c) LTO bytecode hides the hook from nm and strings: refuse any LTO object
if $CC $CFLAGS -flto -c create.c -o "$d/lto.o"; then expect '(c) production -flto' 'LTO' "$d/lto.o"; else fail '(c) -flto build failed'; fi
if $CC $CFLAGS -flto -g0 -DLSC_TESTING -DLSC_FIXTURE_INCLUDE -c create.c -o "$d/lto-h.o"; then
    expect '(c) hooked -flto -g0' 'LTO' "$d/lto-h.o"
else
    fail '(c) hooked -flto build failed'
fi
# (d) fail closed: a missing, failing or silent tool refuses even a clean object
for t in NM:nm STRINGS:strings READELF:readelf; do
    v=${t%%:*} tool=${t#*:}
    expect "(d) $tool missing" "$tool failed" create.o "$v=$d/no-such-$tool"
    expect "(d) $tool fails after full output" "$tool failed" create.o "$v=$fake fail $tool"
    expect "(d) $tool silent" "$tool output lacks" create.o "$v=true"
done
# (e) make itself refuses LSC_ macros in CC/CFLAGS/CPPFLAGS (dry run: builds nothing)
for var in "CFLAGS=$CFLAGS -DLSC_TESTING -DLSC_FIXTURE_INCLUDE" "CC=$CC -DLSC_TESTING" "CPPFLAGS=-DLSC_FIXTURE_INCLUDE"; do
    if err=$($MAKE -s -n "$var" create.o 2>&1); then
        fail "(e) make accepted $var"
    else
        case $err in *'REFUSED: LSC_ test macros'*) ;; *) fail "(e) make failed for another reason: $err" ;; esac
    fi
done
# (f) `make pin-check` itself refuses a hooked create.o (scratch copy of the tree;
#     the hooked object is newer than its sources, so make only scans it)
t=$d/tree/systemd-create
mkdir -p "$t" "$d/tree/launch-lifecycle" && cp Makefile create.c create.h pin-scan.sh "$t/" &&
    cp ../launch-lifecycle/lifecycle.h "$d/tree/launch-lifecycle/" || fail '(f) copy failed'
for o in create.o "$d/b.o"; do
    cp "$o" "$t/create.o" && touch "$t/create.o"
    err=$($MAKE -s -C "$t" pin-check 2>&1); s=$?
    if [ "$o" = create.o ]; then
        [ $s -eq 0 ] || fail "(f) make pin-check refused the production object: $err"
    else
        case $s:$err in 0:*) fail '(f) make pin-check accepted a hooked create.o' ;; *'REFUSED: create.o: test hook'*) ;;
        *) fail "(f) make pin-check failed for another reason: $err" ;; esac
    fi
done
[ $fails -eq 0 ] || { echo "pin-check-negative: $fails failure(s)" >&2; exit 1; }
echo 'pin-check-negative: hooked, LTO and tool-failure builds refused'
