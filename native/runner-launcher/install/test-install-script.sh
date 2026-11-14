#!/bin/bash
# Unprivileged lifecycle test of install-runner-launcher.sh. NEVER needs or uses root: it runs a
# derived copy whose paths point into a temp dir, with id/stat/install/chown (root identity),
# getent (principals), runuser (account switch) and visudo (only `-c` of the whole config) replaced
# by recording stubs, and a stub launcher pinned by SHA-256. Fragments are still parsed by the
# host's real `visudo -c -f`. Root-ownership chain checks are stubbed out here (they are exercised
# by --dry-run and the real owner run).
# shellcheck disable=SC2016,SC2015  # stub bodies unexpanded; ok/bad chains are intentional
set -euo pipefail
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
src=$here/install-runner-launcher.sh
[[ $(id -u) != 0 ]] || { echo "refusing to run as root" >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/launcher-install-test.XXXXXX")
trap 'chmod -R u+rwX -- "$work" 2>/dev/null; rm -rf -- "$work"' EXIT
mkdir -p "$work/stub" "$work/install" "$work/sudoers.d" "$work/opt" "$work/var/lib" "$work/appsrc"
calls=$work/calls
me=$(id -un) uid=$(id -u) gid=$(id -g)
real_visudo=$(command -v visudo)

stub() { printf '#!/bin/bash\n%s\n' "$2" >"$work/stub/$1"; chmod 0755 "$work/stub/$1"; }
stub id '[[ $1 == -u ]] && { echo 0; exit 0; }; [[ "$1 $2" == "-G step-runner" ]] && { echo 983; exit 0; }; exec /usr/bin/id "$@"'
# Pretend everything is root-owned, except the socket root, which really is the caller's.
stub stat 'last=${!#}; a=(); for x in "$@"; do [[ $last != */sockets ]] && x=${x//%u/0}; a+=("$x"); done; exec /usr/bin/stat "${a[@]}"'
stub install 'a=(); while (($#)); do case $1 in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; exec /usr/bin/install "${a[@]}"'
stub chown 'echo "chown $*" >>'"$calls"
stub pgrep '[[ -e '"$work"'/processes-present ]] && { echo 12345; exit 0; }; exit 1'
stub getent 'case "$1 $2" in
"passwd '"$me"'") echo "'"$me"':x:'"$uid:$gid"'::/home:/bin/bash";;
"passwd step-runner") echo "step-runner:x:995:983::/:/usr/sbin/nologin";;
*) exit 2;; esac'
stub runuser '[[ $1 == -u && $3 == -- ]] || exit 99; echo "runuser $2 ${4##*/} ${*:5}" >>'"$calls"'; shift 3; exec "$@"'
stub visudo 'echo "visudo $*" >>'"$calls"'; if [[ $1 == -c && $# == 1 ]]; then [[ ! -e '"$work"'/visudo-fail ]]; exit; fi; exec '"$real_visudo"' "$@"'

printf '#!/bin/bash\nif (($# == 0)); then echo "step-runner-launch: REFUSED usage" >&2; else echo "step-runner-launch: REFUSED broker-root" >&2; fi\nexit 2\n' >"$work/install/launch"
chmod 0755 "$work/install/launch"
cp "$here/sudoers-step-runner-launch" "$work/install/sudoers-step-runner-launch"
printf 'fake node binary\n' >"$work/node-src"
printf '#!/bin/sh\n' >"$work/bwrap"; chmod 0755 "$work/bwrap"
launch_sum=$(sha256sum "$work/install/launch" | cut -d' ' -f1)
node_sum=$(sha256sum "$work/node-src" | cut -d' ' -f1)

# App source: required files plus mode/symlink oddities that must be normalised.
a=$work/appsrc
mkdir -p "$a/node_modules/tsx/dist" "$a/node_modules/.bin" "$a/harness" "$a/server/src/workspace" "$a/elsewhere"
echo loader >"$a/node_modules/tsx/dist/loader.mjs"; chmod 0600 "$a/node_modules/tsx/dist/loader.mjs"
echo register >"$a/server/src/register.mjs"; chmod 0666 "$a/server/src/register.mjs"
echo main >"$a/server/src/workspace/runtime-main.ts"
printf '#!/bin/sh\n' >"$a/node_modules/tsx/dist/cli.mjs"; chmod 0700 "$a/node_modules/tsx/dist/cli.mjs"
ln -s ../tsx/dist/cli.mjs "$a/node_modules/.bin/tsx"
echo '{}' >"$a/package.json"; echo '{}' >"$a/server/package.json"; echo h >"$a/harness/README"
echo secret >"$a/elsewhere/not-copied"
chmod 0777 "$a/harness"

