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
   * Pass raw JSON strings as Buffer objects instead of parsing in C++.
   * This reduces main thread work by letting V8's optimized JSON.parse() handle parsing.
   * Useful when main thread is busy with other work.
   * 
   * **Default: true** (optimized mode enabled by default for best performance)
   * Set to false to use C++ JSON parsing (slower but may be useful for debugging)
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
  private pending: any[] = [];
  private endAfterDrain = false;
  private destroyedByUser = false;
  private yielding = false;
  private drainScheduled = false;
  private yieldEvery = 0;
  private passRawBuffers: boolean;
  private wrapMetadata: boolean;
  private includeRawString: boolean;
  private includeByteCount: boolean;
  private emitNonJSON: boolean;

  constructor(fd: number, opts: JsonParserNativeOpts = {}) {
    super({objectMode: true, highWaterMark: 16});

    const binding = loadNativeBinding();
    this.yieldEvery = Math.max(0, Number(opts.yieldEvery || 0) | 0);

    // Default to optimized mode (passRawBuffers: true) for best performance
    this.passRawBuffers = opts.passRawBuffers !== undefined ? opts.passRawBuffers : true;
    this.wrapMetadata = opts.wrapMetadata === true;
    this.includeRawString = opts.includeRawString === true;
    this.includeByteCount = opts.includeByteCount === true;
    this.emitNonJSON = opts.emitNonJSON === true; // Only true if explicitly enabled

    const nativeOpts = {
      ...opts,
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
        // If passRawBuffers is enabled, batch contains Buffer objects that need parsing
        if (this.passRawBuffers) {
          // Optimize: Parse directly, use Buffer's built-in JSON.parse support
          // V8's JSON.parse can handle Buffer directly in some cases, but we need string
          // Optimize by reusing string conversion
          for (let i = 0; i < msg.batch.length; i++) {
            const buf = msg.batch[i] as Buffer;
            try {
              // Try to minimize string allocation - but JSON.parse needs string
              // Buffer.toString('utf8') is already optimized in V8
              const str = buf.toString('utf8');
              let parsed = JSON.parse(str);
              
              // Handle wrapMetadata if requested (same behavior as non-optimized mode)
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
                // Attach metadata directly to parsed object if requested
                if (this.includeRawString) {
                  (parsed as any)[RawStringSymbol] = str;
                }
                if (this.includeByteCount) {
                  (parsed as any)[RawJSONBytesSymbol] = buf.length;
                }
              }
              
              this.pending.push(parsed);
            } catch (err) {
              // Only emit 'string' event if emitNonJSON is explicitly enabled
              // When passRawBuffers is true, invalid JSON is passed from native side
              // and we validate it here with JSON.parse()
              if (this.emitNonJSON) {
                this.emit('string', buf.toString('utf8'));
              }
              // If emitNonJSON is false, silently skip invalid JSON (same behavior as non-optimized mode)
            }
          }
        } else {
          this.pending.push(...msg.batch);
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

export function createJsonParserNativeFromFd(fd: number, opts: JsonParserNativeOpts = {}) {
  return new JsonParserNativeReadable(fd, opts);
}


