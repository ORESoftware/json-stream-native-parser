'use strict';

import * as stream from 'node:stream';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import {Buffer} from 'node:buffer';

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

  /**
   * If true, and this parser opened the FD itself (e.g. from a file path),
   * it will close the FD when parsing ends or the stream is destroyed.
   *
   * Defaults to false (never closes user-provided FDs).
   */
  closeFdOnEnd?: boolean;

  /**
   * If true, native code emits raw JSON bytes as Buffers, and JS parses with `JSON.parse()`.
   *
   * This tends to be faster than building POJOs via N-API, because V8's JSON.parse is highly optimized.
   *
   * - **Default: true** (optimized mode)
   * - Set to false to use the C++ JSON parser + N-API object materialization.
   */
  passRawBuffers?: boolean;
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
  // We locate the package root by resolving *this package's* main module, then going up to find package.json.
  const require = createRequire(path.join(process.cwd(), '__json_native_parser__.js'));

  let pkgRoot = '';
  try {
    // Try to resolve the package's main module, then find package.json from there
    const mainModule = require.resolve('@oresoftware/json-native-stream-parser');
    // Main module is at dist/main.js or dist/cjs/main.js, package.json is at root
    // Go up from dist/main.js or dist/cjs/main.js to find package root
    let current = path.dirname(mainModule);
    const maxDepth = 10; // Safety limit
    let depth = 0;
    while (current !== path.dirname(current) && depth < maxDepth) {
      const pkgJsonPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        // Verify it's the right package.json by checking the name field
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkgJson.name === '@oresoftware/json-native-stream-parser') {
            pkgRoot = current;
            break;
          }
        } catch {
          // Not valid JSON, keep looking
        }
      }
      current = path.dirname(current);
      depth++;
    }
  } catch {
    // fallback: when running inside this repo directly without being installed
    const maybeRoot = process.cwd();
    const p = path.join(maybeRoot, 'package.json');
    if (fs.existsSync(p)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkgJson.name === '@oresoftware/json-native-stream-parser') {
          pkgRoot = maybeRoot;
        }
      } catch {
        // ignore
      }
    }
  }

  if (!pkgRoot) {
    const err = new Error(
      `Could not locate package root for @oresoftware/json-native-stream-parser. ` +
      `Native addon may not be built. Run \`npm run build:native\` from the package root.`
    );
    (err as any).code = 'NATIVE_ADDON_NOT_BUILT';
    throw err;
  }

  const candidates = [
    path.resolve(pkgRoot, 'build', 'Release', 'json_native_parser.node'),
    path.resolve(pkgRoot, 'build', 'Debug', 'json_native_parser.node')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return require(p);
      }
    } catch {
      // keep trying
    }
  }

  const err = new Error(
    `Could not load native addon (json_native_parser.node). ` +
    `Expected at: ${candidates.join(' or ')}. ` +
    `Build it with \`npm run build:native\` (from package root) or ensure postinstall script ran.`
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
  private fdToClose: number | null = null;
  private closeFdOnEnd = false;
  private passRawBuffers = true;
  private wrapMetadata = false;
  private includeRawString = false;
  private includeByteCount = false;
  private emitNonJSON = false;

  constructor(fd: number, opts: JsonParserNativeOpts = {}, fdToClose: number | null = null) {
    super({objectMode: true, highWaterMark: 16});

    const binding = loadNativeBinding();

    // Native-optimized defaults:
    // - batchSize: amortize TSFN callback overhead
    // - yieldEvery: keep event loop responsive under load while still emitting items individually
    const normalized: JsonParserNativeOpts = {
      delimiter: opts.delimiter ?? '\n',
      batchSize: (opts.batchSize ?? 256),
      yieldEvery: (opts.yieldEvery ?? 8192),
      ...opts
    };

    this.yieldEvery = Math.max(0, Number(normalized.yieldEvery || 0) | 0);
    const emitBatches = Boolean(normalized.emitBatches);
    this.closeFdOnEnd = Boolean(normalized.closeFdOnEnd);
    this.fdToClose = fdToClose;

    // Default to optimized mode (passRawBuffers: true) for best performance
    this.passRawBuffers = normalized.passRawBuffers !== undefined ? Boolean(normalized.passRawBuffers) : true;
    this.wrapMetadata = normalized.wrapMetadata === true;
    this.includeRawString = normalized.includeRawString === true;
    this.includeByteCount = normalized.includeByteCount === true;
    this.emitNonJSON = normalized.emitNonJSON === true; // Only true if explicitly enabled

    const nativeOpts = {
      ...normalized,
      passRawBuffers: this.passRawBuffers,
      // pass symbols so native can attach metadata with the *same* keys as the TS parser
      rawStringSymbol: RawStringSymbol,
      rawJsonBytesSymbol: RawJSONBytesSymbol
    };

    this.native = new binding.FdJsonParser(fd, nativeOpts, (msg: NativeMsg) => {
      if (this.destroyedByUser) {
        return;
      }

      if (msg.type === 'data') {
        if (this.passRawBuffers) {
          const out: any[] = [];
          for (let i = 0; i < msg.batch.length; i++) {
            const buf = msg.batch[i] as Buffer;
            try {
              const str = buf.toString('utf8');
              let parsed = JSON.parse(str);

              // Match TS parser behavior:
              // - if wrapMetadata: wrap even primitives
              // - else: only annotate objects/arrays
              if (this.wrapMetadata) {
                const wrapped: any = { value: parsed };
                if (this.includeRawString) {
                  wrapped[RawStringSymbol] = str;
                }
                if (this.includeByteCount) {
                  wrapped[RawJSONBytesSymbol] = buf.length;
                }
                parsed = wrapped;
              } else {
                if (parsed && typeof parsed === 'object') {
                  if (this.includeRawString) {
                    (parsed as any)[RawStringSymbol] = str;
                  }
                  if (this.includeByteCount) {
                    (parsed as any)[RawJSONBytesSymbol] = buf.length;
                  }
                }
              }

              out.push(parsed);
            } catch {
              if (this.emitNonJSON) {
                this.emit('string', buf.toString('utf8'));
              }
            }
          }

          if (emitBatches) {
            this.pendingBatches.push([out]);
          } else {
            this.pendingBatches.push(out);
          }
        } else {
          if (emitBatches) {
            // Push a whole batch as a single stream item.
            this.pendingBatches.push([msg.batch]);
          } else {
            // Avoid spreading into a single array (alloc/copy). Keep batches as-is and drain via indices.
            this.pendingBatches.push(msg.batch);
          }
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

    // If we hit the per-tick limit and still have items left, yield.
    if (this.batchIdx < this.pendingBatches.length && this.yieldEvery > 0 && pushed >= limit) {
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
      this.maybeCloseFd();
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
    this.maybeCloseFd();
    cb(err);
  }

  private maybeCloseFd() {
    if (!this.closeFdOnEnd) return;
    if (this.fdToClose == null) return;
    const fd = this.fdToClose;
    this.fdToClose = null;
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export function createJsonParserNativeFromFd(fd: number, opts: JsonParserNativeOpts = {}) {
  return new JsonParserNativeReadable(fd, opts);
}

export function createJsonParserNativeFromStdin(opts: JsonParserNativeOpts = {}) {
  // Prevent JS-land from also consuming stdin while native reads fd=0.
  try {
    (process.stdin as any).pause?.();
  } catch {
    // ignore
  }
  return createJsonParserNativeFromFd(0, opts);
}

export function createJsonParserNativeFromPath(filePath: string, opts: JsonParserNativeOpts = {}) {
  const fd = fs.openSync(filePath, 'r');
  // We opened the fd, so default to closing it on end unless explicitly disabled.
  const closeFdOnEnd = ('closeFdOnEnd' in opts) ? Boolean(opts.closeFdOnEnd) : true;
  return new JsonParserNativeReadable(fd, {...opts, closeFdOnEnd}, fd);
}

export function createJsonParserNativeFromSocket(sock: any, opts: JsonParserNativeOpts = {}) {
  // Node's net.Socket has an internal handle with an fd on unix.
  // IMPORTANT: Do not consume the socket in JS-land at the same time.
  try {
    sock.pause?.();
  } catch {
    // ignore
  }

  const fd = sock?._handle?.fd;
  if (typeof fd !== 'number') {
    const err: any = new Error('Could not get numeric fd from socket._handle.fd');
    err.code = 'NO_FD_ON_SOCKET';
    throw err;
  }
  return createJsonParserNativeFromFd(fd, opts);
}


