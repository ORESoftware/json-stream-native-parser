#!/usr/bin/env node
'use strict';

import {parentPort} from 'node:worker_threads';

if (!parentPort) {
  throw new Error('worker-thread.mjs must run as a worker');
}

let delimiter = '\n';
let batchSize = 256;

let pending = '';
let batch = [];

function flushBatch() {
  if (batch.length === 0) return;
  parentPort.postMessage({type: 'data', batch});
  batch = [];
}

function handleChunk(u8) {
  // decode bytes -> string (UTF-8)
  const s = new TextDecoder().decode(u8);
  pending += s;

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
      // ignore non-json for this bench
    }
  }
}

parentPort.on('message', (msg) => {
  if (msg?.type === 'init') {
    delimiter = msg.delimiter ?? '\n';
    batchSize = msg.batchSize ?? 256;
    return;
  }
  if (msg?.type === 'chunk') {
    handleChunk(msg.data);
    return;
  }
  if (msg?.type === 'end') {
    // flush remaining
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


