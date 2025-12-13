#!/usr/bin/env node
'use strict';

import {createJsonParserNativeFromFd} from '../dist/main.js';

const load = Number(process.env.LOAD || 0.5); // fraction of time to busy-wait in each period
const periodMs = Number(process.env.LOAD_PERIOD_MS || 20);
const intervalMs = Number(process.env.INTERVAL_MS || 10);
const yieldEvery = Number(process.env.YIELD_EVERY || 1024);
const batchSize = Number(process.env.BATCH_SIZE || 256);
// 1 => native emits Buffers (JS JSON.parse), 0 => native emits POJOs (C++ parse + N-API)
const passRawBuffers = (process.env.PASS_RAW_BUFFERS ?? '1') !== '0';

function busyWait(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.floor(ms * 1e6));
  while (process.hrtime.bigint() < end) {}
}

let maxLagMs = 0;
let ticks = 0;
let last = process.hrtime.bigint();
const lagTimer = setInterval(() => {
  const now = process.hrtime.bigint();
  const dtMs = Number(now - last) / 1e6;
  const lag = Math.max(0, dtMs - intervalMs);
  if (lag > maxLagMs) maxLagMs = lag;
  last = now;
  ticks++;
}, intervalMs);

// main-thread "50% utilized" simulation
const busyMs = Math.max(0, Math.min(periodMs, periodMs * load));
const loadTimer = setInterval(() => {
  if (busyMs > 0) busyWait(busyMs);
}, periodMs);

const t0 = process.hrtime.bigint();
let count = 0;

const s = createJsonParserNativeFromFd(0, {
  delimiter: '\n',
  batchSize,
  passRawBuffers,
  yieldEvery
});

s.on('data', () => count++);
s.on('error', (err) => {
  clearInterval(loadTimer);
  clearInterval(lagTimer);
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
s.on('end', () => {
  clearInterval(loadTimer);
  clearInterval(lagTimer);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(JSON.stringify({
    impl: passRawBuffers ? 'native-buf' : 'native-cpp',
    count,
    ms,
    load,
    periodMs,
    intervalMs,
    ticks,
    maxLagMs,
    yieldEvery,
    batchSize,
    passRawBuffers
  }) + '\n');
});


