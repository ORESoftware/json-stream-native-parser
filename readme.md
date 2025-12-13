# @oresoftware/json-stream-parser

[![Version](https://img.shields.io/npm/v/@oresoftware/json-stream-parser.svg?colorB=green)](https://www.npmjs.com/package/@oresoftware/json-stream-parser)

High-performance JSON streaming parser for Node.js with multiple implementations optimized for different use cases.

## Installation

```bash
npm install '@oresoftware/json-stream-parser'
```

**Automatic Native Addon Compilation**: The package automatically attempts to compile the native addon for your local machine architecture during installation via the `postinstall` script. The build system tries modern tools first, then falls back to traditional tools:

1. **cmake-js** (modern CMake-based build) - requires CMake
2. **node-gyp-build** (modern wrapper) - drop-in replacement for node-gyp
3. **node-gyp** (traditional fallback) - usually bundled with npm

**If compilation fails** (e.g., missing build tools), the package will still work but the native parser will be unavailable. You can:
- Use the pure JavaScript `JSONParser` instead (works without native addon)
- Install build tools and run `npm run build:native` manually
- On most systems, `node-gyp` will automatically install required dependencies

**Build Requirements** (for native addon):
- **Option 1 (Modern)**: CMake 3.10+ and `cmake-js` (via `npm install -g cmake-js`)
- **Option 2 (Modern)**: `node-gyp-build` (via `npm install -g node-gyp-build`)
- **Option 3 (Traditional)**: Python 3.x, C++ compiler (g++ on Linux/macOS, Visual Studio on Windows), and `node-gyp` (usually bundled with npm)

## Quick Start

### For Streams (TCP, stdin, pipes) - Use `JSONParser`

```typescript
import {JSONParser} from '@oresoftware/json-stream-parser';
import * as net from 'net';

// TCP connection example
const ws = net.createConnection(6970, 'localhost');

ws.setEncoding('utf8')
  .pipe(new JSONParser())   // TCP connection is bidirectional/full-duplex
  .on('data', (obj) => {
    // Receive parsed JSON objects from the TCP server
    console.log('Received:', obj);
  });

// Send JSON data to the server
ws.write(JSON.stringify({some: 'data'}) + '\n', 'utf8');
```

### For File Descriptors - Use Native Parser (Optimized by Default)

```typescript
import * as fs from 'node:fs';
import {createJsonParserNativeFromFd} from '@oresoftware/json-stream-parser';

const fd = fs.openSync('/path/to/file.jsonl', 'r');

// Optimized mode is the default (passRawBuffers: true)
const s = createJsonParserNativeFromFd(fd, {
  delimiter: '\n',
  batchSize: 2048
});

s.on('data', (obj) => {
  // obj is a fully parsed POJO (nested objects/arrays supported)
  console.log('Parsed:', obj);
});
```

## Which Parser Should I Use?

| Use Case | Parser | Why |
|----------|--------|-----|
| **TCP/WebSocket connections** | `JSONParser` | Streams don't have file descriptors |
| **stdin/stdout** | `JSONParser` | Process streams |
| **Child process pipes** | `JSONParser` | Stream-based |
| **File descriptors** | `createJsonParserNativeFromFd` | Background I/O thread, better performance |
| **Large files** | `createJsonParserNativeFromFd` | Optimized for throughput |
| **Main thread busy** | `createJsonParserNativeFromFd` | Background I/O + zero-copy buffers |

## Examples

### TCP Client/Server

#### TCP Client

```typescript
import * as net from 'net';
import {JSONParser} from '@oresoftware/json-stream-parser';

const [port, host] = [6970, 'localhost'];
const ws = net.createConnection(port, host);

ws.setEncoding('utf8')
  .pipe(new JSONParser())   // TCP connection is bidirectional/full-duplex
  .on('data', (obj) => {
    // Receive parsed JSON objects from the TCP server
    console.log('Received:', obj);
  });

// Send JSON data to the server
ws.write(JSON.stringify({some: 'data'}) + '\n', 'utf8', (err) => {
  if (err) console.error('Write error:', err);
});
```

#### TCP Server

```typescript
import * as net from 'net';
import {JSONParser} from '@oresoftware/json-stream-parser';

const server = net.createServer((socket) => {
  console.log('Client connected');
  
  const parser = new JSONParser();
  socket.setEncoding('utf8').pipe(parser);
  
  parser.on('data', (obj) => {
    console.log('Received from client:', obj);
    
    // Echo back with response
    socket.write(JSON.stringify({
      echo: obj,
      timestamp: Date.now()
    }) + '\n');
  });
  
  socket.on('end', () => {
    console.log('Client disconnected');
  });
});

server.listen(6970, () => {
  console.log('TCP JSON server listening on port 6970');
});
```

### Reading from stdin

```typescript
import {JSONParser} from '@oresoftware/json-stream-parser';

process.stdin.resume()
  .pipe(new JSONParser())
  .on('data', (obj) => {
    // Process parsed JSON objects
    console.log('Parsed:', obj);
  });
```

### Child Process Output

```typescript
import {spawn} from 'node:child_process';
import {JSONParser} from '@oresoftware/json-stream-parser';

const child = spawn('bash', ['-c', 'echo \'{"foo":"bar"}\n\'']);

child.stdout
  .pipe(new JSONParser())
  .on('data', (obj) => {
    console.log('Received:', obj); // => {foo: 'bar'}
  });
```

### Other options

1. `delayEvery`: integer

> Every x chunks, will use `setImmediate()` to delay processing; good for not blocking the event loop too much.

2. `emitNonJSON`: boolean

> If there is a line of input that cannot be JSON parsed, it will be emitted as `"string"`, but it will not be pushed to output.

### File Descriptor (Native Parser - Direct C++ Access)

The native parser captures the file descriptor **directly in C++**, bypassing Node.js streams. Data flows: **Kernel → C++ background thread → Zero-copy → JS** (no Node.js stream layer).

```typescript
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  createJsonParserNativeFromFd,
  createJsonParserNativeFromStdin,
  createJsonParserNativeFromPath,
  createJsonParserNativeFromSocket,
  RawStringSymbol,
  RawJSONBytesSymbol
} from '@oresoftware/json-stream-parser';

// 1) From a file path (auto-opens + auto-closes the FD)
const s1 = createJsonParserNativeFromPath('/path/to/file.jsonl', { delimiter: '\n' });

// 2) From stdin (fd=0)
// IMPORTANT: do not also do `process.stdin.pipe(...)` at the same time.
const s2 = createJsonParserNativeFromStdin({ delimiter: '\n' });

// 3) From any existing FD you already have
const fd = fs.openSync('/path/to/file.jsonl', 'r'); // you own this FD
const s3 = createJsonParserNativeFromFd(fd, { delimiter: '\n', closeFdOnEnd: false, passRawBuffers: true });

// 4) From a TCP socket (net.Socket)
// IMPORTANT: do not attach 'data' listeners / pipe() this socket in JS at the same time.
const sock = net.createConnection(6970, 'localhost');
const s4 = createJsonParserNativeFromSocket(sock, { delimiter: '\n' });

// 5) From a unix domain socket path (net.Socket)
const usock = net.createConnection({ path: '/tmp/my.sock' });
const s5 = createJsonParserNativeFromSocket(usock, { delimiter: '\n' });

const s = s1; // pick one of the above

s.on('data', (obj) => {
  // obj is a fully parsed POJO/array/value (nested OK)
  // metadata (if enabled) uses the same symbols as the TS parser:
  // obj[RawStringSymbol], obj[RawJSONBytesSymbol]
  console.log('Parsed:', obj);
});

// Optional metadata + behavior flags:
const sWithMeta = createJsonParserNativeFromPath('/path/to/file.jsonl', {
  delimiter: '\n',
  batchSize: 64,
  includeRawString: true,
  includeByteCount: true,
  emitNonJSON: true
});

sWithMeta.on('string', (line) => {
  // only when emitNonJSON: true
  console.log('Non-JSON line:', line);
});

sWithMeta.on('stats', (stats) => {
  // { bytesRead, bytesWritten, linesOk, linesFailed, ended }
  console.log('Stats:', stats);
});
```

#### Important caveat (sockets / stdin)

When you use `createJsonParserNativeFromStdin()` or `createJsonParserNativeFromSocket()`, **native code reads the FD directly**.
Do **not** also consume that same stream in JS-land (no `.pipe()`, no `'data'` listeners), or you’ll race for bytes.

### stdin (Direct C++ Access)

stdin is file descriptor `0` - pass it directly:

```typescript
import {createJsonParserNativeFromFd} from '@oresoftware/json-stream-parser';

// stdin (fd 0) → C++ background thread → JS (bypasses Node.js streams)
const parser = createJsonParserNativeFromFd(0, {
  delimiter: '\n',
  batchSize: 2048
});

parser.on('data', (obj) => {
  console.log('Parsed:', obj);
});
```

### Socket File Descriptor (Advanced)

You can extract the file descriptor from a socket and use the native parser:

```typescript
import * as net from 'net';
import {createJsonParserNativeFromFd} from '@oresoftware/json-stream-parser';

const server = net.createServer((socket) => {
  // Get underlying fd (internal API - may change between Node.js versions)
  const fd = (socket as any)._handle?.fd;
  
  if (fd !== undefined && fd >= 0) {
    // Pass fd directly to C++ - bypasses Node.js stream layer!
    const parser = createJsonParserNativeFromFd(fd, {
      delimiter: '\n',
      batchSize: 2048
    });
    
    parser.on('data', (obj) => {
      console.log('Received:', obj);
      // socket.write() still works for sending data
      socket.write(JSON.stringify({echo: obj}) + '\n');
    });
  } else {
    // Fallback to stream parser if fd not available
    const {JSONParser} = require('@oresoftware/json-stream-parser');
    socket.pipe(new JSONParser()).on('data', (obj) => {
      console.log('Received:', obj);
    });
  }
});

server.listen(6970);
```

**Note:** Socket fd access uses internal Node.js APIs. See [Direct File Descriptor Access](./docs/FD_DIRECT_ACCESS.md) for details.

## JSONParser Options

### Basic Options

```typescript
const parser = new JSONParser({
  delimiter: '\n',        // Separator between JSON objects (default: '\n')
  emitNonJSON: false,    // Emit non-JSON lines as 'string' events (default: false)
  delayEvery: 0          // Yield to event loop every N chunks (default: 0 = no yielding)
});
```

### Metadata Options

```typescript
import {JSONParser, RawStringSymbol, RawJSONBytesSymbol} from '@oresoftware/json-stream-parser';

const parser = new JSONParser({
  includeRawString: true,   // Attach original JSON string
  includeByteCount: true     // Attach byte count
});

parser.on('data', (obj) => {
  const rawJson = obj[RawStringSymbol];      // Original JSON string
  const byteCount = obj[RawJSONBytesSymbol]; // Byte count
  
  // Your parsed object
  console.log('Parsed:', obj);
});
```

### Custom Delimiters

If your JSON is separated by something other than newlines:

```typescript
const parser = new JSONParser({
  delimiter: '∆∆∆'  // Use custom delimiter to separate JSON chunks
});

stream.pipe(parser);
```

## Native Parser (Optimized by Default)

The native parser uses a **C++ background thread** (`std::thread`) for I/O and provides better performance, especially when the main thread is busy.

### Features

- ✅ **Background I/O**: File reading happens on separate thread
- ✅ **Zero-copy buffers**: Efficient data transfer (default mode)
- ✅ **V8 optimization**: Uses V8's highly optimized `JSON.parse()`
- ✅ **Nested objects**: Supports objects and arrays of any depth
- ✅ **Resilient under load**: Only 1.5x slower at 90% CPU load

### Building the Native Addon

**Automatic**: The native addon is automatically compiled during `npm install` via the `postinstall` script.

**Manual**: If you need to rebuild it manually:

```bash
npm run build:native
# or
node-gyp rebuild
```

### Options

```typescript
const s = createJsonParserNativeFromFd(fd, {
  delimiter: '\n',           // Separator between JSON objects
  batchSize: 2048,           // Batch size (larger = better throughput)
  passRawBuffers: true,     // Default: true (optimized mode)
  includeRawString: true,    // Attach original JSON string
  includeByteCount: true,    // Attach byte count
  emitNonJSON: true,         // Emit non-JSON lines as 'string' events
  trackBytesRead: true,      // Track bytes read
  trackBytesWritten: true,   // Track bytes written
  yieldEvery: 0             // Yield to event loop every N items
});
```

### Performance

For **5,000 nested JSON objects**:

| CPU Load | Time (ms) | Throughput (obj/sec) | Slowdown |
|----------|-----------|----------------------|----------|
| 0% (idle) | 21.27 | 235,089 | 1.00x |
| 50% | 29.04 | 172,195 | 1.37x |
| 90% | 32.05 | 155,984 | 1.51x |

Even at 90% CPU load, the native parser maintains excellent performance!

## Worker Thread Parser (Alternative)

For a pure JavaScript implementation using Node.js worker threads:

```typescript
import {createJsonParserWorkerFromFd} from '@oresoftware/json-stream-parser';

const fd = fs.openSync('/path/to/file.jsonl', 'r');

const s = createJsonParserWorkerFromFd(fd, {
  delimiter: '\n',
  batchSize: 512
});

s.on('data', (obj) => {
  // obj is a fully parsed POJO (parsed in worker thread, passed via structured cloning)
  // Works with nested objects and arrays
  console.log('Parsed:', obj);
});
```

**Note:** The native parser is typically faster than the worker parser because:
- Native uses **zero-copy buffers** (just pointer transfer)
- Worker uses **structured cloning** (full serialization/deserialization of object graph)
- For nested objects, structured cloning overhead can be significant

## Error Handling

```typescript
const parser = new JSONParser();

parser.on('error', (err) => {
  console.error('Parse error:', err);
  // Parser continues processing other chunks
});

parser.on('data', (obj) => {
  try {
    // Process object
  } catch (err) {
    console.error('Processing error:', err);
  }
});
```

## Performance Characteristics

### When Main Thread is Idle

- **JSONParser** (TS): Fastest (~16ms for 5K objects)
- **Native-optimized**: Slightly slower (~21ms) due to thread overhead
- **Worker**: Slowest (~31ms) due to structured cloning

### When Main Thread is Busy (50%+ CPU)

- **Native-optimized**: Best performance (only 1.37x slower at 50% load)
- **Worker**: Good performance (parsing offloaded to worker thread)
- **JSONParser**: Degrades significantly (parsing blocks main thread)

## API Reference

### JSONParser

```typescript
class JSONParser<T = any> extends stream.Transform {
  constructor(opts?: JSONParserOpts);
  
  // Events
  on(event: 'data', listener: (obj: T) => void): this;
  on(event: 'string', listener: (line: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

interface JSONParserOpts {
  delimiter?: string;
  emitNonJSON?: boolean;
  includeRawString?: boolean;
  includeByteCount?: boolean;
  delayEvery?: number;
  wrapMetadata?: boolean;
}
```

### createJsonParserNativeFromFd

```typescript
function createJsonParserNativeFromFd(
  fd: number,
  opts?: JsonParserNativeOpts
): stream.Readable;

interface JsonParserNativeOpts {
  delimiter?: string;
  batchSize?: number;
  passRawBuffers?: boolean;  // Default: true (optimized mode)
  includeRawString?: boolean;
  includeByteCount?: boolean;
  emitNonJSON?: boolean;
  trackBytesRead?: boolean;
  trackBytesWritten?: boolean;
  yieldEvery?: number;
  wrapMetadata?: boolean;
}
```

### createJsonParserWorkerFromFd

```typescript
function createJsonParserWorkerFromFd(
  fd: number,
  opts?: JsonParserWorkerOpts
): stream.Readable;

interface JsonParserWorkerOpts {
  delimiter?: string;
  batchSize?: number;
  emitNonJSON?: boolean;
  trackBytesRead?: boolean;
  trackBytesWritten?: boolean;
  yieldEvery?: number;
}
```

## Direct File Descriptor Access

The native parser captures file descriptors **directly in C++** so data doesn't flow through Node.js before reaching the native runtime:

- **Bypasses Node.js streams** - Data goes directly from kernel to C++ background thread
- **Zero-copy transfer** - Raw buffers passed to JS without intermediate copies
- **Background I/O** - Reading happens on separate C++ thread using `read()` syscall
- **Better performance** - No JavaScript stream processing overhead

See [Direct File Descriptor Access](./docs/FD_DIRECT_ACCESS.md) for details on using stdin and socket file descriptors.

## Direct File Descriptor Access

The native parser captures file descriptors **directly in C++** so data doesn't flow through Node.js before reaching the native runtime:

- **Bypasses Node.js streams** - Data goes directly from kernel to C++ background thread
- **Zero-copy transfer** - Raw buffers passed to JS without intermediate copies  
- **Background I/O** - Reading happens on separate C++ thread using `read()` syscall
- **Better performance** - No JavaScript stream processing overhead

**Data Flow:**
```
Kernel → C++ Background Thread (read syscall) → Zero-copy Buffer → JS
```

No Node.js stream layer involved! See [Direct File Descriptor Access](./docs/FD_DIRECT_ACCESS.md) for details on using stdin and socket file descriptors.

## Performance Comparison: Native-Optimized vs Pure JS

### Results Summary (5,000 nested JSON objects)

| CPU Load | Native-Opt (ms) | Pure JS (ms) | Winner | Speedup |
|----------|----------------|--------------|--------|---------|
| **0%** (idle) | 20.56 | 18.93 | **Pure JS** | 1.09x faster |
| **25%** (low) | 24.45 | 21.98 | **Pure JS** | 1.11x faster |
| **50%** (medium) | 26.77 | 26.45 | **Pure JS** | 1.01x faster (tied) |
| **75%** (high) | 25.67 | 42.20 | **Native-Opt** | **1.64x faster** |
| **90%** (very high) | 35.84 | 59.60 | **Native-Opt** | **1.66x faster** |

### Analysis by Load Level

#### Low Load (0-25% CPU)
- **Pure JS**: 20.46ms avg
- **Native-Opt**: 22.51ms avg
- **Winner**: Pure JS (1.10x faster)
- **Why**: Thread overhead outweighs benefits when main thread is idle

#### Medium Load (50% CPU)
- **Pure JS**: 26.45ms
- **Native-Opt**: 26.77ms
- **Winner**: Pure JS (1.01x faster - essentially tied)
- **Why**: Thread overhead still present, but benefits start to show

#### High Load (75-90% CPU)
- **Pure JS**: 50.90ms avg
- **Native-Opt**: 30.75ms avg
- **Winner**: Native-Optimized (**1.66x faster**)
- **Why**: Background I/O thread prevents blocking busy main thread

### Visual Comparison

```
0% CPU Load:
  Native-Opt: █████████████████████ 20.56ms
  Pure JS:    ███████████████████ 18.93ms  ← JS wins

25% CPU Load:
  Native-Opt: █████████████████████████ 24.45ms
  Pure JS:    ██████████████████████ 21.98ms  ← JS wins

50% CPU Load:
  Native-Opt: ███████████████████████████ 26.77ms
  Pure JS:    ███████████████████████████ 26.45ms  ← Tied

75% CPU Load:
  Native-Opt: ██████████████████████████ 25.67ms
  Pure JS:    ██████████████████████████████████████████ 42.20ms  ← Native wins!

90% CPU Load:
  Native-Opt: ████████████████████████████████████ 35.84ms
  Pure JS:    ████████████████████████████████████████████████████████████ 59.60ms  ← Native wins!
```

### Key Insights

1. **Low/Medium Load**: Pure JS is faster or tied
   - Thread overhead makes native slower when main thread is idle
   - Pure JS has no thread overhead

2. **High Load**: Native-Optimized is significantly faster
   - At 75% load: **1.64x faster**
   - At 90% load: **1.66x faster**
   - Background I/O thread prevents blocking

3. **Crossover Point**: Around 50% CPU load
   - Below 50%: Pure JS wins
   - Above 50%: Native-Optimized wins

### Recommendation

- **Use Pure JS (`JSONParser`)** when:
  - Main thread is idle or low load (<50% CPU)
  - You want simplicity (no native addon)
  - You're using streams (TCP, stdin, etc.)

- **Use Native-Optimized** when:
  - Main thread is busy (>50% CPU)
  - You have file descriptors
  - You need consistent performance under load
  - You're processing large files

## See Also

- [Architecture](./docs/ARCHITECTURE.md) - System design and data flow diagrams
- [JSON Parsing Location](./docs/JSON_PARSING_LOCATION.md) - Where JSON parsing happens (C++ vs JS thread)
- [Direct File Descriptor Access](./docs/FD_DIRECT_ACCESS.md) - How native parser captures FDs in C++
- [TCP Usage Guide](./docs/TCP_USAGE.md) - Detailed TCP connection examples
- [CPU Load Performance](./docs/CPU_LOAD_PERFORMANCE.md) - Performance under different CPU loads
- [Native vs Worker](./docs/NATIVE_VS_WORKER.md) - Comparison of native and worker parsers

## License

SEE LICENSE IN license.md