derive() { # $1 = mismatch to break the launcher pin
    local l=$launch_sum
    [[ ${1:-} == mismatch ]] && l=$(printf '%064d' 1)
    sed -e "s|^readonly LAUNCH_SHA256=.*|readonly LAUNCH_SHA256=$l|" \
        -e "s|^readonly NODE_SHA256=.*|readonly NODE_SHA256=$node_sum|" \
        -e "s|^readonly INSTALL_DIR=.*|readonly INSTALL_DIR=$work/install|" \
        -e "s|^readonly SUDOERS_DIR=.*|readonly SUDOERS_DIR=$work/sudoers.d|" \
        -e "s|^readonly STEP_DIR=.*|readonly STEP_DIR=$work/opt/step|" \
        -e "s|^readonly SOCKET_PARENT=.*|readonly SOCKET_PARENT=$work/var/lib/step-runner-launch|" \
        -e "s|^readonly BWRAP=.*|readonly BWRAP=$work/bwrap|" \
        -e "s|^readonly GATEWAY_NAME=.*|readonly GATEWAY_NAME=$me GATEWAY_UID=$uid GATEWAY_GID=$gid|" \
        -e "s|^export PATH=.*|export PATH=$work/stub:/usr/sbin:/usr/bin:/sbin:/bin|" \
        -e 's|^trusted_chain() {$|trusted_chain() { return 0; }\ntrusted_chain_real() {|' \
        "$src" >"$work/install/install"
    chmod 0755 "$work/install/install"
}
fails=0 count=0
ok() { count=$((count + 1)); echo "ok - $1"; }
bad() { count=$((count + 1)); echo "not ok - $1"; fails=1; }
run() { : >"$calls"; set +e; "$work/install/install" "$@" >"$work/out" 2>&1; rc=$?; set -e; }
params=(--app-source "$a" --node-source "$work/node-src")
step=$work/opt/step
nothing_created() { [[ ! -e $step && ! -e $work/var/lib/step-runner-launch && ! -e $work/sudoers.d/step-runner-launch ]]; }
cp "$here/../../../spikes/057-step-runner-sudo/sudoers-step-runner" "$work/sudoers.d/step-runner"
derive

run --install --app-source "$a"
[[ $rc == 2 ]] && nothing_created && ok "install without --node-source is a usage error" || bad "usage ($rc)"
run --install --app-source relative --node-source "$work/node-src"
[[ $rc == 2 ]] && grep -q 'absolute' "$work/out" && nothing_created && ok "relative source refused" || bad "relative ($rc)"
run --revoke-bwrap
[[ $rc == 2 && -f $work/sudoers.d/step-runner ]] && grep -q 'run --install first' "$work/out" &&
    ok "revoke refused before the launcher rule exists (old rule kept)" || bad "early revoke ($rc)"

derive mismatch
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'launcher SHA-256' "$work/out" && nothing_created && ! grep -q '^runuser' "$calls" &&
    ok "launcher pin mismatch refuses before anything runs" || bad "launcher pin ($rc)"
derive

# Existing installation parents must not be taken over or followed by privileged writes.
mkdir -m 0777 "$step"
run --install "${params[@]}"
[[ $rc == 2 && ! -e $step/app && ! -e $step/node ]] && ! grep -q '^runuser' "$calls" &&
    ok "writable existing /opt/step refused before staging" || bad "writable destination ($rc)"
rm -rf -- "$step" "$work/var/lib/step-runner-launch" "$work/sudoers.d/step-runner-launch"
mkdir "$work/redirect"
ln -s "$work/redirect" "$step"
run --install "${params[@]}"
[[ $rc == 2 && ! -e $work/redirect/app && ! -e $work/redirect/node ]] && ! grep -q '^runuser' "$calls" &&
    ok "symlink /opt/step refused before staging" || bad "symlink destination ($rc)"
rm -- "$step"
rm -rf -- "$work/redirect" "$work/var/lib/step-runner-launch" "$work/sudoers.d/step-runner-launch"

cp "$work/node-src" "$work/node-good"; echo tampered >>"$work/node-src"
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'node SHA-256' "$work/out" && nothing_created && [[ -z $(ls -A "$work/install" | grep '^\.node') ]] &&
    ok "node pin mismatch refuses, nothing created, temp copy removed" || bad "node pin ($rc): $(cat "$work/out")"
