#!/usr/bin/env bash
# Explicit host-side model setup; never invoked by bot startup or a model tool.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "Usage: bash $0 HOST_MODEL_DIRECTORY" >&2
  exit 2
fi
for program in curl python3; do
  command -v "$program" >/dev/null || { echo "Missing program: $program" >&2; exit 1; }
done
mkdir -p -- "$1"
model_root=$(cd -- "$1" && pwd)
model_name=sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
release=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
staging=$(mktemp -d "$model_root/.audio-download.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT

verify_model() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
required = ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx']
if not all((root / name).is_file() and (root / name).stat().st_size for name in required):
    raise SystemExit(1)
if not (root / 'tokenizer').is_dir() or not any(p.is_file() and p.stat().st_size for p in (root / 'tokenizer').rglob('*')):
    raise SystemExit(1)
PY
}

if verify_model "$model_root/$model_name"; then
  echo 'Qwen model files already present; skipping download.'
else
  if [ -e "$model_root/$model_name" ]; then
    echo 'An incomplete model directory already exists; refusing to overwrite it.' >&2
    exit 1
  fi
  archive="$model_root/.$model_name.tar.bz2.part"
  echo 'Downloading Qwen INT8 model. Partial downloads are retained for resume.'
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 15 --continue-at - \
    --output "$archive" "$release/$model_name.tar.bz2"
  python3 - "$archive" "$staging" "$model_name" <<'PY'
import sys
import tarfile
archive, destination, expected = sys.argv[1:]
with tarfile.open(archive, 'r:bz2') as package:
    for member in package:
        if member.name.rstrip('/') != expected and not member.name.startswith(expected + '/'):
            raise SystemExit('Unexpected archive root; extraction stopped.')
        if member.issym() or member.islnk():
            raise SystemExit('Unexpected archive link; extraction stopped.')
        package.extract(member, destination, filter='data')
PY
  verify_model "$staging/$model_name"
  mv -- "$staging/$model_name" "$model_root/$model_name"
  rm -- "$archive"
fi

if [ -s "$model_root/silero_vad.onnx" ]; then
  echo 'Silero VAD file already present; skipping download.'
else
  echo 'Downloading Silero VAD.'
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 15 --continue-at - \
    --output "$model_root/.silero_vad.onnx.part" "$release/silero_vad.onnx"
  test -s "$model_root/.silero_vad.onnx.part"
  mv -- "$model_root/.silero_vad.onnx.part" "$model_root/silero_vad.onnx"
fi

echo "Model files prepared in $model_root"
echo 'No inference test or service restart was performed.'
