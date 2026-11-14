#!/bin/sh
# Test-only wrapper used by pin-negative.sh: <mode> <tool> <args...>
#   hide: run the tool but drop every line mentioning the hook (a tool that misses it)
#   fail: run the tool, print its real output, then exit nonzero
mode=$1 tool=$2
shift 2
case $mode in
hide) "$tool" "$@" | sed '/lsc_test_/d' ;;
fail) "$tool" "$@"; exit 3 ;;
*) exit 2 ;;
esac
