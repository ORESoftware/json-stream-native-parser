#!/usr/bin/env node
'use strict';

import {parentPort} from 'node:worker_threads';

const delimiter = '\n';
const batchSize = Number(process.env.BATCH_SIZE || 256);

let pending = '';
let batch = [];

function flushBatch() {
  if (batch.length > 0) {
    parentPort.postMessage({type: 'batch', batch});
    batch = [];
  }
}

function handleChunk(buf) {
  // buf is a Uint8Array
  pending += Buffer.from(buf).toString('utf8');

  while (true) {
    const idx = pending.indexOf(delimiter);
    if (idx < 0) break;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + delimiter.length);
    if (!line) continue;
    try {
      batch.push(JSON.parse(line));
      if (batch.length >= batchSize) flushBatch();
    } catch {
      // ignore non-json lines in this bench
    }
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'chunk') {
    handleChunk(msg.buf);
    return;
  }

  if (msg.type === 'end') {
    if (pending) {
      try {
        batch.push(JSON.parse(pending));
      } catch {
        // ignore
      }
      pending = '';
    }
    flushBatch();
    parentPort.postMessage({type: 'end'});
  }
});


