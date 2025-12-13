#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const N = 5000; // Number of JSON objects
const LOAD_LEVELS = [0, 25, 50, 75, 90];
const root = path.resolve(new URL('..', import.meta.url).pathname);

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

// CPU load simulator
function startCpuLoad(targetPercent) {
  if (targetPercent === 0) return () => {};
  
  const interval = 10; // ms
  const workTime = (interval * targetPercent) / 100;
  const sleepTime = interval - workTime;
  
  let running = true;
  
  const cpuWorker = () => {
    if (!running) return;
    const start = Date.now();
    while (Date.now() - start < workTime) {
      Math.sqrt(Math.random() * 1000000);
    }
    if (sleepTime > 0) {
      setTimeout(cpuWorker, sleepTime);
    } else {
      setImmediate(cpuWorker);
    }
  };
  
  setImmediate(cpuWorker);
  return () => { running = false; };
}

async function runBenchmark(consumerFile, loadPercent) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      gen.kill('SIGKILL');
      consumer.kill('SIGKILL');
      reject(new Error('Benchmark timeout'));
    }, 60000);
    
    const stopLoad = startCpuLoad(loadPercent);
    
    const gen = spawn(process.execPath, ['-e', genScript], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    const consumer = spawn(process.execPath, [consumerFile], {
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

// Generate comparison graph
function generateComparison(results) {
  console.log('\n' + '='.repeat(80));
  console.log('NATIVE-OPTIMIZED vs PURE JS PARSER - Performance Comparison');
  console.log('='.repeat(80));
  console.log(`\nTest: ${N} nested JSON objects\n`);
  
  console.log('CPU Load | Native-Opt (ms) | Pure JS (ms) | Winner | Speedup');
  console.log('-'.repeat(80));
  
  for (const load of LOAD_LEVELS) {
    const native = results.find(r => r.impl === 'native-optimized' && r.load === load);
    const js = results.find(r => r.impl === 'js' && r.load === load);
    
    if (!native || !js) continue;
    
    const winner = native.ms < js.ms ? 'Native' : 'JS';
    const speedup = native.ms < js.ms 
      ? (js.ms / native.ms).toFixed(2)
      : (native.ms / js.ms).toFixed(2);
    
    console.log(
      `   ${String(load).padStart(2)}%  | ${native.ms.toFixed(2).padStart(13)} | ${js.ms.toFixed(11)} | ${winner.padEnd(6)} | ${speedup}x`
    );
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('DETAILED ANALYSIS');
  console.log('='.repeat(80));
  
  // Low load (0-25%)
  const lowNative = results.filter(r => r.impl === 'native-optimized' && r.load <= 25);
  const lowJS = results.filter(r => r.impl === 'js' && r.load <= 25);
  const lowNativeAvg = lowNative.reduce((sum, r) => sum + r.ms, 0) / lowNative.length;
  const lowJSAvg = lowJS.reduce((sum, r) => sum + r.ms, 0) / lowJS.length;
  
  console.log(`\nLOW LOAD (0-25% CPU):`);
  console.log(`  Native-Optimized: ${lowNativeAvg.toFixed(2)}ms avg`);
  console.log(`  Pure JS:          ${lowJSAvg.toFixed(2)}ms avg`);
  console.log(`  Winner:           ${lowNativeAvg < lowJSAvg ? 'Native-Optimized' : 'Pure JS'} (${(Math.max(lowNativeAvg, lowJSAvg) / Math.min(lowNativeAvg, lowJSAvg)).toFixed(2)}x faster)`);
  
  // Medium load (50%)
  const medNative = results.find(r => r.impl === 'native-optimized' && r.load === 50);
  const medJS = results.find(r => r.impl === 'js' && r.load === 50);
  
  if (medNative && medJS) {
    console.log(`\nMEDIUM LOAD (50% CPU):`);
    console.log(`  Native-Optimized: ${medNative.ms.toFixed(2)}ms`);
    console.log(`  Pure JS:          ${medJS.ms.toFixed(2)}ms`);
    console.log(`  Winner:           ${medNative.ms < medJS.ms ? 'Native-Optimized' : 'Pure JS'} (${(Math.max(medNative.ms, medJS.ms) / Math.min(medNative.ms, medJS.ms)).toFixed(2)}x faster)`);
  }
  
  // High load (75-90%)
  const highNative = results.filter(r => r.impl === 'native-optimized' && r.load >= 75);
  const highJS = results.filter(r => r.impl === 'js' && r.load >= 75);
  const highNativeAvg = highNative.reduce((sum, r) => sum + r.ms, 0) / highNative.length;
  const highJSAvg = highJS.reduce((sum, r) => sum + r.ms, 0) / highJS.length;
  
  console.log(`\nHIGH LOAD (75-90% CPU):`);
  console.log(`  Native-Optimized: ${highNativeAvg.toFixed(2)}ms avg`);
  console.log(`  Pure JS:          ${highJSAvg.toFixed(2)}ms avg`);
  console.log(`  Winner:           ${highNativeAvg < highJSAvg ? 'Native-Optimized' : 'Pure JS'} (${(Math.max(highNativeAvg, highJSAvg) / Math.min(highNativeAvg, highJSAvg)).toFixed(2)}x faster)`);
  
  // Visual comparison graph
  console.log('\n' + '='.repeat(80));
  console.log('VISUAL COMPARISON (Time in ms)');
  console.log('='.repeat(80));
  
  const maxTime = Math.max(...results.map(r => r.ms));
  const width = 60;
  
  for (const load of LOAD_LEVELS) {
    const native = results.find(r => r.impl === 'native-optimized' && r.load === load);
    const js = results.find(r => r.impl === 'js' && r.load === load);
    
    if (!native || !js) continue;
    
    const nativeBar = Math.round((native.ms / maxTime) * width);
    const jsBar = Math.round((js.ms / maxTime) * width);
    
    console.log(`\n${load}% CPU Load:`);
    console.log(`  Native-Opt: ${'█'.repeat(nativeBar)} ${native.ms.toFixed(2)}ms`);
    console.log(`  Pure JS:    ${'█'.repeat(jsBar)} ${js.ms.toFixed(2)}ms`);
  }
  
  console.log('\n');
}

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log('Comparing Native-Optimized vs Pure JS Parser');
  console.log('='.repeat(80));
  console.log(`\nTesting with ${N} nested JSON objects...`);
  console.log(`Load levels: ${LOAD_LEVELS.join('%, ')}%\n`);
  
  const results = [];
  
  // Test native-optimized
  console.log('Testing Native-Optimized parser...');
  for (const load of LOAD_LEVELS) {
    process.stdout.write(`  ${load}% load... `);
    try {
      const result = await runBenchmark(
        path.join(root, 'bench', 'native-consumer-optimized.mjs'),
        load
      );
      results.push({impl: 'native-optimized', load, ...result});
      console.log(`✓ ${result.ms.toFixed(2)}ms`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.log(`✗ FAILED: ${err.message}`);
    }
  }
  
  console.log('\nTesting Pure JS parser...');
  for (const load of LOAD_LEVELS) {
    process.stdout.write(`  ${load}% load... `);
    try {
      const result = await runBenchmark(
        path.join(root, 'bench', 'js-consumer.mjs'),
        load
      );
      results.push({impl: 'js', load, ...result});
      console.log(`✓ ${result.ms.toFixed(2)}ms`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.log(`✗ FAILED: ${err.message}`);
    }
  }
  
  if (results.length === 0) {
    console.error('\nNo successful benchmarks. Exiting.');
    process.exit(1);
  }
  
  generateComparison(results);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

