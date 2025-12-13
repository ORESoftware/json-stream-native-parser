#!/usr/bin/env node
'use strict';

import {Worker} from 'node:worker_threads';
import * as path from 'node:path';
import * as v8 from 'node:v8';

const batchSize = Number(process.env.BATCH_SIZE || 256);

const workerFile = path.resolve(new URL('.', import.meta.url).pathname, 'worker-v8-thread.mjs');
const w = new Worker(workerFile, {type: 'module', env: {BATCH_SIZE: String(batchSize)}});

const t0 = process.hrtime.bigint();
let count = 0;

let done = false;
function finish(code = 0) {
  if (done) return;
  done = true;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(JSON.stringify({impl: 'worker_v8', count, ms, batchSize}) + '\n');
  w.terminate().finally(() => process.exit(code));
}

w.on('message', (msg) => {
  if (msg?.type === 'batch') {
    const u8 = new Uint8Array(msg.ab, 0, msg.len);
    // Deserialize batch on main thread (still a decode step, but binary and avoids structured clone).
    const arr = v8.deserialize(Buffer.from(u8));
    count += arr.length;
    return;
  }
  if (msg?.type === 'end') {
    finish(0);
  }
});

w.on('error', (err) => {
  console.error(err?.stack || String(err));
  finish(1);
});

process.stdin.on('data', (buf) => {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  w.postMessage({type: 'chunk', data: new Uint8Array(ab)}, [ab]);
});

process.stdin.on('end', () => {
  w.postMessage({type: 'end'});
});

process.stdin.resume();


