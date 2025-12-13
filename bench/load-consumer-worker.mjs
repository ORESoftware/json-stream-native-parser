#!/usr/bin/env node
'use strict';

import {Worker} from 'node:worker_threads';

const load = Number(process.env.LOAD || 0.5);
const periodMs = Number(process.env.LOAD_PERIOD_MS || 20);
const intervalMs = Number(process.env.INTERVAL_MS || 10);
const batchSize = Number(process.env.BATCH_SIZE || 256);

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

const busyMs = Math.max(0, Math.min(periodMs, periodMs * load));
const loadTimer = setInterval(() => {
  if (busyMs > 0) busyWait(busyMs);
}, periodMs);

const t0 = process.hrtime.bigint();
let count = 0;

const worker = new Worker(new URL('./worker-parser.mjs', import.meta.url), {
  type: 'module',
  env: {BATCH_SIZE: String(batchSize)}
});

worker.on('message', (msg) => {
  if (msg.type === 'batch') {
    count += msg.batch.length;
    return;
  }
  if (msg.type === 'end') {
    clearInterval(loadTimer);
    clearInterval(lagTimer);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(JSON.stringify({impl: 'worker', count, ms, load, periodMs, intervalMs, ticks, maxLagMs, batchSize}) + '\n');
  }
});

worker.on('error', (err) => {
  clearInterval(loadTimer);
  clearInterval(lagTimer);
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

process.stdin.on('data', (chunk) => {
  const b = Buffer.from(chunk);
  const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  worker.postMessage({type: 'chunk', buf: u8});
});
process.stdin.on('end', () => {
  worker.postMessage({type: 'end'});
});
process.stdin.resume();


