#!/usr/bin/env node
'use strict';

import {JSONParser} from '../dist/main.js';

const intervalMs = Number(process.env.INTERVAL_MS || 10);
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

process.stdin
  .resume()
  .pipe(new JSONParser())
  .on('data', () => count++)
  .on('error', (err) => {
    clearInterval(timer);
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  })
  .on('end', () => {
    clearInterval(timer);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(JSON.stringify({impl: 'ts', count, ms, intervalMs, ticks, maxLagMs}) + '\n');
  });


