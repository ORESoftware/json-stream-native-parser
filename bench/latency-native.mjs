#!/usr/bin/env node
'use strict';

import {createJsonParserNativeFromFd} from '../dist/main.js';

const intervalMs = Number(process.env.INTERVAL_MS || 10);
const yieldEvery = Number(process.env.YIELD_EVERY || 1024);

const t0 = process.hrtime.bigint();

let count = 0;
let maxLagMs = 0;
let ticks = 0;

let last = process.hrtime.bigint();
const timer = setInterval(() => {
  const now = process.hrtime.bigint();
  const dtMs = Number(now - last) / 1e6;
  const lag = Math.max(0, dtMs - intervalMs);
  if (lag > maxLagMs) maxLagMs = lag;
  last = now;
  ticks++;
}, intervalMs);

const s = createJsonParserNativeFromFd(0, {
  delimiter: '\n',
  batchSize: 256,
  yieldEvery
});

s.on('data', () => count++);
s.on('error', (err) => {
  clearInterval(timer);
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
s.on('end', () => {
  clearInterval(timer);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(JSON.stringify({impl: 'native', count, ms, intervalMs, ticks, maxLagMs, yieldEvery}) + '\n');
});


