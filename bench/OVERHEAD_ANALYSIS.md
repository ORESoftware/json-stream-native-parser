# Overhead Analysis: Why Native Parsers Aren't Faster

## The Overhead Problem

You're absolutely right - the overhead of moving data from native threads to the JS main thread is significant. Here's why:

## Overhead Breakdown

### 1. Thread-Safe Function (TSFN) Overhead

When the native thread wants to send data to JS, it must:
1. **Schedule a callback** on the main thread via `napi_call_threadsafe_function()`
2. **Wait for the main thread** to be available (event loop tick)
3. **Execute the callback** on the main thread
4. **Transfer ownership** of buffers/objects

**Cost**: ~1-5 microseconds per batch, but adds up with many batches.

### 2. Buffer/Object Transfer Overhead

#### Native Addon 1 (passRawBuffers: true)
```
Native Thread: I/O + splitting → Create external buffer → TSFN call
Main Thread:  Receive buffer → Buffer.toString('utf8') → JSON.parse()
```

**Overhead**:
- TSFN call scheduling
- Buffer creation (even zero-copy has overhead)
- String conversion (`buf.toString('utf8')`)
- JSON.parse() still happens on main thread anyway!

#### Native Addon 2 (passRawBuffers: false)
```
Native Thread: I/O + splitting + C++ JSON parsing + N-API object construction → TSFN call
Main Thread:  Receive pre-parsed objects
```

**Overhead**:
- TSFN call scheduling
- N-API object construction (slower than V8's optimized JSON.parse())
- Property setting via `napi_set_property` (one call per property)
- Memory allocation for JS objects

### 3. Why Regular JS Parser Wins

```
Main Thread: Read stream → JSON.parse() directly
```

**No overhead**:
- No inter-thread communication
- No TSFN scheduling
- No buffer/object transfer
- Direct V8 optimized path
- Single-threaded, no synchronization needed

## When Native Parsers Would Help

The native parsers would be beneficial when:

### 1. Main Thread is Busy with OTHER Work
If the main thread is doing CPU-intensive work (not just parsing), then:
- Native thread can do I/O in parallel
- Main thread can process batches when available
- **But**: Our benchmark only loads the main thread with busy-wait, not real work

### 2. I/O is the Bottleneck
If reading from disk/network is slow:
- Native thread can read while main thread does other work
- **But**: Our benchmark reads from memory (temp file), so I/O is fast

### 3. Need Responsiveness
If you need the main thread to stay responsive:
- Native thread handles I/O
- Main thread processes in batches
- **But**: For pure parsing throughput, this adds overhead

## The Real Bottleneck

The bottleneck isn't I/O or parsing - it's **the transfer mechanism**:

1. **TSFN calls** require main thread availability
2. **Buffer/object creation** has overhead
3. **JSON.parse()** on main thread (for passRawBuffers: true) negates the benefit
4. **N-API object construction** (for passRawBuffers: false) is slower than V8's JSON.parse()

## Performance Comparison

| Operation | Regular JS | Native 1 | Native 2 |
|-----------|------------|---------|----------|
| I/O | Main thread | Native thread ✅ | Native thread ✅ |
| Parsing | V8 JSON.parse() ✅ | V8 JSON.parse() ✅ | C++ parser ❌ |
| Transfer | None ✅ | TSFN + buffer ❌ | TSFN + N-API ❌ |
| **Total** | **Fastest** | Slower | Slowest |

## Why This Makes Sense

1. **V8's JSON.parse() is highly optimized** - it's written in C++ and heavily optimized
2. **Single-threaded path is fastest** - no synchronization, no transfer overhead
3. **TSFN adds latency** - even zero-copy buffers need scheduling
4. **N-API object construction is slower** - it's a general-purpose API, not optimized for JSON

## Conclusion

For **pure parsing throughput**, the regular JS parser wins because:
- No inter-thread communication overhead
- Direct V8 optimized path
- No buffer/object transfer costs

The native parsers are better when:
- Main thread is busy with OTHER work (not just parsing)
- I/O is slow (network/disk)
- You need to keep main thread responsive
- You're processing very large files where I/O time matters

But for **pure parsing speed** on an available main thread, the overhead of moving data from native to JS land negates the benefits of background I/O.

