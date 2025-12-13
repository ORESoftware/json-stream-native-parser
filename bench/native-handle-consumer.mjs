#!/usr/bin/env node
'use strict';

import {createJsonParserNativeFromFd} from '../dist/main.js';

const t0 = process.hrtime.bigint();
let count = 0;

const s = createJsonParserNativeFromFd(0, {
  delimiter: '\n',
  batchSize: 256,
  lazyHandles: true
});

s.on('data', () => {
  // Handle object (NativeJsonHandle)
  count++;
});

s.on('error', (err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

s.on('end', () => {
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(JSON.stringify({impl: 'native_handle', count, ms}) + '\n');
});


