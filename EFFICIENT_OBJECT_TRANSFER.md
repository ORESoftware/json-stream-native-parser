# Efficient Object Transfer: Getting Pre-Formed POJSOs

## The Goal
Parse JSON in a separate thread and get **pre-formed POJSOs** in the main thread with minimal overhead.

## Current Approaches & Limitations

### 1. Worker + Structured Cloning (Current)
- ✅ Complete objects
- ❌ O(n) cloning overhead (n = total properties)

### 2. Native C++ + N-API (Current)
- ✅ Parses in background thread
- ❌ Must construct objects on main thread (N-API limitation)

## Potential Solutions

### Option A: Binary Format (MessagePack/CBOR)

**Worker Thread:**
```typescript
const parsed = JSON.parse(candidate);
const binary = msgpack.encode(parsed);  // Compact binary
parentPort.postMessage({ type: 'data', binary });
```

**Main Thread (Native Addon):**
```cpp
// Fast native deserialization
napi_value obj = msgpack_decode_native(env, binary);
```

**Benefits:**
- Binary format more compact than structured clone
- Native deserialization can be faster
- Still get complete objects

**Trade-off:** Still requires deserialization, but potentially faster than structured clone.

### Option B: Optimize Native Object Creation

**Current (slow):**
```cpp
napi_create_object(env, &obj);
napi_set_property(env, obj, key1, val1);  // One call
napi_set_property(env, obj, key2, val2);  // Another call
// ... many individual calls
```

**Optimized (faster):**
```cpp
// Batch property setting
napi_property_descriptor props[] = {
  { "key1", nullptr, nullptr, nullptr, nullptr, val1, napi_default, nullptr },
  { "key2", nullptr, nullptr, nullptr, nullptr, val2, napi_default, nullptr },
  // ...
};
napi_define_properties(env, obj, props_count, props);  // Single call!
```

**Benefits:**
- Single N-API call instead of many
- V8 can optimize bulk property setting
- Faster object construction

### Option C: V8 Internal Serialization

V8 has internal serialization that's more efficient than structured cloning:
- `v8::ValueSerializer` / `v8::ValueDeserializer`
- Binary format optimized for V8
- Faster than structured clone

**Problem:** Not exposed in Node.js public APIs - would need to use V8 internals (risky, version-dependent).

### Option D: SharedArrayBuffer + Custom Binary Format

**Worker Thread:**
```typescript
const parsed = JSON.parse(candidate);
const binary = encodeToBinary(parsed);  // Custom efficient format
const sab = new SharedArrayBuffer(binary.length);
new Uint8Array(sab).set(binary);
parentPort.postMessage({ type: 'data', buffer: sab }, [sab]);  // Transfer!
```

**Main Thread (Native):**
```cpp
// Fast reconstruction from binary
napi_value obj = reconstruct_from_binary(env, sab_data);
```

**Benefits:**
- Zero-copy transfer (SharedArrayBuffer)
- Custom format can be optimized for our use case
- Native reconstruction can be fast

**Trade-off:** Still need to reconstruct objects, but transfer is zero-copy.

## The Best Practical Solution

### Hybrid: Native Parser with Optimized Object Creation

**Current native parser:**
1. Parse in C++ background thread → C++ struct
2. Convert to JS objects on main thread (slow - many N-API calls)

**Optimized:**
1. Parse in C++ background thread → C++ struct
2. **Batch create objects** on main thread using `napi_define_properties`
3. Pre-allocate object shapes when possible

**Implementation:**
```cpp
// Instead of:
for (const auto& kv : v.obj) {
  napi_value key = make_string(env, kv.first);
  napi_value val = jvalue_to_js(env, kv.second);
  napi_set_property(env, obj, key, val);  // Many calls
}

// Use:
std::vector<napi_property_descriptor> props;
props.reserve(v.obj.size());
for (const auto& kv : v.obj) {
  napi_value key = make_string(env, kv.first);
  napi_value val = jvalue_to_js(env, kv.second);
  props.push_back({key, nullptr, nullptr, nullptr, nullptr, val, napi_default, nullptr});
}
napi_define_properties(env, obj, props.size(), props.data());  // Single call!
```

## The Ultimate Solution (If Possible)

### V8 Transfer Handles

If we could:
1. Parse JSON in worker → Create V8 objects
2. Get object "handles" that can be transferred
3. Transfer handles (not objects) - zero-copy
4. Resolve handles to objects on main thread

**Problem:** V8 isolates are separate - objects can't cross boundaries without serialization.

### Alternative: Parse in Native, Create Objects Efficiently

**Best approach:**
1. Parse JSON in C++ background thread (fast)
2. Use optimized bulk object creation on main thread
3. Minimize N-API call overhead

**This is what we should implement!**

## Recommendation

**Short term:** Optimize native parser's object creation using `napi_define_properties` for bulk property setting.

**Medium term:** Try MessagePack or similar binary format for worker implementation.

**Long term:** Research V8 internal serialization APIs (if stable enough).

The key insight: We can't avoid object construction entirely, but we can make it much faster with bulk APIs!
