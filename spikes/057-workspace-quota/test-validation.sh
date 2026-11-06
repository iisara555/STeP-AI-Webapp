#!/bin/bash
# Non-root validation test for step-workspace-quota: xfs_quota is replaced by `echo XFS`,
# and the root check is removed. Every other line of the helper runs unchanged.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/quota-helper-test-XXXX"); trap 'rm -rf "$T"; rm -rf "$USERS_DIR/synthetic-quota-probe"' EXIT
sed -e '/must run as root/d' -e 's/^\(\s*\)xfs_quota /\1echo XFS /' "$HERE/step-workspace-quota" > "$T/helper"
chmod 700 "$T/helper"
USERS_DIR=/mnt/step-work/step-ai/users
WS=ws_$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')
mkdir -p "$USERS_DIR/synthetic-quota-probe/workspaces/$WS"
ln -s /etc "$USERS_DIR/synthetic-quota-probe/workspaces/ws_00000000000000000000000000000000"
pass=0; fail=0
expect() { # expect <ok|fail> <description> <args...>
  local want=$1 what=$2; shift 2
  out=$("$T/helper" "$@" 2>&1); rc=$?
  if { [[ $want == ok && $rc == 0 ]] || [[ $want == fail && $rc != 0 ]]; }; then pass=$((pass+1)); echo "PASS $what"
  else fail=$((fail+1)); echo "FAIL $what (rc=$rc) $out"; fi
}
expect ok   'valid set on a real workspace folder'  set synthetic-quota-probe "$WS" 100001 512 10000
expect ok   'valid clear'                           clear synthetic-quota-probe "$WS" 100001
expect ok   'valid report'                          report 100001
expect fail 'path traversal in owner id'            set ../../etc "$WS" 100001 512 10000
expect fail 'slash in owner id'                     set a/b "$WS" 100001 512 10000
expect fail 'malformed workspace id'                set synthetic-quota-probe ws_xyz 100001 512 10000
expect fail 'workspace that does not exist'         set synthetic-quota-probe ws_ffffffffffffffffffffffffffffffff 100001 512 10000
expect fail 'workspace that is a symlink to /etc'   set synthetic-quota-probe ws_00000000000000000000000000000000 100001 512 10000
expect fail 'project id below reserved range'       set synthetic-quota-probe "$WS" 424242 512 10000
expect fail 'project id 0'                          set synthetic-quota-probe "$WS" 0 512 10000
expect fail 'project id with shell characters'      set synthetic-quota-probe "$WS" '100001;id' 512 10000
expect fail 'size zero'                             set synthetic-quota-probe "$WS" 100001 0 10000
expect fail 'size too large'                        set synthetic-quota-probe "$WS" 100001 99999999 10000
expect fail 'leading-zero number'                   set synthetic-quota-probe "$WS" 100001 0512 10000
expect fail 'extra argument'                        set synthetic-quota-probe "$WS" 100001 512 10000 extra
expect fail 'unknown command'                       delete synthetic-quota-probe "$WS" 100001
expect fail 'no arguments'
echo "$pass passed, $fail failed"
[[ $fail == 0 ]]
