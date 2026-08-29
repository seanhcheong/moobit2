#!/usr/bin/env bash
#
# Downloads the MediaPipe Pose Landmarker model into both platform bundles.
#
# The .task files are ~5.5 MB (lite) / ~9 MB (full) binaries and are deliberately
# NOT committed to git (see .gitignore). Run this once after cloning, and again
# whenever you want to A/B the `full` model against `lite`.
#
#   ./scripts/download-model.sh          # lite (default — the one we ship)
#   ./scripts/download-model.sh full     # also fetch full, for benchmarking
#
set -euo pipefail

VARIANT="${1:-lite}"
case "$VARIANT" in
  lite|full|heavy) ;;
  *) echo "usage: $0 [lite|full|heavy]" >&2; exit 2 ;;
esac

MODEL="pose_landmarker_${VARIANT}.task"
URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${VARIANT}/float16/latest/${MODEL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android/app/src/main/assets"
IOS_DIR="$ROOT/ios/MoobitRecog"

mkdir -p "$ANDROID_DIR" "$IOS_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $MODEL ..."
echo "  from $URL"
curl -fSL --retry 4 --retry-delay 2 -o "$TMP/$MODEL" "$URL"

BYTES=$(wc -c < "$TMP/$MODEL" | tr -d ' ')
if [ "$BYTES" -lt 1000000 ]; then
  echo "ERROR: downloaded file is only ${BYTES} bytes — that is not a model." >&2
  exit 1
fi

cp "$TMP/$MODEL" "$ANDROID_DIR/$MODEL"
cp "$TMP/$MODEL" "$IOS_DIR/$MODEL"

echo
echo "OK — ${BYTES} bytes written to:"
echo "  $ANDROID_DIR/$MODEL"
echo "  $IOS_DIR/$MODEL"
echo
echo "Android picks this up automatically from src/main/assets."
echo
echo "iOS REQUIRES ONE MANUAL STEP the first time:"
echo "  open ios/MoobitRecog.xcodeproj, drag ${MODEL} into the MoobitRecog target,"
echo "  and confirm it appears under Build Phases > Copy Bundle Resources."
echo "  (Xcode does not pick up files added on disk on its own.)"
