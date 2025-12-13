#!/usr/bin/env python3
"""
Generate a visual graph from CPU load benchmark results.
Requires matplotlib: pip install matplotlib
"""

import csv
import sys
import os
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import matplotlib
    matplotlib.use('Agg')  # Non-interactive backend
except ImportError:
    print("Error: matplotlib not installed. Install with: pip install matplotlib")
    sys.exit(1)

def load_data(csv_path):
    """Load data from CSV file."""
    loads = []
    times = []
    throughputs = []
    
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            loads.append(float(row['CPU Load %']))
            times.append(float(row['Time (ms)']))
            throughputs.append(float(row['Throughput (obj/sec)']))
    
    return loads, times, throughputs

def create_graphs(loads, times, throughputs, output_dir):
    """Create performance graphs."""
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8))
    
    # Graph 1: Time vs CPU Load
    ax1.plot(loads, times, 'o-', linewidth=2, markersize=8, color='#2E86AB')
    ax1.set_xlabel('CPU Load (%)', fontsize=12)
    ax1.set_ylabel('Time (ms)', fontsize=12)
    ax1.set_title('Native-Optimized Parser: Parse Time vs CPU Load', fontsize=14, fontweight='bold')
    ax1.grid(True, alpha=0.3)
    ax1.set_xlim(-5, 95)
    
    # Add value labels
    for load, time in zip(loads, times):
        ax1.annotate(f'{time:.1f}ms', (load, time), 
                   textcoords="offset points", xytext=(0,10), ha='center', fontsize=9)
    
    # Graph 2: Throughput vs CPU Load
    ax2.plot(loads, throughputs, 's-', linewidth=2, markersize=8, color='#A23B72')
    ax2.set_xlabel('CPU Load (%)', fontsize=12)
    ax2.set_ylabel('Throughput (objects/sec)', fontsize=12)
    ax2.set_title('Native-Optimized Parser: Throughput vs CPU Load', fontsize=14, fontweight='bold')
    ax2.grid(True, alpha=0.3)
    ax2.set_xlim(-5, 95)
    
    # Add value labels
    for load, throughput in zip(loads, throughputs):
        ax2.annotate(f'{throughput/1000:.0f}k', (load, throughput), 
                   textcoords="offset points", xytext=(0,10), ha='center', fontsize=9)
    
    plt.tight_layout()
    
    # Save graph
    output_path = os.path.join(output_dir, 'cpu-load-performance.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"Graph saved to: {output_path}")
    
    # Also save as SVG
    output_path_svg = os.path.join(output_dir, 'cpu-load-performance.svg')
    plt.savefig(output_path_svg, format='svg', bbox_inches='tight')
    print(f"SVG graph saved to: {output_path_svg}")

def main():
    script_dir = Path(__file__).parent
    csv_path = script_dir / 'cpu-load-results.csv'
    
    if not csv_path.exists():
        print(f"Error: {csv_path} not found. Run bench/cpu-load-graph.mjs first.")
        sys.exit(1)
    
    loads, times, throughputs = load_data(csv_path)
    
    print(f"Loaded {len(loads)} data points")
    print(f"CPU Loads: {loads}")
    print(f"Times: {times}")
    print(f"Throughputs: {throughputs}")
    
    create_graphs(loads, times, throughputs, script_dir)
    print("\nGraphs generated successfully!")

if __name__ == '__main__':
    main()

