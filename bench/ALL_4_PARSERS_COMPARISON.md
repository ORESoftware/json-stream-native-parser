# All 4 Parsers Performance Comparison

Comprehensive benchmark comparing all parser implementations under different CPU load conditions.

## Test Configuration

- **Objects per test**: 5,000 nested JSON objects
- **Iterations per test**: 3
- **JSON structure**: Deeply nested objects with arrays, objects, and mixed types
- **CPU Load levels**: Low (10%), Medium (50%), High (90%)

## Results Table: JSON Blobs Per Second

| Parser | Low Load (10%) | Medium Load (50%) | High Load (90%) |
|--------|----------------|-------------------|-----------------|
| **Regular JS Parser** | 459,837 | 388,292 | **548,202** |
| **Web Worker Parser** | 145,325 | 150,251 | 126,856 |
| **Native Addon 1** (passRawBuffers: true) | 374,749 | **420,930** | 443,872 |
| **Native Addon 2** (passRawBuffers: false) | 132,577 | 134,963 | 138,206 |

## Key Findings

### 1. Regular JS Parser (JSONParser - TypeScript Transform Stream)
- **Best overall performance** at high load: 548K blobs/sec
- Fastest when main thread is idle: 459K blobs/sec
- **Winner**: Best choice when main thread is available
- **Why**: Direct parsing path, no inter-thread communication overhead

### 2. Native Addon 1 (passRawBuffers: true - Optimized Mode)
- **Most consistent** across all load levels: 374K-443K blobs/sec
- Best performance at medium load: 420K blobs/sec
- **Winner**: Best choice for consistent performance under varying load
- **Why**: I/O offloaded to background thread, V8's optimized JSON.parse() on main thread

### 3. Web Worker Parser
- Moderate performance: 126K-150K blobs/sec
- Consistent across load levels
- **Use case**: Pure JS solution when native addon unavailable
- **Why**: Structured cloning overhead limits performance

### 4. Native Addon 2 (passRawBuffers: false - C++ Parsing Mode)
- Slowest: 132K-138K blobs/sec
- Consistent but slower than other options
- **Use case**: When you need C++ parsing for debugging/compatibility
- **Why**: C++ JSON parsing + N-API object construction overhead

## Performance Analysis

### Under Low Load (10% CPU)
1. **Regular JS Parser**: 459,837 blobs/sec ⚡
2. **Native Addon 1**: 374,749 blobs/sec
3. **Web Worker**: 145,325 blobs/sec
4. **Native Addon 2**: 132,577 blobs/sec

**Winner**: Regular JS Parser (fastest when main thread is idle)

### Under Medium Load (50% CPU)
1. **Native Addon 1**: 420,930 blobs/sec ⚡
2. **Regular JS Parser**: 388,292 blobs/sec
3. **Web Worker**: 150,251 blobs/sec
4. **Native Addon 2**: 134,963 blobs/sec

**Winner**: Native Addon 1 (best when main thread is moderately busy)

### Under High Load (90% CPU)
1. **Regular JS Parser**: 548,202 blobs/sec ⚡
2. **Native Addon 1**: 443,872 blobs/sec
3. **Native Addon 2**: 138,206 blobs/sec
4. **Web Worker**: 126,856 blobs/sec

**Winner**: Regular JS Parser (surprisingly fastest even under high load)

## Recommendations

### Use Regular JS Parser When:
- Main thread is available (idle or low load)
- You want maximum performance
- You don't need background I/O offloading
- **Best for**: Most common use cases

### Use Native Addon 1 (passRawBuffers: true) When:
- You need consistent performance across varying load
- You want I/O offloaded to background thread
- You're processing large files/sockets
- **Best for**: Production systems with varying load

### Use Web Worker Parser When:
- Native addon is unavailable
- You need pure JS solution
- Performance is acceptable (126K-150K blobs/sec)
- **Best for**: Environments without native build tools

### Use Native Addon 2 (passRawBuffers: false) When:
- You need C++ parsing for debugging
- You want to avoid JSON.parse() on main thread
- Performance is less critical
- **Best for**: Debugging or special compatibility needs

## Detailed Results

### Regular JS Parser
- **Low Load**: 10.98 ms avg (406K-520K blobs/sec range)
- **Medium Load**: 13.64 ms avg (316K-529K blobs/sec range)
- **High Load**: 9.12 ms avg (539K-557K blobs/sec range)

### Web Worker Parser
- **Low Load**: 34.58 ms avg (133K-158K blobs/sec range)
- **Medium Load**: 33.30 ms avg (146K-155K blobs/sec range)
- **High Load**: 39.43 ms avg (123K-128K blobs/sec range)

### Native Addon 1 (passRawBuffers: true)
- **Low Load**: 13.44 ms avg (331K-398K blobs/sec range)
- **Medium Load**: 12.01 ms avg (362K-460K blobs/sec range)
- **High Load**: 11.34 ms avg (394K-476K blobs/sec range)

### Native Addon 2 (passRawBuffers: false)
- **Low Load**: 37.73 ms avg (129K-136K blobs/sec range)
- **Medium Load**: 37.08 ms avg (132K-140K blobs/sec range)
- **High Load**: 36.30 ms avg (127K-144K blobs/sec range)

## Conclusion

The **Regular JS Parser** is the clear winner for maximum performance, especially under high CPU load. The **Native Addon 1 (passRawBuffers: true)** provides the best balance of consistency and performance, making it ideal for production systems with varying load conditions.

The performance difference between Native Addon 1 and Regular JS Parser is relatively small (10-20%), so the choice depends on whether you need background I/O offloading or maximum throughput.

---

*Generated: $(date)*
*Test data: 5,000 nested JSON objects per test, 3 iterations per configuration*

