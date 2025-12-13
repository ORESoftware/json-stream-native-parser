'use strict';

import * as stream from 'node:stream';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

export interface JsonParserWorkerOpts {
  delimiter?: string;
  batchSize?: number;
  emitNonJSON?: boolean;
  trackBytesRead?: boolean;
  trackBytesWritten?: boolean;
  yieldEvery?: number;
}

export interface WorkerParserStats {
  bytesRead: number;
  bytesWritten: number;
  linesOk: number;
  linesFailed: number;
  ended: boolean;
}

type WorkerMsg =
  | { type: 'data', batch: any[] }
  | { type: 'string', batch: string[] }
  | { type: 'end', bytesRead: number, bytesWritten: number, linesOk: number, linesFailed: number }
  | { type: 'error', message: string };

class JsonParserWorkerReadable extends stream.Readable {
  private worker: Worker | null = null;
  private pending: any[] = [];
  private endAfterDrain = false;
  private destroyedByUser = false;
  private yielding = false;
  private drainScheduled = false;
  private yieldEvery = 0;

  constructor(fd: number, opts: JsonParserWorkerOpts = {}) {
    super({objectMode: true, highWaterMark: 16});

    this.yieldEvery = Math.max(0, Number(opts.yieldEvery || 0) | 0);

    // Get worker script path - resolve relative to this file
    // Handle both ESM and CJS contexts
    // Note: prep-cjs.mjs will replace import.meta.url with __filename in CJS build
    let workerScript: string;
    
    // Check if we're in CJS context (__filename is only available in CJS)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - __filename is available in CJS but not in ESM
    if (typeof __filename !== 'undefined') {
      // CJS context - use __filename (prep-cjs.mjs ensures this path is taken)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - __filename is available in CJS
      workerScript = path.join(path.dirname(__filename), 'json-parser-worker-thread.js');
    } else {
      // ESM context - use import.meta.url
      // This will be replaced by prep-cjs.mjs in CJS build
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - import.meta.url is available in ESM
      const currentFileUrl = import.meta.url;
      workerScript = fileURLToPath(new URL('./json-parser-worker-thread.js', currentFileUrl));
    }

    // Create worker
    this.worker = new Worker(workerScript, {
      workerData: {
        fd,
        delimiter: opts.delimiter || '\n',
        batchSize: opts.batchSize || 64,
        emitNonJSON: opts.emitNonJSON || false,
        trackBytesRead: opts.trackBytesRead || false,
        trackBytesWritten: opts.trackBytesWritten || false
      }
    });

    this.worker.on('message', (msg: WorkerMsg) => {
      if (this.destroyedByUser) {
        return;
      }

      if (msg.type === 'data') {
        // POJSOs are passed via structured cloning (zero-copy for most cases)
        this.pending.push(...msg.batch);
        this.scheduleDrain();
        return;
      }

      if (msg.type === 'string') {
        for (const s of msg.batch) {
          this.emit('string', s);
        }
        return;
      }

      if (msg.type === 'error') {
        this.destroy(new Error(msg.message));
        return;
      }

      if (msg.type === 'end') {
        this.emit('stats', {
          bytesRead: msg.bytesRead,
          bytesWritten: msg.bytesWritten,
          linesOk: msg.linesOk,
          linesFailed: msg.linesFailed,
          ended: true
        } satisfies WorkerParserStats);

        this.endAfterDrain = true;
        this.scheduleDrain();
      }
    });

    this.worker.on('error', (err) => {
      this.destroy(err);
    });

    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.destroyedByUser) {
        this.destroy(new Error(`Worker exited with code ${code}`));
      }
    });
  }

  stop() {
    this.destroyedByUser = true;
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
  }

  getStats(): WorkerParserStats {
    // Stats are emitted via 'stats' event, return placeholder
    return {
      bytesRead: 0,
      bytesWritten: 0,
      linesOk: 0,
      linesFailed: 0,
      ended: false
    };
  }

  private drain() {
    if (this.yielding) {
      return;
    }

    const limit = this.yieldEvery > 0 ? this.yieldEvery : Number.POSITIVE_INFINITY;
    let pushed = 0;

    // Optimize: Use index instead of shift() for better performance
    let startIdx = 0;
    while (startIdx < this.pending.length && pushed < limit) {
      const ok = this.push(this.pending[startIdx]);
      if (!ok) {
        // Remove processed items
        if (startIdx > 0) {
          this.pending = this.pending.slice(startIdx);
        }
        return;
      }
      startIdx++;
      pushed++;
    }
    
    // Remove processed items
    if (startIdx > 0) {
      this.pending = this.pending.slice(startIdx);
    }

    if (this.pending.length > 0 && this.yieldEvery > 0) {
      this.yielding = true;
      setImmediate(() => {
        this.yielding = false;
        this.drain();
      });
      return;
    }

    if (this.endAfterDrain) {
      this.push(null);
    }
  }

  _read() {
    this.drain();
  }

  private scheduleDrain() {
    if (this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  _destroy(err: Error | null, cb: (error?: Error | null) => void) {
    this.stop();
    cb(err);
  }
}

export function createJsonParserWorkerFromFd(fd: number, opts: JsonParserWorkerOpts = {}) {
  return new JsonParserWorkerReadable(fd, opts);
}

