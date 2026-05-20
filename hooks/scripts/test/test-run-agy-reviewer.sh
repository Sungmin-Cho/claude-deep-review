#!/usr/bin/env bash
set -Eeuo pipefail
BRIDGE="$(cd "$(dirname "$0")/.." && pwd)/run-agy-reviewer.sh"
[ -f "$BRIDGE" ] || { echo "FAIL: bridge not found at $BRIDGE"; exit 1; }
[ -x "$BRIDGE" ] || { echo "FAIL: bridge not executable"; exit 1; }
echo "PASS: bridge exists + executable"
