#!/bin/bash
# Unprivileged validation of the system unit: systemd-analyze verify (in a scratch --root that
# contains the unit, the broker binary at its ExecStart path and a copy of the host's unit
# directory) and systemd-analyze security --offline with an exposure threshold.
set -euo pipefail
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
unit=$here/step-quota-broker.service
binary=${1:-$here/../step-quota-broker}
threshold=${2:-20} # integer: exposure x 10 (20 = 2.0)
[[ $(id -u) != 0 ]] || { echo "refusing to run as root" >&2; exit 2; }
[[ -x $binary ]] || { echo "build the binary first: make -C native/quota-broker service" >&2; exit 2; }
root=$(mktemp -d "${TMPDIR:-/tmp}/unit-verify.XXXXXX")
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/usr/local/libexec/step-quota-broker" "$root/etc/systemd/system" "$root/usr/lib/systemd"
cp -- "$binary" "$root/usr/local/libexec/step-quota-broker/step-quota-broker"
cp -- "$unit" "$root/etc/systemd/system/"
cp -a /usr/lib/systemd/system "$root/usr/lib/systemd/"
set +e
out=$(systemd-analyze verify --root="$root" "$root/etc/systemd/system/step-quota-broker.service" 2>&1)
rc=$?
set -e
# Unrelated host units (dangling dracut links) may warn; anything about ours is a failure.
ours=$(grep -i 'step-quota-broker' <<<"$out" || true)
if (( rc != 0 )) || [[ -n $ours ]]; then echo "verify FAILED (rc=$rc):"; echo "$out"; exit 1; fi
echo "systemd-analyze verify: ok (no diagnostics for step-quota-broker.service)"
summary=$(systemd-analyze security --offline=yes --root="$root" --threshold="$threshold" \
    step-quota-broker.service 2>&1) || { echo "$summary"; echo "security exposure above $threshold"; exit 1; }
grep -E '^→ Overall exposure level' <<<"$summary"
grep -E '^✗' <<<"$summary" | sed 's/  */ /g'
