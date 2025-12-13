# Branch Comparison: main vs dev

## Test Results Summary

### Correctness Tests (npm test)

| Branch | Build Command | Test Result | Notes |
|--------|--------------|-------------|-------|
| **main** | `npm run build:native` (node-gyp) | ✅ **PASS** (16/16 tests) | All tests pass, native parser works correctly |
| **dev** | `npm run build:native` (script) → `npm run build:native:gyp` | ✅ **PASS** (16/16 tests) | Build script doesn't reliably build; needs explicit `build:native:gyp` |

### Performance Benchmarks (N=10000, ITERS=5)

| Branch | TS Parser (ms) | Native Parser (ms) | Native vs TS | Notes |
|--------|----------------|-------------------|--------------|-------|
| **main** | 5.52 | 12.60 | **0.44x** (slower) | Native parser is 2.3x slower than TS |
| **dev** | 5.57 | **70.96** | **0.08x** (much slower) | Native parser is **12.7x slower** than TS - **CRITICAL PERFORMANCE REGRESSION** |

### Key Differences

#### 1. Native Parser Implementation

**main branch:**
- Native parser parses JSON in C++ and constructs JS objects via N-API
- Direct object construction from C++ tree
- Performance: ~12.6ms for 10K objects

**dev branch:**
- "Optimized mode" with `passRawBuffers: true` (default)
- Native thread does I/O + splitting, passes raw buffers to JS
- JS main thread does `JSON.parse()` on buffers
- **Performance: ~71ms for 10K objects (5.6x slower than main!)**

#### 2. Build System

**main branch:**
- Uses `node-gyp` directly via `postinstall` script
- Reliable, deterministic builds
- Works with r2g

**dev branch:**
- Modern build script (`scripts/build-native.mjs`) with fallback chain:
  1. cmake-js (requires CMake)
  2. node-gyp-build (modern wrapper)
  3. node-gyp (fallback)
- **Issue**: Script reports "built with node-gyp-build" but doesn't reliably produce working `.node` file
- Requires explicit `npm run build:native:gyp` for correctness

#### 3. API Surface

**main branch:**
- Rich convenience helpers:
  - `createJsonParserNativeFromPath`
  - `createJsonParserNativeFromStdin`
  - `createJsonParserNativeFromSocket`
  - `createJsonParserNativeFromFd`

**dev branch:**
- Only `createJsonParserNativeFromFd`
- Adds `createJsonParserWorkerFromFd` (worker thread parser)

#### 4. Code Quality Issues

**dev branch has critical bugs:**

1. **External Buffer Lifetime Bug** (uncommitted fix):
   - `napi_create_external_buffer` called with `nullptr` finalizer
   - Comment claims "unique_ptr manages lifetime" but this is incorrect
   - Memory can be freed while JavaScript still holds references
   - **Location**: `native/json-native-parser.cc:559`

2. **Performance Regression**:
   - "Optimized mode" is actually 5.6x slower than main branch
   - Suggests the passRawBuffers approach has fundamental issues
   - May be due to:
     - Buffer allocation overhead
     - String conversion overhead (`buf.toString('utf8')`)
     - Multiple JSON.parse() calls on main thread

## Recommendation

### **Use main branch as the base**

**Reasons:**
1. ✅ **Correctness**: All tests pass reliably
2. ✅ **Performance**: Native parser is 5.6x faster than dev
3. ✅ **Reliability**: Build system works consistently
4. ✅ **API Completeness**: Has helper functions for common use cases
5. ✅ **Production Ready**: No critical bugs

### **What to cherry-pick from dev:**

1. **Worker Parser** (`createJsonParserWorkerFromFd`):
   - Useful for pure JS solution
   - Good fallback when native addon unavailable
   - Already fixed (removed pre-allocation bug)

2. **Modern Build Script** (`scripts/build-native.mjs`):
   - Good idea but needs fixing
   - Should ensure it actually builds correctly
   - Or keep as optional enhancement

3. **Documentation** (if better):
   - Performance reports
   - Architecture docs
   - But verify they're accurate

### **What NOT to use from dev:**

1. ❌ **passRawBuffers "optimized" mode**:
   - It's actually much slower
   - Has memory management bugs
   - The concept is sound but implementation needs work

2. ❌ **Current build script behavior**:
   - Doesn't reliably build
   - Misleading success messages

## Action Plan

1. **Stay on main branch** for production
2. **Cherry-pick worker parser** from dev (already fixed)
3. **Fix build script** if keeping it (ensure it actually builds)
4. **Investigate passRawBuffers** separately if needed:
   - Profile to find bottlenecks
   - Fix memory management
   - Re-benchmark before considering merge

## Performance Analysis

The dev branch's "optimized mode" is slower because:
- Each buffer requires `buf.toString('utf8')` conversion
- Each buffer requires separate `JSON.parse()` call
- No batching optimization for JSON.parse
- Buffer allocation overhead in C++
- String allocation overhead in JS

The main branch's approach (C++ parsing + N-API construction) is faster because:
- Single pass through data
- Bulk property setting via `napi_define_properties`
- Less string allocation
- Better memory locality

