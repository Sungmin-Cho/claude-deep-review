#!/usr/bin/env bash
# run-all-tests.sh — thin-dispatcher 리팩토링 수락 게이트(스펙 §8).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
echo "=== npm test (node) ==="
npm test || fail=1
echo "=== bash structural tests ==="
for t in hooks/scripts/test/test-*.sh; do
  case "$(basename "$t")" in
    test-helpers.sh) echo "--- skip (sourced helper, no standalone main): $t ---"; continue ;;
  esac
  echo "--- $t ---"
  bash "$t" || fail=1
done
if [ "$fail" -ne 0 ]; then echo "SUITE: FAIL"; exit 1; fi
echo "SUITE: PASS"
