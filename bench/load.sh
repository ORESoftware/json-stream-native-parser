#!/usr/bin/env bash
set -euo pipefail

# Compare TS vs native under main-thread load (e.g. LOAD=0.5 means ~50% busy-wait).
#
# Usage:
#   N=100000 LOAD=0.5 ITERS=3 YIELD_EVERY=1024 ./bench/load.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${N:-100000}"
LOAD="${LOAD:-0.5}"
ITERS="${ITERS:-3}"
YIELD_EVERY="${YIELD_EVERY:-1024}"
INTERVAL_MS="${INTERVAL_MS:-10}"
LOAD_PERIOD_MS="${LOAD_PERIOD_MS:-20}"

TMP="$(mktemp -t json-native-parser-load.XXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "generating N=$N lines into $TMP ..."
i=0
while [ "$i" -lt "$N" ]; do
  i=$((i+1))
  printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\n' "$i" "$i"
done > "$TMP"

run_consumer () {
  local file="$1"
  LOAD="$LOAD" ITERS="$ITERS" YIELD_EVERY="$YIELD_EVERY" INTERVAL_MS="$INTERVAL_MS" LOAD_PERIOD_MS="$LOAD_PERIOD_MS" \
    node "$file" < "$TMP" | tail -n 1
}

avg_ms () { awk '{sum+=$1} END { if (NR==0) {print 0} else {printf "%.2f", sum/NR} }'; }

echo
echo "TS under load (LOAD=$LOAD):"
ts_ms=()
ts_lag=()
for i in $(seq 1 "$ITERS"); do
  out="$(run_consumer "$ROOT/bench/load-consumer-ts.mjs")"
  ms="$(node -p "JSON.parse(process.argv[1]).ms" "$out")"
  lag="$(node -p "JSON.parse(process.argv[1]).maxLagMs" "$out")"
  count="$(node -p "JSON.parse(process.argv[1]).count" "$out")"
  echo "  iter $i/$ITERS: ${ms} ms (count=$count, maxLagMs=$lag)"
  ts_ms+=("$ms")
  ts_lag+=("$lag")
done

echo
echo "Native under load (LOAD=$LOAD, yieldEvery=$YIELD_EVERY):"
native_ms=()
native_lag=()
for i in $(seq 1 "$ITERS"); do
  out="$(run_consumer "$ROOT/bench/load-consumer-native.mjs")"
  ms="$(node -p "JSON.parse(process.argv[1]).ms" "$out")"
  lag="$(node -p "JSON.parse(process.argv[1]).maxLagMs" "$out")"
  count="$(node -p "JSON.parse(process.argv[1]).count" "$out")"
  echo "  iter $i/$ITERS: ${ms} ms (count=$count, maxLagMs=$lag)"
  native_ms+=("$ms")
  native_lag+=("$lag")
done

ts_avg="$(printf "%s\n" "${ts_ms[@]}" | avg_ms)"
native_avg="$(printf "%s\n" "${native_ms[@]}" | avg_ms)"
ts_lag_avg="$(printf "%s\n" "${ts_lag[@]}" | avg_ms)"
native_lag_avg="$(printf "%s\n" "${native_lag[@]}" | avg_ms)"
speedup="$(node -p "(Number(process.argv[1]) / Number(process.argv[2])).toFixed(2)" "$ts_avg" "$native_avg")"

echo
echo "N=$N, ITERS=$ITERS, LOAD=$LOAD"
echo "ts avg ms:         $ts_avg"
echo "native avg ms:     $native_avg"
echo "throughput speed:  ${speedup}x (higher is better)"
echo "ts avg maxLagMs:   $ts_lag_avg"
echo "native avg maxLagMs: $native_lag_avg"


