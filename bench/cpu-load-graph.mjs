#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const N = 5000; // Number of JSON objects to parse
const root = path.resolve(new URL('..', import.meta.url).pathname);

// CPU load levels to test
const LOAD_LEVELS = [0, 25, 50, 75, 90];

// Generate nested JSON test data
const genScript = `
for (let i = 0; i < ${N}; i++) {
  console.log(JSON.stringify({
    id: i,
    user: {name: 'user' + i, profile: {age: 20 + (i % 50), location: {city: 'SF', state: 'CA'}}},
    data: {items: [{id: i*10, value: 'item' + i}], metadata: {tags: ['tag1', 'tag2']}},
    nested: {level1: {level2: {level3: {value: 'deep' + i}}}}
  }));
}
`;

// CPU load simulator - runs on main thread
function startCpuLoad(targetPercent) {
  if (targetPercent === 0) return () => {}; // No load
  
  const interval = 10; // ms
  const workTime = (interval * targetPercent) / 100;
  const sleepTime = interval - workTime;
  
  let running = true;
  
  const cpuWorker = () => {
    if (!running) return;
    const start = Date.now();
    // Busy loop for workTime ms
    while (Date.now() - start < workTime) {
      // Simple computation to keep CPU busy
      Math.sqrt(Math.random() * 1000000);
    }
    if (sleepTime > 0) {
      setTimeout(cpuWorker, sleepTime);
    } else {
      setImmediate(cpuWorker);
    }
  };
  
  // Start CPU load
  setImmediate(cpuWorker);
  
  // Return stop function
  return () => { running = false; };
}

async function runBenchmark(loadPercent) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      gen.kill('SIGKILL');
      consumer.kill('SIGKILL');
      reject(new Error('Benchmark timeout'));
    }, 60000); // 60 second timeout
    
    // Start CPU load on main thread
    const stopLoad = startCpuLoad(loadPercent);
    
    // Generate test data
    const gen = spawn(process.execPath, ['-e', genScript], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Run native-optimized consumer
    const consumer = spawn(process.execPath, [
      path.join(root, 'bench', 'native-consumer-optimized.mjs')
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    
    gen.stdout.pipe(consumer.stdin);
    
    let out = '';
    consumer.stdout.setEncoding('utf8');
    consumer.stdout.on('data', d => (out += d));
    
    consumer.on('error', (err) => {
      clearTimeout(timeout);
      stopLoad();
      reject(err);
    });
    
    gen.on('error', (err) => {
      clearTimeout(timeout);
      stopLoad();
      reject(err);
    });
    
    consumer.on('close', (code) => {
      clearTimeout(timeout);
      stopLoad();
      
      if (code !== 0) {
        return reject(new Error(`consumer exited with code ${code}`));
      }
      
      try {
        const line = out.trim().split('\n').pop();
        const result = JSON.parse(line);
        resolve({
          loadPercent,
          ms: result.ms,
          count: result.count || N
        });
      } catch (e) {
        reject(new Error(`could not parse consumer output: ${out}`));
      }
    });
  });
}

