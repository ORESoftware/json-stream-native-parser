'use strict';

import {workerData, parentPort} from 'node:worker_threads';
import * as fs from 'node:fs';

interface WorkerData {
  fd: number;
  delimiter: string;
  batchSize: number;
  emitNonJSON: boolean;
  trackBytesRead: boolean;
  trackBytesWritten: boolean;
}

const opts = workerData as WorkerData;

let bytesRead = 0;
let bytesWritten = 0;
let linesOk = 0;
let linesFailed = 0;

const BUF_SZ = 128 * 1024;  // Larger buffer for better I/O performance
const buf = Buffer.allocUnsafe(BUF_SZ);
let pending = '';

// Pre-allocate batch arrays to reduce GC pressure
const batch: any[] = [];
batch.length = opts.batchSize || 64;
const nonjsonBatch: string[] = [];
nonjsonBatch.length = opts.batchSize || 64;

function flushBatch() {
  if (batch.length === 0) return;
  // Optimize: Send in larger batches to reduce postMessage overhead
  // Batch multiple smaller batches into one message if possible
  const batchToSend = batch.splice(0);
  // Use structured clone algorithm (default) - V8 optimizes this
  parentPort!.postMessage({
    type: 'data',
    batch: batchToSend  // Send POJSOs via structured cloning
  });
}

function flushNonJson() {
  if (nonjsonBatch.length === 0) return;
  parentPort!.postMessage({
    type: 'string',
    batch: nonjsonBatch.splice(0)
  });
}

function sliceStr(o: string): string {
  const z = o.indexOf('∆˚ø');
  if (z >= 0) {
    return o.slice(z);
  }

  const indices = [
    o.indexOf('["'),
    o.indexOf('{"'),
    o.indexOf('[['),
    o.indexOf('[[[')
  ].filter(v => v >= 0);

  const i = indices.length ? Math.min(...indices) : -1;
  if (i <= 0) {
    return o;
  }
  return o.slice(i);
}

// Main parsing loop
const fd = opts.fd;
try {
  while (true) {
    const n = fs.readSync(fd, buf, {offset: 0, length: BUF_SZ});
    if (n === 0) break;  // EOF

    if (opts.trackBytesRead) {
      bytesRead += n;
    }

    // Optimize: Append buffer directly instead of converting to string first
    const chunk = buf.toString('utf8', 0, n);
    pending += chunk;

    // Split by delimiter
    let start = 0;
    while (true) {
      const pos = pending.indexOf(opts.delimiter, start);
      if (pos === -1) {
        if (start > 0) pending = pending.slice(start);
        break;
      }

      const line = pending.slice(start, pos);
      start = pos + opts.delimiter.length;

      if (!line) continue;

      let candidate = line;
      // Clean front (similar to TS parser)
      if (!((candidate[0] === '[' || candidate[0] === '{') && candidate[1] === '"')) {
        candidate = sliceStr(candidate);
      }

      try {
        // Parse JSON in worker thread - POJSO is created here
        // Optimize: Parse directly without intermediate variable
        const parsed = JSON.parse(candidate);
        
        // Add to batch (POJSO will be passed via structured cloning)
        batch.push(parsed);
        linesOk++;
        
        if (opts.trackBytesRead) {
          bytesRead += Buffer.byteLength(candidate);
        }
        
        if (opts.trackBytesWritten) {
          bytesWritten += Buffer.byteLength(candidate);
        }

        if (batch.length >= opts.batchSize) {
          flushBatch();
        }
      } catch (err) {
        linesFailed++;
        if (opts.emitNonJSON) {
          nonjsonBatch.push(candidate);
          if (nonjsonBatch.length >= opts.batchSize) {
            flushNonJson();
          }
        }
      }
    }
  }

  // Flush remaining pending
  if (pending) {
    let candidate = pending;
    if (!((candidate[0] === '[' || candidate[0] === '{') && candidate[1] === '"')) {
      candidate = sliceStr(candidate);
    }

    try {
      const parsed = JSON.parse(candidate);
      batch.push(parsed);
      linesOk++;
      if (opts.trackBytesWritten) {
        bytesWritten += Buffer.byteLength(candidate);
      }
    } catch (err) {
      linesFailed++;
      if (opts.emitNonJSON) {
        nonjsonBatch.push(candidate);
      }
    }
  }

  // Flush remaining batches
  flushBatch();
  flushNonJson();

  // Send end message
  parentPort!.postMessage({
    type: 'end',
    bytesRead,
    bytesWritten,
    linesOk,
    linesFailed
  });
} catch (err: any) {
  parentPort!.postMessage({
    type: 'error',
    message: err?.message || String(err)
  });
} finally {
  // Don't close fd - it's owned by the main thread
}

