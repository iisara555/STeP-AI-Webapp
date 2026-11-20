#!/bin/sh
# Downloads Typhoon OCR V2 0.8B (Apache-2.0) into a folder mounted read-only into the OCR service.
# Usage: deploy/homelab/ocr/fetch-models.sh <folder>   (about 1 GB; verified by size and SHA-256)
set -eu
dir=${1:?Give the folder for the model files}
revision=d4ef0407f699f9e318c95cc312cae69420fb7fb4
base="https://huggingface.co/typhoon-ai/typhoon-ocr2-0.8b-GGUF/resolve/$revision"
mkdir -p "$dir"
fetch() {
  name=$1 sha=$2
  if [ -f "$dir/$name" ] && echo "$sha  $dir/$name" | sha256sum -c - >/dev/null 2>&1; then
    echo "$name already verified"
    return
  fi
  curl -fL --retry 3 -o "$dir/$name.part" "$base/$name"
  echo "$sha  $dir/$name.part" | sha256sum -c -
  mv "$dir/$name.part" "$dir/$name"
}
fetch typhoon-ocr2-0.8b-Q8_0.gguf 10d111b1558a0d51aaa7350e0dc65d66fe28ae27e9a03ddc9215ecb9baed3a84
fetch mmproj-typhoon-ocr2-0.8b-f16.gguf 23edf37c46101bb3931662c03d6375206b11a2b6a3dc0d61390ac9f020cd87a5
