#!/bin/sh
# usage: pin-scan.sh <object>
# Exit 0 only for a non-LTO ELF object whose symbol table and raw bytes carry no
# lso_test_ hook (the production systemd-observer.o). Fails closed: a missing or
# failing tool, or implausible (empty) tool output, refuses. NM, STRINGS and
# READELF may name a wrapper (word-split). Every refusal names its own reason so
# pin-negative.sh can prove each arm alone.
set -u
NM=${NM:-nm} STRINGS=${STRINGS:-strings} READELF=${READELF:-readelf}
[ $# -eq 1 ] || { echo 'usage: pin-scan.sh <object>' >&2; exit 2; }
obj=$1
refuse() { printf 'REFUSED: %s: %s\n' "$obj" "$1" >&2; exit 1; }
sections=$($READELF -W -S "$obj" 2>&1) || refuse 'readelf failed'
case $sections in *' .text '*) ;; *) refuse 'readelf output lacks a .text section' ;; esac
# LTO bytecode (zstd-compressed GIMPLE) hides static names from nm and strings.
case $sections in *'.gnu.lto_'*) refuse 'LTO object (.gnu.lto_* sections) cannot be scanned' ;; esac
symbols=$($NM -a "$obj" 2>&1) || refuse 'nm failed'
case $symbols in *' T lso_bus_snapshot'*) ;; *) refuse 'nm output lacks lso_bus_snapshot' ;; esac
bytes=$($STRINGS -a "$obj" 2>&1) || refuse 'strings failed'
case $bytes in *'unix:path=/run/dbus/system_bus_socket'*) ;; *) refuse 'strings output lacks the system bus address' ;; esac
case $symbols in *lso_test_*) refuse 'test hook symbol' ;; esac
case $bytes in *lso_test_*) refuse 'test hook bytes' ;; esac
exit 0
