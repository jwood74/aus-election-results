#!/bin/bash
#
# Election Night Feed Fetcher
#
# Downloads the latest AEC media feed zip via FTP, extracts the XML,
# and uploads it to the Cloudflare Worker. Runs in a loop with a
# configurable interval.
#
# Usage:
#   ./scripts/fetch-and-upload.sh                    # defaults: election 31496, 60s interval
#   ./scripts/fetch-and-upload.sh 31496 30           # election 31496, 30s interval
#   ./scripts/fetch-and-upload.sh 31496 60 once      # single run, no loop
#
# Requires:
#   - AEC_WORKER_UPLOAD_SECRET env var (or will prompt)
#   - curl, unzip
#

set -euo pipefail

ELECTION_ID="${1:-31496}"
INTERVAL="${2:-60}"
MODE="${3:-loop}"  # "loop" or "once"

WORKER_URL="https://aec-election-feed.jwood748787.workers.dev"
FTP_DIR="ftp://mediafeedarchive.aec.gov.au/${ELECTION_ID}/Detailed/Verbose/"

# Temp directory — cleaned up on exit
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Check for upload secret
if [ -z "${AEC_WORKER_UPLOAD_SECRET:-}" ]; then
  echo -n "Enter upload secret: "
  read -rs AEC_WORKER_UPLOAD_SECRET
  echo
  export AEC_WORKER_UPLOAD_SECRET
fi

LAST_FILE=""

fetch_and_upload() {
  local timestamp
  timestamp=$(date '+%H:%M:%S')

  # 1. List FTP directory and find latest zip
  local latest
  latest=$(curl -fL --retry 3 --retry-delay 5 --silent --list-only "${FTP_DIR}" 2>/dev/null | grep '\.zip$' | sort | tail -1)

  if [ -z "$latest" ]; then
    echo "[$timestamp] No zip file found on FTP server"
    return 1
  fi

  # Skip if same file as last run
  if [ "$latest" = "$LAST_FILE" ]; then
    echo "[$timestamp] No new file (still $latest)"
    return 0
  fi

  echo "[$timestamp] New file: $latest — downloading..."

  # 2. Download zip
  curl -fL --retry 3 --retry-delay 5 --silent --output "$WORK_DIR/feed.zip" "${FTP_DIR}${latest}"

  # 3. Extract XML
  rm -rf "$WORK_DIR/extracted"
  mkdir -p "$WORK_DIR/extracted"
  unzip -j -o "$WORK_DIR/feed.zip" "xml/*.xml" -d "$WORK_DIR/extracted/" > /dev/null 2>&1

  local xml_file
  xml_file=$(ls "$WORK_DIR/extracted/"*.xml 2>/dev/null | head -1)
  if [ -z "$xml_file" ]; then
    echo "[$timestamp] No XML found in zip"
    return 1
  fi

  local size
  size=$(wc -c < "$xml_file" | tr -d ' ')
  echo "[$timestamp] Extracted $(basename "$xml_file") (${size} bytes) — uploading..."

  # 4. Upload to Worker
  local http_status
  http_status=$(curl -s -o "$WORK_DIR/response.json" -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${AEC_WORKER_UPLOAD_SECRET}" \
    -H "Content-Type: application/xml" \
    --data-binary "@${xml_file}" \
    "${WORKER_URL}/upload/${ELECTION_ID}")

  if [ "$http_status" = "200" ]; then
    echo "[$timestamp] Upload OK — $(cat "$WORK_DIR/response.json")"
    LAST_FILE="$latest"
  else
    echo "[$timestamp] Upload FAILED (HTTP $http_status) — $(cat "$WORK_DIR/response.json")"
    return 1
  fi
}

echo "=== AEC Feed Fetcher ==="
echo "Election: $ELECTION_ID"
echo "FTP:      $FTP_DIR"
echo "Worker:   $WORKER_URL"
echo "Interval: ${INTERVAL}s"
echo "Mode:     $MODE"
echo ""

if [ "$MODE" = "once" ]; then
  fetch_and_upload
else
  echo "Starting loop (Ctrl+C to stop)..."
  echo ""
  while true; do
    fetch_and_upload || true
    sleep "$INTERVAL"
  done
fi
