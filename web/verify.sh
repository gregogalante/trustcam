#!/usr/bin/env bash
# TrustCam command-line verifier.
#
#   bash verify.sh photo.jpg           # local hash + registry lookup (file never uploaded)
#   bash verify.sh --scan video.mp4    # also upload for the invisible-mark scan if no exact match
#
# The file is hashed locally; only the fingerprint is sent. With --scan, the
# file is uploaded (and never stored) so the pixels can be scanned for the mark.
set -euo pipefail

BASE="${TRUSTCAM_URL:-https://trustcam.gregoriogalante.com}"
SCAN=0
[ "${1:-}" = "--scan" ] && { SCAN=1; shift; }
FILE="${1:-}"
[ -f "$FILE" ] || { echo "usage: verify.sh [--scan] <photo-or-video>" >&2; exit 2; }

if command -v sha256sum > /dev/null; then
  HASH=$(sha256sum "$FILE" | cut -d' ' -f1)
else
  HASH=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
fi

echo "fingerprint: $HASH" >&2
RES=$(curl -sf "$BASE/api/verify/hash/$HASH")

if echo "$RES" | grep -q '"found":true'; then
  echo "$RES"
  exit 0
fi

if [ "$SCAN" = 1 ]; then
  echo "no exact match — uploading for the invisible-mark scan (can take a while for video)…" >&2
  curl -sf -F "file=@$FILE" "$BASE/api/verify"
  echo
else
  echo "$RES"
  echo "no exact match. Re-run with --scan to upload the file and scan for the invisible mark." >&2
  exit 1
fi
