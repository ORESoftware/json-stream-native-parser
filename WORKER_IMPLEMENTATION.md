# Web Worker Implementation - POJSO Passing via Structured Cloning

## Overview

The worker implementation parses JSON in the worker thread and passes **already-parsed POJSOs** (Plain Old JavaScript Objects) to the main thread via `postMessage` using **structured cloning**. The main thread receives objects directly - **no JSON.parse() needed**.

## How It Works

### Worker Thread (`json-parser-worker-thread.ts`)
1. **Reads file** from file descriptor
2. **Parses JSON** using `JSON.parse()` → creates POJSOs
3. **Batches POJSOs** in memory
4. **Sends via postMessage** → uses structured cloning (efficient object transfer)

```typescript
// In worker thread:
const parsed = JSON.parse(candidate);  // POJSO created here
batch.push(parsed);  // Add to batch
parentPort!.postMessage({ type: 'data', batch });  // Structured cloning
```

### Main Thread (`json-parser-worker.ts`)
1. **Receives messages** from worker
2. **Gets POJSOs directly** - already parsed, no JSON.parse() needed
3. **Emits objects** to stream

```typescript
// In main thread:
if (msg.type === 'data') {
  // msg.batch contains already-parsed POJSOs!
  // No JSON.parse() needed - objects passed via structured cloning
  this.pending.push(...msg.batch);
}
```

## Key Benefits

### ✅ No Re-parsing on Main Thread
- JSON is parsed **once** in the worker thread
- Main thread receives **already-parsed objects**
- No `JSON.parse()` call needed on main thread

### ✅ Efficient Object Transfer
- `postMessage` uses **structured cloning** algorithm
- V8 optimizes structured cloning for POJSOs
- More efficient than string serialization/deserialization

### ✅ Better Under Load
When main thread is 50%+ utilized:
- **Worker thread** handles I/O + JSON parsing (non-blocking)
- **Main thread** only receives objects (minimal work)
- **Better CPU utilization** across threads

## Performance Characteristics

### When Main Thread is Idle
- Slightly slower than native parser (worker overhead)
- Still faster than TS parser for large files

### When Main Thread is Busy (50%+ CPU)
- **Much faster** than TS parser (parsing happens off main thread)
- **Comparable or faster** than native parser (no C++ overhead)
- **Best choice** when main thread has other work

## Usage

```typescript
import {createJsonParserWorkerFromFd} from '@oresoftware/json-native-stream-parser';
import * as fs from 'node:fs';

const fd = fs.openSync('/path/to/file.jsonl', 'r');

const parser = createJsonParserWorkerFromFd(fd, {
  delimiter: '\n',
  batchSize: 256
});

parser.on('data', (obj) => {
  // obj is already a parsed POJSO - no JSON.parse() needed!
  console.log(obj.foo);  // Direct access
});
```

## Comparison

| Implementation | JSON Parsing Location | Object Transfer | Main Thread Work |
|---------------|----------------------|----------------|------------------|
| **TS Parser** | Main thread | N/A (same thread) | Full parsing |
| **Native Parser** | C++ background thread | N-API conversion | Object creation |
| **Native (buffers)** | Main thread (V8) | External buffers | JSON.parse() |
| **Worker** | Worker thread (V8) | Structured cloning | **Minimal** ✅ |

## Why It's Fast Under Load

1. **I/O happens in worker** - doesn't block main thread
2. **JSON parsing in worker** - uses V8's optimized JSON.parse()
3. **Structured cloning is efficient** - V8 optimizes POJSO transfer
4. **Main thread only receives** - minimal CPU usage on main thread

This makes it ideal when the main thread is busy with other work!

