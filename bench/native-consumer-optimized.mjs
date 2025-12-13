#!/usr/bin/env node
'use strict';

import {createJsonParserNativeFromFd} from '../dist/main.js';

const t0 = process.hrtime.bigint();
let count = 0;

const s = createJsonParserNativeFromFd(0, {
  delimiter: '\n',
  batchSize: 2048,  // Maximum batch size for best performance
  passRawBuffers: true  // Use optimized buffer mode
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
  process.stdout.write(JSON.stringify({impl: 'native-optimized', count, ms}) + '\n');
});

