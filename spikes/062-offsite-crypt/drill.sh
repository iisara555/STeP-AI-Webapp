#!/usr/bin/env bash
# Synthetic-only rehearsal of encrypted offsite backup with rclone crypt.
# A local directory stands in for Google Drive. Throwaway synthetic keys only.
set -euo pipefail
RCLONE=~/.local/bin/rclone
SRC=$(ls -d /mnt/step-backup/step-ai/synthetic-cross-user-* | head -1)
[ -d "$SRC" ] || { echo "no synthetic backup found"; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rclone-crypt-drill-XXXXXX"); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
export RCLONE_CONFIG="$WORK/empty.conf"; : > "$RCLONE_CONFIG"
export RCLONE_CONFIG_FAKEDRIVE_TYPE=local
export RCLONE_CONFIG_SEC_TYPE=crypt
export RCLONE_CONFIG_SEC_REMOTE="fakedrive:$WORK/drive/step-backup"
export RCLONE_CONFIG_SEC_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_SEC_PASSWORD=$($RCLONE obscure "synthetic-drill-key-$(date +%s%N)")
export RCLONE_CONFIG_SEC_PASSWORD2=$($RCLONE obscure "synthetic-drill-salt-$RANDOM$RANDOM")

echo "source: $SRC"
$RCLONE copy "$SRC" sec:snap1 --quiet
echo "PASS uploaded $(find "$WORK/drive" -type f | wc -l) encrypted files"

# 1. Nothing readable at rest: no original file names and no plaintext content.
if find "$WORK/drive" | grep -Eq 'manifest|database|objects|\.txt|\.sql|\.json'; then echo "FAIL plaintext names"; exit 1; fi
if grep -rqa -e 'synthetic' -e 'CREATE TABLE' "$WORK/drive"; then echo "FAIL plaintext content"; exit 1; fi
echo "PASS no original names or plaintext content in stored copy"

# 2. rclone's own integrity check against the source.
$RCLONE cryptcheck "$SRC" sec:snap1 --quiet && echo "PASS cryptcheck matches source"

# 3. Restore and compare every byte independently.
$RCLONE copy sec:snap1 "$WORK/restore" --quiet
(cd "$SRC" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$WORK/a"
(cd "$WORK/restore" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$WORK/b"
diff -q "$WORK/a" "$WORK/b" >/dev/null && echo "PASS restored $(wc -l < "$WORK/a") files, SHA-256 identical"

# 4. Wrong key cannot read the backup.
GOOD=$RCLONE_CONFIG_SEC_PASSWORD
export RCLONE_CONFIG_SEC_PASSWORD=$($RCLONE obscure "wrong-key")
if $RCLONE copy sec:snap1 "$WORK/wrong" --quiet 2>/dev/null && [ -n "$(find "$WORK/wrong" -type f 2>/dev/null)" ]; then
  echo "FAIL wrong key restored files"; exit 1; fi
echo "PASS wrong key restores nothing"
export RCLONE_CONFIG_SEC_PASSWORD=$GOOD

# 5. Tampering with stored ciphertext is detected on restore.
victim=$(find "$WORK/drive" -type f -size +100c | head -1)
python3 - "$victim" <<'EOF'
import sys
p = sys.argv[1]; b = bytearray(open(p, 'rb').read()); b[-20] ^= 1; open(p, 'wb').write(b)
EOF
if $RCLONE copy sec:snap1 "$WORK/tampered" --quiet 2>"$WORK/tamper.err"; then echo "FAIL tampering not detected"; exit 1; fi
echo "PASS tampered file rejected: $(grep -o 'failed to authenticate[^\"]*' "$WORK/tamper.err" | head -1)"
echo "ALL PASS (synthetic only; local folder stood in for Google Drive)"
