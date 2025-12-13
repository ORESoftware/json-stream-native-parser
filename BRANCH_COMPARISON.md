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
| **dev** (before fix) | 5.57 | **70.96** | **0.08x** (much slower) | Native parser was 12.7x slower - had memory bug |
| **dev** (after fix) | 5.50 | **13.51** | **0.41x** (slower) | Native parser is 2.5x slower than TS - **FIXED!** Now comparable to main |

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

**dev branch (FIXED):**

1. ✅ **External Buffer Lifetime Bug** - **FIXED in latest commit**:
   - Now uses proper finalizer: `finalize_external_buffer`
   - Memory ownership transferred correctly with `it.external_data.release()`
   - Buffer lifetime properly managed by V8
   - **Fixed in**: commit `032a8ac`

2. ✅ **Performance Regression** - **FIXED**:
   - Before fix: 70.96ms (12.7x slower than TS)
   - After fix: 13.51ms (2.5x slower than TS)
   - Now comparable to main branch (12.60ms)
   - The fix improved performance by **5.2x**!

## Recommendation (UPDATED)

### **Both branches are now viable, but dev has advantages:**

**dev branch (after fixes):**
1. ✅ **Correctness**: All tests pass reliably
2. ✅ **Performance**: Native parser now comparable to main (13.51ms vs 12.60ms)
3. ✅ **Memory Safety**: External buffer lifetime properly managed
4. ✅ **Modern Build System**: Fallback chain for build tools
5. ✅ **Worker Parser**: Additional pure JS option
6. ⚠️ **Build Reliability**: Still needs `build:native:gyp` for reliable builds

**main branch:**
1. ✅ **Correctness**: All tests pass reliably
2. ✅ **Performance**: Native parser = 12.60ms
3. ✅ **Reliability**: Build system works consistently
4. ✅ **API Completeness**: Has helper functions (FromPath, FromStdin, FromSocket)
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

### **What's been fixed in dev:**

1. ✅ **passRawBuffers "optimized" mode**:
   - Memory management bug fixed (proper finalizer)
   - Performance now comparable to main (13.51ms vs 12.60ms)
   - Implementation is now correct

2. ⚠️ **Build script behavior**:
   - Still needs `build:native:gyp` for reliable builds
   - But the fallback chain is a good idea

## Action Plan (UPDATED)

1. **dev branch is now viable** - memory bug fixed, performance fixed
2. **Consider merging dev → main** with these additions:
   - Worker parser (pure JS option)
   - Modern build script (with fixes)
   - passRawBuffers mode (now working correctly)
3. **Cherry-pick from main to dev**:
   - Helper APIs (FromPath, FromStdin, FromSocket)
   - Reliable build behavior
4. **Fix build script** in dev:
   - Ensure `build:native` actually builds correctly
   - Or document that `build:native:gyp` is required

## Performance Analysis (UPDATED)

**After the fix, dev branch performance is now comparable to main:**

The fix (proper buffer finalizer) improved performance from 70.96ms → 13.51ms (5.2x faster!)

**Why dev is still slightly slower (13.51ms vs 12.60ms):**
- Each buffer requires `buf.toString('utf8')` conversion
- Each buffer requires separate `JSON.parse()` call
- No batching optimization for JSON.parse
- Small overhead from buffer/string conversions

**Why main is slightly faster (12.60ms vs 13.51ms):**
- Single pass through data
- Bulk property setting via `napi_define_properties`
- Less string allocation
- Better memory locality

**Conclusion**: The performance difference is now minimal (~7% slower), and both approaches are viable. The choice depends on:
- **dev**: Better for when you want I/O off-thread but JSON.parse on main thread (may be better under CPU load)
- **main**: Better for pure throughput when main thread is idle

