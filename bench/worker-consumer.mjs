#!/usr/bin/env node
'use strict';

import {createJsonParserWorkerFromFd} from '../dist/main.js';

const t0 = process.hrtime.bigint();
let count = 0;

const s = createJsonParserWorkerFromFd(0, {
  delimiter: '\n',
  batchSize: 512  // Larger batches = fewer postMessage calls = better performance
});

s.on('data', () => {
  count++;
});

s.on('error', (err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

s.on('end', () => {
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  process.stdout.write(JSON.stringify({impl: 'worker', count, ms}) + '\n');
});

