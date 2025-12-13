#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const N = 5000;
const CPU_LOAD = 50;
const root = path.resolve(new URL('..', import.meta.url).pathname);

const targets = [
  {name: 'ts', file: 'js-consumer.mjs'},
  {name: 'native', file: 'native-consumer.mjs'},
  {name: 'native-optimized', file: 'native-consumer-optimized.mjs'},
  {name: 'worker', file: 'worker-consumer.mjs'}
];

// Simulate 50% CPU load
function startCpuLoad() {
  const interval = 10;
  const workTime = 5; // 50% of 10ms
  const sleepTime = 5;
  
  const cpuWorker = () => {
    const start = Date.now();
    while (Date.now() - start < workTime) {
      Math.sqrt(Math.random() * 1000000);
    }
    setTimeout(cpuWorker, sleepTime);
  };
  
  const cores = os.cpus().length;
  for (let i = 0; i < Math.ceil(cores * CPU_LOAD / 100); i++) {
    setImmediate(cpuWorker);
  }
}

// Generate nested JSON
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

async function test(name, file, withLoad) {
  return new Promise((resolve) => {
    if (withLoad) {
      startCpuLoad();
    }
    
    const gen = spawn(process.execPath, ['-e', genScript], {stdio: ['ignore', 'pipe', 'pipe']});
    const consumer = spawn(process.execPath, [path.join(root, 'bench', file)], {stdio: ['pipe', 'pipe', 'pipe']});
    
    gen.stdout.pipe(consumer.stdin);
    
    let out = '';
    consumer.stdout.on('data', d => out += d);
    
    const timeout = setTimeout(() => {
      gen.kill('SIGKILL');
      consumer.kill('SIGKILL');
      resolve({name, ms: Infinity, error: 'timeout'});
    }, 20000);
    
    consumer.on('close', () => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(out.trim().split('\n').pop());
        resolve({name, ms: result.ms, count: result.count});
      } catch {
        resolve({name, ms: Infinity, error: 'parse failed'});
      }
      gen.kill();
    });
  });
}

async function main() {
  console.log(`\n=== BENCHMARK: ${N} nested JSON objects WITH ${CPU_LOAD}% CPU LOAD ===\n`);
  
  const results = [];
  for (const t of targets) {
    process.stdout.write(`Testing ${t.name}... `);
    const r = await test(t.name, t.file, true);
    if (r.error) {
      console.log(`FAILED: ${r.error}`);
    } else {
      console.log(`${r.ms.toFixed(2)} ms`);
      results.push(r);
    }
    // Small delay between tests
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('\n=== RESULTS (50% CPU LOAD) ===\n');
  results.sort((a, b) => a.ms - b.ms);
  const fastest = results[0]?.ms || 1;
  results.forEach(r => {
    const speedup = fastest / r.ms;
    console.log(`${r.name.padEnd(20)}: ${r.ms.toFixed(2)} ms (${speedup.toFixed(2)}x)`);
  });
  
  console.log('\n=== COMPARISON: WITH vs WITHOUT LOAD ===\n');
  console.log('(Run quick-bench.mjs for baseline numbers)');
}

main().catch(console.error);