// Generate ASCII graph
function generateGraph(results) {
  const maxTime = Math.max(...results.map(r => r.ms));
  const minTime = Math.min(...results.map(r => r.ms));
  const range = maxTime - minTime;
  const width = 60;
  const height = 20;
  
  console.log('\n' + '='.repeat(80));
  console.log('PERFORMANCE GRAPH: Native-Optimized Parser at Different CPU Loads');
  console.log('='.repeat(80));
  console.log(`\nTest: ${N} nested JSON objects`);
  console.log(`Time range: ${minTime.toFixed(2)}ms - ${maxTime.toFixed(2)}ms\n`);
  
  // Create data points for graph
  const graphData = results.map(r => ({
    load: r.loadPercent,
    time: r.ms,
    bar: Math.round(((r.ms - minTime) / range) * width)
  }));
  
  // Print horizontal bar chart
  console.log('CPU Load | Time (ms) | Performance Bar');
  console.log('-'.repeat(80));
  
  for (const data of graphData) {
    const bar = '█'.repeat(data.bar) + '░'.repeat(width - data.bar);
    console.log(
      `   ${String(data.load).padStart(2)}%  | ${data.time.toFixed(2).padStart(8)} | ${bar}`
    );
  }
  
  console.log('\n');
  
  // Print table
  console.log('Detailed Results:');
  console.log('-'.repeat(80));
  console.log('CPU Load | Time (ms) | Throughput (obj/sec) | Slowdown vs Idle');
  console.log('-'.repeat(80));
  
  const idleTime = results.find(r => r.loadPercent === 0)?.ms || 1;
  
  for (const r of results) {
    const throughput = Math.round((r.count / r.ms) * 1000);
    const slowdown = (r.ms / idleTime).toFixed(2);
    console.log(
      `   ${String(r.loadPercent).padStart(2)}%  | ${r.ms.toFixed(2).padStart(8)} | ${String(throughput).padStart(18)} | ${slowdown.padStart(6)}x`
    );
  }
  
  console.log('-'.repeat(80));
  
  // Print insights
  console.log('\nKey Insights:');
  const idle = results.find(r => r.loadPercent === 0);
  const load50 = results.find(r => r.loadPercent === 50);
  const load75 = results.find(r => r.loadPercent === 75);
  const load90 = results.find(r => r.loadPercent === 90);
  
  if (idle && load50) {
    const slowdown50 = (load50.ms / idle.ms).toFixed(2);
    console.log(`- At 50% CPU load: ${slowdown50}x slower than idle`);
  }
  if (idle && load75) {
    const slowdown75 = (load75.ms / idle.ms).toFixed(2);
    console.log(`- At 75% CPU load: ${slowdown75}x slower than idle`);
  }
  if (idle && load90) {
    const slowdown90 = (load90.ms / idle.ms).toFixed(2);
    console.log(`- At 90% CPU load: ${slowdown90}x slower than idle`);
  }
  
  // Calculate degradation rate
  const degradation = results
    .filter(r => r.loadPercent > 0)
    .map(r => ({
      load: r.loadPercent,
      slowdown: r.ms / idle.ms
    }));
  
  if (degradation.length > 0) {
    const avgDegradation = degradation.reduce((sum, d) => sum + d.slowdown, 0) / degradation.length;
    console.log(`- Average slowdown: ${avgDegradation.toFixed(2)}x across all load levels`);
  }
  
  console.log('\n');
}

// Generate CSV for external graphing tools
function generateCSV(results) {
  const csvPath = path.join(root, 'bench', 'cpu-load-results.csv');
  const lines = ['CPU Load %,Time (ms),Throughput (obj/sec)'];
  
  for (const r of results) {
    const throughput = Math.round((r.count / r.ms) * 1000);
    lines.push(`${r.loadPercent},${r.ms.toFixed(2)},${throughput}`);
  }
  
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`\nCSV data saved to: ${csvPath}`);
  console.log('You can import this into Excel, Google Sheets, or other tools for graphing.\n');
}

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log('Native-Optimized Parser Performance at Different CPU Load Levels');
  console.log('='.repeat(80));
  console.log(`\nTesting with ${N} nested JSON objects...`);
  console.log(`Load levels: ${LOAD_LEVELS.join('%, ')}%\n`);
  
  const results = [];
  
  for (const load of LOAD_LEVELS) {
    process.stdout.write(`Testing at ${load}% CPU load... `);
    try {
      const result = await runBenchmark(load);
      results.push(result);
      console.log(`✓ ${result.ms.toFixed(2)}ms`);
      
      // Small delay between tests to let system settle
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.log(`✗ FAILED: ${err.message}`);
      // Continue with other tests
    }
  }
  
  if (results.length === 0) {
    console.error('\nNo successful benchmarks. Exiting.');
    process.exit(1);
  }
  
  // Sort by load level
  results.sort((a, b) => a.loadPercent - b.loadPercent);
  
  // Generate graph
  generateGraph(results);
  
  // Generate CSV
  generateCSV(results);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

