#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   N=10000 ITERS=5 ./bench/bench.sh
#
# Notes:
# - Generates JSONL once into a temp file, then replays it into each consumer.
# - Consumers print a JSON line: {"impl":"ts|native","count":...,"ms":...}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${N:-10000}"
ITERS="${ITERS:-5}"

TMP="$(mktemp -t json-native-parser-bench.XXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "generating N=$N lines into $TMP ..."
i=0
while [ "$i" -lt "$N" ]; do
  i=$((i+1))
  printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\n' "$i" "$i"
done > "$TMP"

run_consumer () {
  local impl="$1"
  local file="$2"
  local out
  out="$(node "$file" < "$TMP" | tail -n 1)"
  echo "$out"
}

avg_ms () {
  # reads ms numbers from stdin
  awk '{sum+=$1} END { if (NR==0) {print 0} else {printf "%.2f", sum/NR} }'
}

echo
echo "TS parser:"
ts_ms=()
run_consumer ts "$ROOT/bench/js-consumer.mjs" > /dev/null  # warmup
for i in $(seq 1 "$ITERS"); do
  out="$(run_consumer ts "$ROOT/bench/js-consumer.mjs")"
  ms="$(node -p "JSON.parse(process.argv[1]).ms" "$out")"
  count="$(node -p "JSON.parse(process.argv[1]).count" "$out")"
  echo "  iter $i/$ITERS: ${ms} ms (count=$count)"
  ts_ms+=("$ms")
done

echo
echo "Native parser:"
native_ms=()
run_consumer native "$ROOT/bench/native-consumer.mjs" > /dev/null  # warmup
for i in $(seq 1 "$ITERS"); do
  out="$(run_consumer native "$ROOT/bench/native-consumer.mjs")"
  ms="$(node -p "JSON.parse(process.argv[1]).ms" "$out")"
  count="$(node -p "JSON.parse(process.argv[1]).count" "$out")"
  echo "  iter $i/$ITERS: ${ms} ms (count=$count)"
  native_ms+=("$ms")
done

echo
echo "Worker parser:"
worker_ms=()
run_consumer worker "$ROOT/bench/worker-consumer.mjs" > /dev/null  # warmup
for i in $(seq 1 "$ITERS"); do
  out="$(run_consumer worker "$ROOT/bench/worker-consumer.mjs")"
  ms="$(node -p "JSON.parse(process.argv[1]).ms" "$out")"
  count="$(node -p "JSON.parse(process.argv[1]).count" "$out")"
  echo "  iter $i/$ITERS: ${ms} ms (count=$count)"
  worker_ms+=("$ms")
done

ts_avg="$(printf "%s\n" "${ts_ms[@]}" | avg_ms)"
native_avg="$(printf "%s\n" "${native_ms[@]}" | avg_ms)"
worker_avg="$(printf "%s\n" "${worker_ms[@]}" | avg_ms)"
speedup="$(node -p "(Number(process.argv[1]) / Number(process.argv[2])).toFixed(2)" "$ts_avg" "$native_avg")"
worker_speedup="$(node -p "(Number(process.argv[1]) / Number(process.argv[2])).toFixed(2)" "$ts_avg" "$worker_avg")"

echo
echo "N=$N, ITERS=$ITERS"
echo "ts avg:     $ts_avg ms"
echo "native avg: $native_avg ms"
echo "native speedup: ${speedup}x (higher is better)"
echo "worker avg: $worker_avg ms"
echo "worker speedup: ${worker_speedup}x (higher is better)"


