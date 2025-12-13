# Native-Optimized vs Worker Thread: Why Native is Faster

## Both Use Separate Threads

### Native Parser (C++ Background Thread)
- Uses `std::thread` (C++ background thread)
- Thread runs `parser_thread_main()` function
- Performs I/O and data preparation on background thread
- Uses **Thread-Safe Function (TSFN)** to communicate with main thread

### Worker Parser (JavaScript Worker Thread)
- Uses Node.js `worker_threads` module
- Runs JavaScript code in separate V8 isolate
- Performs I/O and JSON parsing on worker thread
- Uses `postMessage()` to communicate with main thread

## Why Native-Optimized is Faster

### Transfer Mechanism Overhead

#### Native-Optimized (Zero-Copy Buffers)
```cpp
// Background thread: Allocate buffer
item.external_data = std::make_unique<uint8_t[]>(candidate.size());
std::memcpy(item.external_data.get(), candidate.data(), candidate.size());

// Transfer: Zero-copy external buffer
napi_create_external_buffer(env, it.byte_count, it.external_data.get(),
                            nullptr, nullptr, &buffer);
```

**Transfer Cost:**
- ✅ **Zero-copy**: Just passes a memory pointer
- ✅ **No serialization**: Raw bytes transferred directly
- ✅ **Minimal overhead**: Just pointer assignment

**Main Thread Work:**
```typescript
// Fast V8 JSON.parse() on Buffer
const parsed = JSON.parse(buf.toString('utf8'));
```
- V8's `JSON.parse()` is highly optimized (JIT-compiled)
- Single string conversion + parse operation
- Very efficient for JSON parsing

#### Worker (Structured Cloning)
```typescript
// Worker thread: Parse JSON
const parsed = JSON.parse(candidate);  // Complete POJSO created
batch.push(parsed);  // Add to array

// Transfer: Structured cloning
parentPort!.postMessage({ type: 'data', batch });
```

**Transfer Cost:**
- ❌ **Full serialization**: Entire object graph must be serialized
- ❌ **Deep copy**: All nested objects/arrays copied
- ❌ **Deserialization**: Main thread must reconstruct object graph
- ❌ **Overhead**: For nested objects, this can be significant

**Main Thread Work:**
```typescript
// Objects arrive pre-parsed, but...
// Structured cloning overhead already paid during transfer
this.pending.push(...msg.batch);
```

### Performance Comparison

For **5,000 nested JSON objects** (idle main thread):

| Implementation | Time | Notes |
|---------------|------|-------|
| **TS Parser** | 16.26 ms | Fastest - no thread overhead |
| **Native-Optimized** | 21.13 ms | Zero-copy + V8 parsing |
| **Native (C++ parse)** | 21.38 ms | C++ parsing + object construction |
| **Worker** | 31.39 ms | Structured cloning overhead |

### Why Structured Cloning is Slower

1. **Serialization Overhead**: Must traverse entire object graph
   - For nested objects: `{a: {b: {c: {d: value}}}}`
   - Must serialize all levels: a → b → c → d → value

2. **Memory Allocation**: Creates new objects on main thread
   - Each nested object/array needs allocation
   - More GC pressure

3. **Cross-Thread Transfer**: 
   - Serialized data must be copied across thread boundary
   - Deserialization reconstructs object graph

4. **For Arrays of Objects**:
   ```json
   {"items": [{"id": 1, "data": {...}}, {"id": 2, "data": {...}}]}
   ```
   - Must serialize entire array
   - Each object in array must be serialized
   - All nested properties must be serialized

### When Worker Might Be Better

Worker could be faster when:
- **Main thread is very busy** (80%+ CPU load)
- **Very large, deeply nested objects** where structured cloning overhead is amortized
- **Need to avoid any main thread JSON parsing** (even V8's optimized version)

But in practice, native-optimized's zero-copy + V8 parsing is hard to beat.

## Summary

**Native-Optimized wins because:**
- ✅ Zero-copy buffer transfer (just pointer)
- ✅ V8's highly optimized `JSON.parse()`
- ✅ Minimal main thread work
- ✅ No serialization/deserialization overhead

**Worker is slower because:**
- ❌ Structured cloning requires full serialization
- ❌ Deep copying of nested structures
- ❌ Deserialization overhead on main thread
- ❌ More memory allocations

**Both use separate threads**, but the transfer mechanism makes the difference!

