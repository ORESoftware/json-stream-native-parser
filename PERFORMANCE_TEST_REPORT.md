# Performance Test Report
**Date:** December 13, 2025  
**Environment:** macOS (darwin 24.1.0), Node.js 24.1.0, ARM64

## Test Results Summary

### 1. Throughput Benchmarks (Streaming from Process)

#### Small Workload (10,000 JSON objects)
- **TypeScript Parser:** 335.59 ms avg (29,800 objects/sec)
- **Native Parser:** 340.66 ms avg (29,400 objects/sec)
- **Speedup:** 0.99x (TS parser is 1% faster)

#### Medium Workload (50,000 JSON objects)
- **TypeScript Parser:** 615.74 ms avg (81,200 objects/sec)
- **Native Parser:** 657.25 ms avg (76,200 objects/sec)
- **Speedup:** 0.94x (TS parser is 6% faster)

#### Large Workload (100,000 JSON objects)
- **TypeScript Parser:** 981.33 ms avg (101,900 objects/sec)
- **Native Parser:** 1050.73 ms avg (95,200 objects/sec)
- **Speedup:** 0.93x (TS parser is 7% faster)

### 2. File-Based Benchmarks (Reading from File)

#### 10,000 JSON objects from file
- **TypeScript Parser:** 5.48 ms avg (1,825,000 objects/sec)
- **Native Parser:** 10.71 ms avg (933,000 objects/sec)
- **Speedup:** 0.51x (TS parser is 2x faster)

**Note:** File-based parsing is significantly faster for both parsers due to OS-level caching.

### 3. Latency Benchmarks (Event Loop Blocking)

#### 100,000 JSON objects with 10ms interval timer
- **TypeScript Parser:**
  - Total time: 30.10 ms
  - Max lag: 0.15 ms
  - Timer ticks: 2
  
- **Native Parser (yieldEvery=1024):**
  - Total time: 3,244.84 ms
  - Max lag: 288.60 ms
  - Timer ticks: 87

**Key Finding:** The TypeScript parser has significantly better latency characteristics, with minimal event loop blocking.

## Analysis

### Why Native Parser is Slower

1. **Thread Communication Overhead**
   - Native parser uses N-API Thread-Safe Functions (TSFN) to communicate between background thread and main thread
   - Each batch requires a callback from native thread to JS thread
   - This overhead dominates for small-to-medium workloads

2. **JSON Parsing Strategy**
   - Native parser parses JSON in C++ then converts to JS objects
   - TypeScript parser uses native `JSON.parse()` which is highly optimized by V8
   - V8's JSON.parse() is extremely fast and benefits from JIT compilation

3. **Yielding Overhead**
   - The `yieldEvery` mechanism adds overhead with `setImmediate()` calls
   - This can actually increase latency rather than decrease it for these workloads

### When Native Parser is Beneficial

The native parser provides value in these scenarios:

1. **Very Large Files**
   - For files >100MB, the background thread processing can prevent blocking
   - Allows other work to continue on the main thread

2. **File Descriptor Parsing**
   - Direct FD parsing without creating intermediate streams
   - Useful for system-level integrations

3. **True Background Processing**
   - When you need parsing to happen completely off the main thread
   - Useful for worker-like scenarios

4. **Memory Efficiency**
   - Can process files in chunks without loading entire file into memory
   - Better for memory-constrained environments

## Recommendations

### For Most Use Cases
**Use the TypeScript parser** (`JSONParser` class):
- Faster throughput
- Better latency characteristics
- Simpler API
- No native build required
- Better for streaming from processes/pipes

### For Specialized Use Cases
**Use the Native parser** (`createJsonParserNativeFromFd`):
- Very large files (>100MB)
- Direct file descriptor access
- When you need true background processing
- Memory-constrained environments

## Performance Optimization Suggestions

1. **Native Parser Improvements:**
   - Reduce TSFN callback overhead (batch more aggressively)
   - Consider using V8's JSON.parse() in native code instead of custom parser
   - Optimize yieldEvery mechanism or make it optional
   - Profile thread communication overhead

2. **TypeScript Parser:**
   - Already well-optimized
   - Consider adding streaming optimizations for very large streams
   - Could benefit from SIMD optimizations for delimiter finding

3. **General:**
   - Add performance regression tests to CI
   - Document performance characteristics in README
   - Consider adding performance benchmarks for different JSON sizes

## Test Configuration

- **Node.js:** v24.1.0
- **Platform:** macOS ARM64 (Apple Silicon)
- **Test Data:** `{"foo":N,"bar":"baz","nested":{"x":N}}` per line
- **Iterations:** 3-5 per test
- **Warmup:** 1 iteration before measurements

## Conclusion

The TypeScript parser (`JSONParser`) is the better choice for most use cases, offering:
- 5-7% better throughput
- 2x better file-based performance
- Significantly better latency (0.15ms vs 288ms max lag)
- Simpler deployment (no native build required)

The native parser has value for specialized scenarios but needs optimization to compete with the highly-optimized V8 JSON.parse() used by the TypeScript implementation.

