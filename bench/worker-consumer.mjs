#!/usr/bin/env node
'use strict';

import {Worker} from 'node:worker_threads';
import * as path from 'node:path';

const batchSize = Number(process.env.BATCH_SIZE || 256);
const delimiter = '\n';

const workerFile = path.resolve(new URL('.', import.meta.url).pathname, 'worker-thread.mjs');
const w = new Worker(workerFile, {type: 'module'});
w.postMessage({type: 'init', delimiter, batchSize});

const t0 = process.hrtime.bigint();
let count = 0;

let done = false;
function finish() {
  if (done) return;
  done = true;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(JSON.stringify({impl: 'worker', count, ms, batchSize}) + '\n');
  // Ensure the worker doesn't keep the process alive (bench harness expects process exit).
  w.terminate().finally(() => {
    process.exit(0);
  });
}

w.on('message', (msg) => {
  if (msg?.type === 'data') {
    count += msg.batch.length;
    return;
  }
  if (msg?.type === 'end') {
    finish();
  }
});

w.on('error', (err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
  w.terminate().finally(() => process.exit(1));
});

process.stdin.on('data', (buf) => {
  // Transfer bytes to worker.
  // Copy into a standalone ArrayBuffer to avoid transferring a larger backing store.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  w.postMessage({type: 'chunk', data: new Uint8Array(ab)}, [ab]);
});

process.stdin.on('end', () => {
  w.postMessage({type: 'end'});
});

process.stdin.resume();
