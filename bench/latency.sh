#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   N=100000 INTERVAL_MS=10 YIELD_EVERY=1024 ./bench/latency.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${N:-100000}"
INTERVAL_MS="${INTERVAL_MS:-10}"
YIELD_EVERY="${YIELD_EVERY:-1024}"

TMP="$(mktemp -t json-native-parser-latency.XXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "generating N=$N lines into $TMP ..."
i=0
while [ "$i" -lt "$N" ]; do
  i=$((i+1))
  printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\n' "$i" "$i"
done > "$TMP"

echo
echo "TS latency:"
INTERVAL_MS="$INTERVAL_MS" node "$ROOT/bench/latency-ts.mjs" < "$TMP" | tail -n 1

echo
echo "Native latency (yieldEvery=$YIELD_EVERY):"
INTERVAL_MS="$INTERVAL_MS" YIELD_EVERY="$YIELD_EVERY" node "$ROOT/bench/latency-native.mjs" < "$TMP" | tail -n 1