mv "$work/node-good" "$work/node-src"

mv "$a/server/src/register.mjs" "$work/register.away"
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'missing .*register.mjs' "$work/out" && nothing_created &&
    ok "incomplete app source refused before any change" || bad "app source ($rc)"
mv "$work/register.away" "$a/server/src/register.mjs"

mkfifo "$a/harness/fifo"
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'special file: harness/fifo' "$work/out" && [[ ! -e $step/app && -z $(ls -A "$step" | grep '^\.app') ]] &&
    ok "special file in the app refused, staging dir removed" || bad "fifo ($rc): $(cat "$work/out")"
rm "$a/harness/fifo"
run --uninstall --purge
[[ $rc == 0 ]] && nothing_created && ok "partial install undone by --uninstall --purge" || bad "partial undo ($rc): $(cat "$work/out")"

echo 'bogus sudoers line' >"$work/install/sudoers-step-runner-launch"
sed -i "s|^readonly SUDOERS_SHA256=.*|readonly SUDOERS_SHA256=$(sha256sum "$work/install/sudoers-step-runner-launch" | cut -d' ' -f1)|" "$work/install/install"
run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'visudo rejected' "$work/out" && [[ ! -e $work/sudoers.d/step-runner-launch ]] &&
    [[ -z $(ls -A "$work/sudoers.d" | grep '^\.') ]] && ok "fragment rejected by real visudo -c -f is never installed" ||
    bad "bad fragment ($rc): $(cat "$work/out")"
cp "$here/sudoers-step-runner-launch" "$work/install/sudoers-step-runner-launch"
derive
run --uninstall --purge
[[ $rc == 0 ]] && nothing_created && ok "install that failed at the sudoers step is undone by --uninstall --purge" ||
    bad "sudoers-step undo ($rc): $(cat "$work/out")"

run --install "${params[@]}"
app=$step/app
if [[ $rc == 0 && $(/usr/bin/stat -c %a "$app/node_modules/tsx/dist/loader.mjs") == 644 &&
      $(/usr/bin/stat -c %a "$app/server/src/register.mjs") == 644 &&
      $(/usr/bin/stat -c %a "$app/node_modules/tsx/dist/cli.mjs") == 755 &&
      $(/usr/bin/stat -c %a "$app/harness") == 755 && -L $app/node_modules/.bin/tsx &&
      ! -e $app/elsewhere &&
      $(/usr/bin/stat -c %a "$step/node/bin/node") == 755 &&
      $(/usr/bin/stat -c '%u:%g %a' "$work/var/lib/step-runner-launch/sockets") == "$uid:$gid 711" &&
      $(/usr/bin/stat -c %a "$work/var/lib/step-runner-launch") == 755 &&
      $(/usr/bin/stat -c %a "$work/sudoers.d/step-runner-launch") == 440 &&
      -f $work/sudoers.d/step-runner ]] &&
   cmp -s "$step/node/bin/node" "$work/node-src" &&
   cmp -s "$work/sudoers.d/step-runner-launch" "$here/sudoers-step-runner-launch" &&
   grep -q "^visudo -c -f $work/sudoers.d/.step-runner-launch." "$calls" && grep -qx 'visudo -c' "$calls" &&
   grep -qx "runuser $me cat -- $work/node-src" "$calls" && grep -q "^runuser $me tar -C $a -cf -" "$calls" &&
   grep -qx 'runuser step-runner launch ' "$calls" &&
   grep -q '^runuser step-runner launch v1 p100000/' "$calls" && grep -q 'chown -R -h root:root' "$calls" &&
   ! grep -q '^runuser root' "$calls"; then
    ok "install: app/node staged and normalised, socket root, fragment checked, smoke as step-runner, old rule untouched"
else bad "install ($rc): $(cat "$work/out")"; fi

run --install "${params[@]}"
[[ $rc == 2 ]] && grep -q 'already exists' "$work/out" && ok "second install refused (fresh hosts only)" || bad "reinstall ($rc)"

echo '# edited by hand' >>"$work/sudoers.d/step-runner"
run --revoke-bwrap
[[ $rc == 2 && -f $work/sudoers.d/step-runner ]] && grep -q 'differs from the pinned' "$work/out" &&
    ok "revoke refuses an old rule that is not the pinned one" || bad "revoke unknown ($rc)"
cp "$here/../../../spikes/057-step-runner-sudo/sudoers-step-runner" "$work/sudoers.d/step-runner"

