# Where Does JSON Parsing Happen?

## Answer: It Depends on the Mode!

The native parser has two modes that determine where JSON parsing occurs:

## Mode 1: `passRawBuffers: true` (Default - Optimized)

**JSON parsing happens in the JS main thread** using V8's `JSON.parse()`

### Data Flow:

```
┌─────────────────────────────────────────────────────────┐
│ C++ Background Thread                                    │
│                                                          │
│  1. Read from fd: read(fd_dup, buf, size)              │
│  2. Split by delimiter                                     │
│  3. Store raw JSON string (NO PARSING)                 │
│  4. Create zero-copy external buffer                     │
│  5. Send buffer to main thread via TSFN                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Zero-copy buffer (raw JSON)
                     ▼
┌─────────────────────────────────────────────────────────┐
│ JS Main Thread (TSFN Callback)                          │
│                                                          │
│  call_js_from_tsfn_with_instance(...) {                  │
│    // Receive Buffer from C++ thread                    │
│    const buf = msg.batch[i];                            │
│                                                          │
│    // JSON PARSING HAPPENS HERE!                        │
│    const str = buf.toString('utf8');                    │
│    const parsed = JSON.parse(str);  // ← V8's parser    │
│                                                          │
│    // Emit 'data' event                                 │
│    this.pending.push(parsed);                           │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
```

**Code Evidence:**

```cpp
// native/json-native-parser.cc (C++ thread)
if (inst->opts.pass_raw_buffers) {
  // Skip JSON parsing - just store raw string
  // JS side will parse with V8's optimized JSON.parse()
  item.raw = candidate;
  // Create zero-copy buffer
  item.external_data = std::make_unique<uint8_t[]>(candidate.size());
  // Send to main thread (NO PARSING in C++)
}
```

```typescript
// src/json-parser-native.ts (JS main thread)
if (this.passRawBuffers) {
  const buf = msg.batch[i] as Buffer;
  const str = buf.toString('utf8');
  const parsed = JSON.parse(str);  // ← PARSING HERE!
  this.pending.push(parsed);
}
```

## Mode 2: `passRawBuffers: false` (C++ Parsing)

**JSON parsing happens in the C++ background thread** using C++ JSON parser

### Data Flow:

```
┌─────────────────────────────────────────────────────────┐
│ C++ Background Thread                                    │
│                                                          │
│  1. Read from fd: read(fd_dup, buf, size)              │
│  2. Split by delimiter                                     │
│  3. Parse JSON in C++: parse_json(candidate, parsed)   │
│     // Creates JValue (C++ struct)                     │
│  4. Send JValue to main thread via TSFN                │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ JValue (C++ parsed structure)
                     ▼
┌─────────────────────────────────────────────────────────┐
│ JS Main Thread (TSFN Callback)                          │
│                                                          │
│  call_js_from_tsfn_with_instance(...) {                  │
│    // Receive JValue from C++ thread                   │
│    const jvalue = msg.items[i].value;                   │
│                                                          │
│    // Convert C++ JValue to JS object                   │
│    // NO JSON PARSING - just object construction        │
│    napi_value parsed_val = jvalue_to_js(env, jvalue);  │
│                                                          │
│    // Emit 'data' event                                 │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
```

**Code Evidence:**

```cpp
// native/json-native-parser.cc (C++ thread)
if (inst->opts.pass_raw_buffers) {
  // ... passRawBuffers mode ...
} else {
  JValue parsed;
  if (parse_json(candidate, parsed)) {  // ← PARSING IN C++!
    item.value = std::move(parsed);
    // Send JValue to main thread
  }
}
```

## Why Default Mode Uses JS Main Thread?

The default mode (`passRawBuffers: true`) parses on the **JS main thread** because:

1. **V8's JSON.parse() is highly optimized** - JIT-compiled, very fast
2. **Background I/O still helps** - File reading happens on C++ thread
3. **Zero-copy transfer** - No data copying overhead
4. **Better performance** - V8's parser is faster than C++ parser

Even though parsing happens on the main thread, the architecture still provides benefits:
- ✅ **I/O is offloaded** - File reading doesn't block main thread
- ✅ **Zero-copy buffers** - Efficient data transfer
- ✅ **Batching** - Reduces callback overhead
- ✅ **Resilient under load** - Only 1.5x slower at 90% CPU

## Performance Comparison

### passRawBuffers: true (Default)
- **Parsing**: JS main thread (V8's JSON.parse)
- **I/O**: C++ background thread
- **Performance**: ~21ms for 5K objects (idle)
- **Under load**: 1.51x slower at 90% CPU

### passRawBuffers: false
- **Parsing**: C++ background thread (C++ JSON parser)
- **I/O**: C++ background thread
- **Performance**: ~21ms for 5K objects (idle)
- **Under load**: Similar, but C++ parsing is slower than V8

## Summary

| Mode | JSON Parsing Location | Parser Used | Why |
|------|----------------------|-------------|-----|
| **passRawBuffers: true** (default) | **JS main thread** | V8's `JSON.parse()` | V8's parser is highly optimized |
| **passRawBuffers: false** | **C++ background thread** | C++ `parse_json()` | Useful for debugging, but slower |

**Key Point**: Even in default mode, the background thread still provides value by:
- Handling I/O operations (file reading)
- Preparing data batches
- Using zero-copy transfers

The main thread only needs to parse JSON (which is fast with V8), not read files (which would block).

