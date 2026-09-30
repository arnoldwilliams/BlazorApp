#!/usr/bin/env bash
# Downloads the piper narration engine and the voice models the server offers.
#
# The binaries are large and platform specific, so they are not committed; this script
# materialises them under TtsServer/engines/piper, which is where PiperEngine looks.
#
# Usage:
#   scripts/setup-voices.sh              # engine plus every voice in the catalog
#   scripts/setup-voices.sh en_US-lessac-medium de_DE-thorsten-medium
#
# Re-running is safe: anything already downloaded is skipped.

set -uo pipefail

PIPER_VERSION="2023.11.14-2"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENGINE_DIR="${ROOT}/engines/piper"
VOICE_DIR="${ENGINE_DIR}/voices"

# id|path under the voice repository
CATALOG=(
  "en_US-lessac-medium|en/en_US/lessac/medium"
  "en_US-amy-medium|en/en_US/amy/medium"
  "en_US-ryan-medium|en/en_US/ryan/medium"
  "en_GB-alba-medium|en/en_GB/alba/medium"
  "en_GB-alan-medium|en/en_GB/alan/medium"
  "de_DE-thorsten-medium|de/de_DE/thorsten/medium"
  "es_ES-davefx-medium|es/es_ES/davefx/medium"
  "fr_FR-siwis-medium|fr/fr_FR/siwis/medium"
)

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="piper_linux_x86_64.tar.gz" ;;
  Linux-aarch64) ASSET="piper_linux_aarch64.tar.gz" ;;
  Linux-armv7l)  ASSET="piper_linux_armv7l.tar.gz" ;;
  Darwin-arm64)  ASSET="piper_macos_aarch64.tar.gz" ;;
  Darwin-x86_64) ASSET="piper_macos_x64.tar.gz" ;;
  *)
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    echo "Download piper manually into ${ENGINE_DIR}." >&2
    exit 1
    ;;
esac

if [ -x "${ENGINE_DIR}/piper" ]; then
  echo "Engine already present at ${ENGINE_DIR}/piper"
else
  echo "Downloading piper ${PIPER_VERSION} (${ASSET})..."
  mkdir -p "${ENGINE_DIR}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  url="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${ASSET}"
  if ! curl -fsSL --retry 3 -o "${tmp}/piper.tar.gz" "${url}"; then
    echo "Could not download ${url}" >&2
    exit 1
  fi

  tar xzf "${tmp}/piper.tar.gz" -C "${tmp}"
  # The archive contains a top level "piper" directory.
  cp -a "${tmp}/piper/." "${ENGINE_DIR}/"
  chmod +x "${ENGINE_DIR}/piper"
  echo "Installed engine at ${ENGINE_DIR}"
fi

mkdir -p "${VOICE_DIR}"

# Default to the whole catalog when no ids are given.
if [ "$#" -gt 0 ]; then
  wanted=("$@")
else
  wanted=()
  for entry in "${CATALOG[@]}"; do
    wanted+=("${entry%%|*}")
  done
fi

for id in "${wanted[@]}"; do
  path=""
  for entry in "${CATALOG[@]}"; do
    if [ "${entry%%|*}" = "${id}" ]; then
      path="${entry#*|}"
      break
    fi
  done

  if [ -z "${path}" ]; then
    echo "Skipping unknown voice: ${id}" >&2
    continue
  fi

  model="${VOICE_DIR}/${id}.onnx"
  config="${VOICE_DIR}/${id}.onnx.json"

  if [ -f "${model}" ] && [ -f "${config}" ]; then
    echo "Voice already present: ${id}"
    continue
  fi

  echo "Downloading voice ${id}..."
  if ! curl -fsSL --retry 3 -o "${model}.part" "${VOICE_BASE}/${path}/${id}.onnx"; then
    echo "Could not download model for ${id}" >&2
    rm -f "${model}.part"
    continue
  fi
  mv "${model}.part" "${model}"

  if ! curl -fsSL --retry 3 -o "${config}.part" "${VOICE_BASE}/${path}/${id}.onnx.json"; then
    echo "Could not download config for ${id}" >&2
    rm -f "${config}.part" "${model}"
    continue
  fi
  mv "${config}.part" "${config}"

  echo "Installed ${id}"
done

echo
echo "Done. Voices available to the server:"
ls -1 "${VOICE_DIR}"/*.onnx 2>/dev/null | sed 's#.*/##; s#\.onnx$##' | sed 's/^/  /' || echo "  (none)"
