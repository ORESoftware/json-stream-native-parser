#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';

const N = 5000;
const root = path.resolve(new URL('..', import.meta.url).pathname);

const targets = [
  {name: 'ts', file: 'js-consumer.mjs'},
  {name: 'native', file: 'native-consumer.mjs'},
  {name: 'native-optimized', file: 'native-consumer-optimized.mjs'},
  {name: 'worker', file: 'worker-consumer.mjs'}
];

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

async function test(name, file) {
  return new Promise((resolve) => {
    const gen = spawn(process.execPath, ['-e', genScript], {stdio: ['ignore', 'pipe', 'pipe']});
    const consumer = spawn(process.execPath, [path.join(root, 'bench', file)], {stdio: ['pipe', 'pipe', 'pipe']});
    
    gen.stdout.pipe(consumer.stdin);
    
    let out = '';
    consumer.stdout.on('data', d => out += d);
    
    const timeout = setTimeout(() => {
      gen.kill('SIGKILL');
      consumer.kill('SIGKILL');
      resolve({name, ms: Infinity, error: 'timeout'});
    }, 15000);
    
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
  console.log(`\n=== QUICK BENCHMARK: ${N} nested JSON objects ===\n`);
  
  const results = [];
  for (const t of targets) {
    process.stdout.write(`Testing ${t.name}... `);
    const r = await test(t.name, t.file);
    if (r.error) {
      console.log(`FAILED: ${r.error}`);
    } else {
      console.log(`${r.ms.toFixed(2)} ms`);
      results.push(r);
    }
  }
  
  console.log('\n=== RESULTS ===\n');
  results.sort((a, b) => a.ms - b.ms);
  const fastest = results[0]?.ms || 1;
  results.forEach(r => {
    const speedup = fastest / r.ms;
    console.log(`${r.name.padEnd(20)}: ${r.ms.toFixed(2)} ms (${speedup.toFixed(2)}x)`);
  });
}

main().catch(console.error);

