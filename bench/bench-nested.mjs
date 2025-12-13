#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const N = Number(process.env.N || 20000);
const ITERS = Number(process.env.ITERS || 3);
const CPU_LOAD = Number(process.env.CPU_LOAD || 50);

const root = path.resolve(new URL('..', import.meta.url).pathname);

// Generate nested JSON with complex structure
function generateNestedJson(i) {
  return JSON.stringify({
    id: i,
    user: {
      name: `user${i}`,
      email: `user${i}@example.com`,
      profile: {
        age: 20 + (i % 50),
        location: {
          city: 'San Francisco',
          state: 'CA',
          country: 'USA'
        },
        preferences: {
          theme: 'dark',
          notifications: true,
          settings: {
            language: 'en',
            timezone: 'UTC'
          }
        }
      }
    },
    data: {
      items: [
        {id: i * 10, value: `item${i}`},
        {id: i * 10 + 1, value: `item${i + 1}`}
      ],
      metadata: {
        created: new Date().toISOString(),
        tags: ['tag1', 'tag2', 'tag3']
      }
    },
    nested: {
      level1: {
        level2: {
          level3: {
            value: `deep${i}`
          }
        }
      }
    }
  }) + '\n';
}

function startCpuLoad(targetPercent) {
  const interval = 10;
  const workTime = (interval * targetPercent) / 100;
  const sleepTime = interval - workTime;
  
  const cpuWorker = () => {
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
  
  const cores = os.cpus().length;
  for (let i = 0; i < Math.ceil(cores * targetPercent / 100); i++) {
    setImmediate(cpuWorker);
  }
}

function runOne({consumerFile, withCpuLoad}) {
  return new Promise((resolve, reject) => {
    let gen = null;
    let consumer = null;
    let outputReceived = false;
    let lastDataTime = Date.now();
    const TIMEOUT_MS = 30000;
    
    const cleanup = () => {
      try {
        if (gen && !gen.killed) gen.kill('SIGTERM');
        if (consumer && !consumer.killed) consumer.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (gen && !gen.killed) gen.kill('SIGKILL');
            if (consumer && !consumer.killed) consumer.kill('SIGKILL');
          } catch {}
        }, 1000);
      } catch {}
    };
    
    const timeout = setTimeout(() => {
      if (!outputReceived || (Date.now() - lastDataTime) > TIMEOUT_MS) {
        cleanup();
        reject(new Error(`Timeout after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);
    
    if (withCpuLoad) {
      startCpuLoad(CPU_LOAD);
    }
    
    // Generate nested JSON
    const genScript = `
      const N = ${N};
      for (let i = 0; i < N; i++) {
        console.log(JSON.stringify({
          id: i,
          user: {
            name: 'user' + i,
            email: 'user' + i + '@example.com',
            profile: {
              age: 20 + (i % 50),
              location: { city: 'SF', state: 'CA', country: 'USA' },
              preferences: { theme: 'dark', notifications: true, settings: { language: 'en', timezone: 'UTC' } }
            }
          },
          data: {
            items: [{id: i*10, value: 'item' + i}, {id: i*10+1, value: 'item' + (i+1)}],
            metadata: { created: new Date().toISOString(), tags: ['tag1', 'tag2', 'tag3'] }
          },
          nested: { level1: { level2: { level3: { value: 'deep' + i } } } }
        }));
      }
    `;
    
    gen = spawn(process.execPath, ['-e', genScript], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      killSignal: 'SIGTERM'
    });

    consumer = spawn(process.execPath, [consumerFile], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      killSignal: 'SIGTERM'
    });
    
    gen.stdout.pipe(consumer.stdin);
    gen.stderr.pipe(process.stderr);
    consumer.stderr.pipe(process.stderr);

    let out = '';
    consumer.stdout.setEncoding('utf8');
    consumer.stdout.on('data', (d) => {
      outputReceived = true;
      lastDataTime = Date.now();
      out += d;
    });

    const handleError = (err) => {
      clearTimeout(timeout);
      cleanup();
      reject(err);
    };

    consumer.on('error', handleError);
    gen.on('error', handleError);

    consumer.on('close', (code) => {
      clearTimeout(timeout);
      cleanup();
      
      if (code !== 0 && code !== null) {
        return reject(new Error(`consumer exited with code ${code}`));
      }
      
      const line = out.trim().split('\n').filter(l => l).pop();
      if (!line) {
        return reject(new Error(`no output: ${out}`));
      }
      
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`parse error: ${out}`));
      }
    });
    
    gen.on('close', () => {});
  });
}

async function main() {
  const targets = [
    {name: 'ts', file: path.join(root, 'bench', 'js-consumer.mjs')},
    {name: 'native', file: path.join(root, 'bench', 'native-consumer.mjs')},
    {name: 'native-optimized', file: path.join(root, 'bench', 'native-consumer-optimized.mjs')},
    {name: 'worker', file: path.join(root, 'bench', 'worker-consumer.mjs')}
  ];

  console.log(`\n=== PERFORMANCE WITH NESTED JSON (${CPU_LOAD}% CPU LOAD) ===\n`);
  console.log(`N=${N} nested objects, ITERS=${ITERS}\n`);

  const results = {};

  for (const t of targets) {
    console.log(`${t.name.toUpperCase()}:`);
    const times = [];
    
    try {
      await Promise.race([
        runOne({consumerFile: t.file, withCpuLoad: true}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 30000))
      ]);
    } catch (err) {
      console.log(`  ⚠️  Warmup failed: ${err.message}`);
      continue;
    }
    
    for (let i = 0; i < ITERS; i++) {
      try {
        const r = await Promise.race([
          runOne({consumerFile: t.file, withCpuLoad: true}),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
        ]);
        times.push(r.ms);
        console.log(`  iter ${i + 1}/${ITERS}: ${r.ms.toFixed(2)} ms (count=${r.count})`);
      } catch (err) {
        console.log(`  ⚠️  iter ${i + 1}/${ITERS} failed: ${err.message}`);
        break;
      }
    }
    
    if (times.length > 0) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      results[t.name] = avg;
      console.log(`  ✅ AVG: ${avg.toFixed(2)} ms\n`);
    }
  }

  console.log('\n=== RESULTS SUMMARY ===\n');
  const sorted = Object.entries(results).sort((a, b) => a[1] - b[1]);
  sorted.forEach(([name, time], idx) => {
    const speedup = sorted[0][1] / time;
    console.log(`${idx + 1}. ${name.toUpperCase()}: ${time.toFixed(2)} ms (${speedup.toFixed(2)}x)`);
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

