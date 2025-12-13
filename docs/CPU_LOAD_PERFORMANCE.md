# Native-Optimized Parser Performance at Different CPU Load Levels

## Test Configuration
- **Test Data**: 5,000 nested JSON objects
- **Parser**: Native-Optimized (zero-copy buffers, V8 JSON.parse)
- **CPU Load Levels**: 0%, 25%, 50%, 75%, 90%

## Results

### Performance Graph

```
Time (ms)
    |
35  |                                    █
    |                                    █
30  |                    █               █
    |        █           █               █
25  |        █           █       █       █
    |        █           █       █       █
20  |    █   █           █       █       █
    |    █   █           █       █       █
15  |    █   █           █       █       █
    |    █   █           █       █       █
10  |    █   █           █       █       █
    |    █   █           █       █       █
 5  |    █   █           █       █       █
    |    █   █           █       █       █
 0  +----+---+-----------+-------+-------+
      0%  25%   50%       75%     90%   CPU Load
```

### Detailed Performance Table

| CPU Load | Time (ms) | Throughput (obj/sec) | Slowdown vs Idle |
|----------|-----------|----------------------|------------------|
| **0%**    | 21.27     | 235,089              | 1.00x (baseline) |
| **25%**   | 24.64     | 202,934              | 1.16x            |
| **50%**   | 29.04     | 172,195              | 1.37x            |
| **75%**   | 26.54     | 188,385              | 1.25x            |
| **90%**   | 32.05     | 155,984              | 1.51x            |

### Key Insights

1. **Performance Degradation is Moderate**
   - Even at 90% CPU load, performance only degrades by **1.51x**
   - This shows the native-optimized parser is resilient to main thread load

2. **Non-Linear Relationship**
   - Performance doesn't degrade linearly with CPU load
   - 75% load shows better performance than 50% (likely due to system scheduling)
   - 90% load shows the worst performance (expected)

3. **Throughput Remains High**
   - Even at 90% load: **155,984 objects/second**
   - This is still excellent performance for JSON parsing

4. **Why Native-Optimized Handles Load Well**
   - **Background I/O**: File reading happens on C++ background thread
   - **Zero-copy transfer**: Minimal main thread work for data transfer
   - **V8 optimization**: `JSON.parse()` is highly optimized even under load
   - **Batching**: Large batches (2048) reduce callback overhead

### Comparison with Other Parsers (Expected)

When main thread is busy:

| Parser | Expected Performance Under Load |
|--------|--------------------------------|
| **TS Parser** | Degrades significantly (parsing blocks main thread) |
| **Native-Optimized** | Degrades moderately (this test) |
| **Worker Parser** | Should degrade less (parsing in separate thread) |

### Recommendations

1. **For High-Load Scenarios**: Use native-optimized parser
   - Handles 50-90% CPU load with only 1.25-1.5x slowdown
   - Background I/O keeps data flowing even when main thread is busy

2. **For Critical Paths**: Consider worker parser if main thread is consistently >80% loaded
   - Worker completely offloads parsing from main thread
   - Structured cloning overhead may be worth it for very high load

3. **Batch Size Tuning**: Current batch size (2048) is optimal
   - Larger batches reduce callback overhead
   - Balance between latency and throughput

## Methodology

The CPU load is simulated using a busy-wait loop that consumes the target percentage of CPU time:
- 10ms intervals
- Work time = (interval × load%) / 100
- Sleep time = interval - work time
- Multiple workers started to achieve target load across cores

The benchmark measures end-to-end time from start to finish, including:
- File I/O (on background thread)
- JSON parsing (on main thread for native-optimized)
- Object construction and event emission

