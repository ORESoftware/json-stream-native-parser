'use strict';

import * as stream from 'node:stream';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';

import {RawJSONBytesSymbol, RawStringSymbol} from './symbols.js';

export interface JsonParserNativeOpts {
  debug?: boolean;
  delimiter?: string;
  batchSize?: number;

  wrapMetadata?: boolean;

  includeRawString?: boolean;
  includeByteCount?: boolean;

  emitNonJSON?: boolean;
  trackBytesRead?: boolean;
  trackBytesWritten?: boolean;

  /**
   * Yield back to the event loop after pushing N parsed items.
   * This improves responsiveness when parsing huge streams while the main thread has other work to do.
   *
   * - 0/undefined: no yielding (max throughput, can monopolize the event loop)
   * - >= 1: push at most N items per tick, then `setImmediate()` to continue
   */
  yieldEvery?: number;

  /**
   * If true, the native addon emits lightweight handle objects (NativeJsonHandle)
   * instead of materializing full JS values immediately.
   *
   * Call `.toJS()` on each handle when/if you want the POJO.
   */
  lazyHandles?: boolean;

  /**
   * If true, this Readable emits arrays (batches) instead of individual items.
   * This reduces per-item stream overhead.
   */
  emitBatches?: boolean;
}

export interface NativeParserStats {
  bytesRead: number;
  bytesWritten: number;
  linesOk: number;
  linesFailed: number;
  ended: boolean;
}

type NativeMsg =
  | { type: 'data', batch: any[] }
  | { type: 'string', batch: string[] }
  | { type: 'end', bytesRead: number, bytesWritten: number, linesOk: number, linesFailed: number }
  | { type: 'error', message: string };

function loadNativeBinding(): any {
  // IMPORTANT:
  // This file is compiled twice (ESM + CJS). Avoid `import.meta` so the CJS build doesn't fail.
  // We locate the package root by resolving *this package's* package.json from the host app's cwd.
  const require = createRequire(path.join(process.cwd(), '__json_native_parser__.js'));

  let pkgRoot = '';
  try {
    const pkgJson = require.resolve('@oresoftware/json-native-stream-parser/package.json');
    pkgRoot = path.dirname(pkgJson);
  } catch {
    // fallback: when running inside this repo directly without being installed
    const maybeRoot = process.cwd();
    const p = path.join(maybeRoot, 'package.json');
    if (fs.existsSync(p)) {
      pkgRoot = maybeRoot;
    }
  }

  const candidates = [
    path.resolve(pkgRoot, 'build', 'Release', 'json_native_parser.node'),
    path.resolve(pkgRoot, 'build', 'Debug', 'json_native_parser.node')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      return require(p);
    } catch {
      // keep trying
    }
  }

  const err = new Error(
    `Could not load native addon (json_native_parser.node). ` +
    `Build it with \`node-gyp rebuild\` (from package root) and try again.`
  );
  (err as any).code = 'NATIVE_ADDON_NOT_BUILT';
  throw err;
}

class JsonParserNativeReadable extends stream.Readable {
  private native: any;
  private pendingBatches: any[][] = [];
  private batchIdx = 0;
  private itemIdx = 0;
  private endAfterDrain = false;
  private destroyedByUser = false;
  private yielding = false;
  private drainScheduled = false;
  private yieldEvery = 0;

  constructor(fd: number, opts: JsonParserNativeOpts = {}) {
    super({objectMode: true, highWaterMark: 16});

    const binding = loadNativeBinding();
    this.yieldEvery = Math.max(0, Number(opts.yieldEvery || 0) | 0);
    const emitBatches = Boolean(opts.emitBatches);

    const nativeOpts = {
      ...opts,
      // pass symbols so native can attach metadata with the *same* keys as the TS parser
      rawStringSymbol: RawStringSymbol,
      rawJsonBytesSymbol: RawJSONBytesSymbol
    };

    this.native = new binding.FdJsonParser(fd, nativeOpts, (msg: NativeMsg) => {
      if (this.destroyedByUser) {
        return;
      }

      if (msg.type === 'data') {
        if (emitBatches) {
          // Push a whole batch as a single stream item.
          this.pendingBatches.push([msg.batch]);
        } else {
          // Avoid spreading into a single array (alloc/copy). Keep batches as-is and drain via indices.
          this.pendingBatches.push(msg.batch);
        }
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
        } satisfies NativeParserStats);

        this.endAfterDrain = true;
        this.scheduleDrain();
      }
    });
  }

  stop() {
    this.destroyedByUser = true;
    try {
      this.native?.stop?.();
    } catch {
      // ignore
    }
  }

  getStats(): NativeParserStats {
    return this.native?.getStats?.() || {
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

    while (this.batchIdx < this.pendingBatches.length && pushed < limit) {
      const batch = this.pendingBatches[this.batchIdx];
      if (this.itemIdx >= batch.length) {
        this.batchIdx++;
        this.itemIdx = 0;
        continue;
      }

      const ok = this.push(batch[this.itemIdx]);
      if (!ok) {
        return;
      }
      this.itemIdx++;
      pushed++;
    }

    if (this.batchIdx < this.pendingBatches.length && this.yieldEvery > 0) {
      this.yielding = true;
      setImmediate(() => {
        this.yielding = false;
        this.drain();
      });
      return;
    }

    // If we drained everything, reset indices/queue to keep memory bounded.
    if (this.batchIdx >= this.pendingBatches.length) {
      this.pendingBatches = [];
      this.batchIdx = 0;
      this.itemIdx = 0;
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

export function createJsonParserNativeFromFd(fd: number, opts: JsonParserNativeOpts = {}) {
  return new JsonParserNativeReadable(fd, opts);
}