run --revoke-bwrap
[[ $rc == 0 && ! -e $work/sudoers.d/step-runner && -f $work/install/previous-step-runner.sudoers ]] &&
    [[ $(/usr/bin/stat -c %a "$work/install/previous-step-runner.sudoers") == 400 ]] && grep -qx 'visudo -c' "$calls" &&
    ok "revoke removes the any-arguments bwrap rule, keeps a 0400 copy" || bad "revoke ($rc): $(cat "$work/out")"
run --revoke-bwrap
[[ $rc == 0 ]] && grep -q 'nothing to revoke' "$work/out" && ok "revoke is idempotent" || bad "revoke twice ($rc)"

run --restore-bwrap
[[ $rc == 0 && -f $work/sudoers.d/step-runner && ! -e $work/install/previous-step-runner.sudoers ]] &&
    cmp -s "$work/sudoers.d/step-runner" "$here/../../../spikes/057-step-runner-sudo/sudoers-step-runner" &&
    grep -q "^visudo -c -f $work/sudoers.d/.step-runner-launch." "$calls" &&
    ok "restore-bwrap puts the old rule back (checked with visudo -c -f)" || bad "restore ($rc): $(cat "$work/out")"
run --revoke-bwrap

touch "$work/visudo-fail"
run --uninstall
[[ $rc == 2 ]] && grep -q 'visudo -c failed' "$work/out" && ok "uninstall reports a failing visudo -c" || bad "uninstall visudo ($rc)"
rm "$work/visudo-fail"
cp "$here/sudoers-step-runner-launch" "$work/sudoers.d/step-runner-launch"
run --uninstall
[[ $rc == 0 && ! -e $work/sudoers.d/step-runner-launch && ! -e $work/sudoers.d/step-runner && -d $app ]] &&
    grep -q 'fail closed' "$work/out" && ok "uninstall removes the launcher rule, never re-adds the bwrap rule, keeps the app" ||
    bad "uninstall ($rc): $(cat "$work/out")"
cp "$here/sudoers-step-runner-launch" "$work/sudoers.d/step-runner-launch"
touch "$work/processes-present"
run --uninstall --purge
[[ $rc == 2 && -f $app/server/src/register.mjs && -f $step/node/bin/node && -f $work/sudoers.d/step-runner-launch ]] &&
    grep -q 'processes still present' "$work/out" && ok "purge refuses live principals before any removal" || bad "purge live processes ($rc)"
rm "$work/processes-present"
mkdir "$work/var/lib/step-runner-launch/sockets/0011"
run --uninstall --purge
[[ $rc == 2 && -d $work/var/lib/step-runner-launch/sockets/0011 && -f $app/server/src/register.mjs && -f $step/node/bin/node && -f $work/sudoers.d/step-runner-launch ]] &&
    cmp -s "$step/node/bin/node" "$work/node-src" && cmp -s "$app/server/src/register.mjs" "$a/server/src/register.mjs" && grep -q 'not empty' "$work/out" &&
    ok "busy purge preserves app, node and socket root" || bad "purge busy preservation ($rc)"
rmdir "$work/var/lib/step-runner-launch/sockets/0011"
echo unexpected >"$work/var/lib/step-runner-launch/keep"
run --uninstall --purge
[[ $rc == 2 && -f $app/server/src/register.mjs && -f $step/node/bin/node && -f $work/sudoers.d/step-runner-launch && -d $work/var/lib/step-runner-launch/sockets ]] &&
    grep -q 'unexpected entries' "$work/out" && ok "unexpected socket-parent entry preserves the whole install" || bad "purge unexpected entry ($rc)"
rm "$work/var/lib/step-runner-launch/keep"
run --uninstall --purge
[[ $rc == 0 && ! -e $step && ! -e $work/var/lib/step-runner-launch ]] && ok "purge removes app, node and socket root" ||
    bad "purge ($rc): $(cat "$work/out")"

set +e; bash "$src" --install "${params[@]}" >"$work/out" 2>&1; rc=$?; set -e
[[ $rc == 2 ]] && grep -q 'must run as root' "$work/out" && ok "unprivileged real run refused" || bad "unprivileged ($rc)"
set +e; bash "$src" --dry-run "${params[@]}" >"$work/out" 2>&1; rc=$?; set -e
[[ $rc == 0 ]] && grep -q 'DRY RUN' "$work/out" && ok "dry run without privilege" || bad "dry run ($rc)"
echo "$count checks, $fails failed"
exit "$fails"
