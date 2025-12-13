#!/bin/bash
# Simple text-based graph viewer for CPU load results

CSV_FILE="$(dirname "$0")/cpu-load-results.csv"

if [ ! -f "$CSV_FILE" ]; then
    echo "Error: $CSV_FILE not found. Run bench/cpu-load-graph.mjs first."
    exit 1
fi

echo ""
echo "=================================================================================="
echo "Native-Optimized Parser Performance at Different CPU Load Levels"
echo "=================================================================================="
echo ""

# Read CSV and create graph
awk -F',' '
NR == 1 { next }  # Skip header
{
    load = $1
    time = $2
    throughput = $3
    
    # Store values
    loads[NR-1] = load
    times[NR-1] = time
    throughputs[NR-1] = throughput
    
    # Find min/max
    if (NR == 2 || time < min_time) min_time = time
    if (NR == 2 || time > max_time) max_time = time
    if (NR == 2 || throughput < min_throughput) min_throughput = throughput
    if (NR == 2 || throughput > max_throughput) max_throughput = throughput
}
END {
    time_range = max_time - min_time
    throughput_range = max_throughput - min_throughput
    width = 60
    
    print "GRAPH 1: Parse Time vs CPU Load"
    print "=================================================================================="
    print ""
    print sprintf("%8s | %10s | %s", "CPU Load", "Time (ms)", "Visualization")
    print "--------------------------------------------------------------------------------"
    
    for (i = 2; i <= NR; i++) {
        load = loads[i-1]
        time = times[i-1]
        bar_length = int(((time - min_time) / time_range) * width)
        bar = ""
        for (j = 0; j < bar_length; j++) bar = bar "█"
        for (j = bar_length; j < width; j++) bar = bar "░"
        print sprintf("%8s%% | %10.2f | %s", load, time, bar)
    }
    
    print ""
    print ""
    print "GRAPH 2: Throughput vs CPU Load"
    print "=================================================================================="
    print ""
    print sprintf("%8s | %18s | %s", "CPU Load", "Throughput (obj/s)", "Visualization")
    print "--------------------------------------------------------------------------------"
    
    for (i = 2; i <= NR; i++) {
        load = loads[i-1]
        throughput = throughputs[i-1]
        bar_length = int(((throughput - min_throughput) / throughput_range) * width)
        bar = ""
        for (j = 0; j < bar_length; j++) bar = bar "█"
        for (j = bar_length; j < width; j++) bar = bar "░"
        print sprintf("%8s%% | %18.0f | %s", load, throughput, bar)
    }
    
    print ""
    print "=================================================================================="
    print "Summary Statistics"
    print "=================================================================================="
    print ""
    
    idle_time = times[1]
    idle_throughput = throughputs[1]
    
    print sprintf("Idle (0%% load):   %8.2f ms, %8.0f obj/sec", idle_time, idle_throughput)
    print ""
    
    for (i = 2; i <= NR; i++) {
        load = loads[i-1]
        time = times[i-1]
        throughput = throughputs[i-1]
        slowdown = time / idle_time
        throughput_ratio = throughput / idle_throughput
        
        print sprintf("%2.0f%% load:        %8.2f ms, %8.0f obj/sec  (%.2fx slower, %.2fx throughput)", 
                      load, time, throughput, slowdown, throughput_ratio)
    }
    
    print ""
}
' "$CSV_FILE"

