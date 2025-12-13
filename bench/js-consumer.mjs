#!/usr/bin/env node
'use strict';

import {JSONParser} from '../dist/main.js';

const t0 = process.hrtime.bigint();
let count = 0;

process.stdin
  .resume()
  .pipe(new JSONParser())
  .on('data', () => {
    count++;
  })
  .on('error', (err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  })
  .on('end', () => {
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    process.stdout.write(JSON.stringify({impl: 'ts', count, ms}) + '\n');
  });


