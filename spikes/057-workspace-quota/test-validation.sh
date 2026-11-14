#!/bin/bash
# Nonprivileged regression: the retired helper must refuse without touching host storage.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
for op in set clear report unknown; do
  rc=0
  output=$(bash "$HERE/step-workspace-quota" "$op" 2>&1) || rc=$?
  [[ $rc == 2 && $output == DISABLED_UNSAFE_QUOTA_HELPER:* ]] || exit 1
  printf 'PASS retired helper refuses %s\n' "$op"
done
