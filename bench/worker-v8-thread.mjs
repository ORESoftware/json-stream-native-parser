#!/usr/bin/env node
'use strict';

import {parentPort} from 'node:worker_threads';
import * as v8 from 'node:v8';

if (!parentPort) throw new Error('worker-v8-thread.mjs must run as a worker');

const delimiter = '\n';
const batchSize = Number(process.env.BATCH_SIZE || 256);

let pending = '';
let batch = [];

function flush() {
  if (batch.length === 0) return;
  // Serialize a whole batch as one payload to reduce overhead.
  const buf = v8.serialize(batch); // Buffer
  // Transfer the underlying ArrayBuffer (zero-copy transfer between threads).
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  parentPort.postMessage({type: 'batch', ab, len: buf.byteLength}, [ab]);
  batch = [];
}

function handleChunk(u8) {
  pending += Buffer.from(u8).toString('utf8');
  while (true) {
    const idx = pending.indexOf(delimiter);
    if (idx < 0) break;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + delimiter.length);
    if (!line) continue;
    try {
      batch.push(JSON.parse(line));
      if (batch.length >= batchSize) flush();
    } catch {
      // ignore
    }
  }
}

parentPort.on('message', (msg) => {
  if (msg?.type === 'chunk') {
    handleChunk(msg.data);
    return;
  }
  if (msg?.type === 'end') {
    if (pending) {
      try { batch.push(JSON.parse(pending)); } catch {}
      pending = '';
    }
    flush();
    parentPort.postMessage({type: 'end'});
  }
});


