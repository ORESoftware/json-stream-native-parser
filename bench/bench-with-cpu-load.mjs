#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const N = Number(process.env.N || 50000);
const ITERS = Number(process.env.ITERS || 3);
const CPU_LOAD = Number(process.env.CPU_LOAD || 50); // percentage

const root = path.resolve(new URL('..', import.meta.url).pathname);

// Simulate CPU load on main thread
function startCpuLoad(targetPercent) {
  const interval = 10; // ms
  const workTime = (interval * targetPercent) / 100;
  const sleepTime = interval - workTime;
  
  const cpuWorker = () => {
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
  
  // Start on all available cores to simulate main thread load
  const cores = os.cpus().length;
  for (let i = 0; i < Math.ceil(cores * targetPercent / 100); i++) {
    setImmediate(cpuWorker);
  }
}

function bashGeneratorCmd(n) {
  return [
    'bash',
    ['-lc', `i=0; while [ $i -lt ${n} ]; do i=$((i+1)); printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\n' "$i" "$i"; done`]
  ];
}

function runOne({consumerFile, withCpuLoad}) {
  return new Promise((resolve, reject) => {
    let gen = null;
    let consumer = null;
    let outputReceived = false;
    let lastDataTime = Date.now();
    
    const TIMEOUT_MS = 15000; // 15 second timeout
    
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
        reject(new Error(`Benchmark timeout after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);
    
    if (withCpuLoad) {
      startCpuLoad(CPU_LOAD);
    }
    
    const [bash, bashArgs] = bashGeneratorCmd(N);
    gen = spawn(bash, bashArgs, {
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
        return reject(new Error(`no output from consumer: ${out}`));
      }
      
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`could not parse consumer output: ${out}`));
      }
    });
    
    gen.on('close', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`generator exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const targets = [
    {name: 'ts', file: path.join(root, 'bench', 'js-consumer.mjs')},
    {name: 'native', file: path.join(root, 'bench', 'native-consumer.mjs')},
    {name: 'native-optimized', file: path.join(root, 'bench', 'native-consumer-optimized.mjs')},
    {name: 'worker', file: path.join(root, 'bench', 'worker-consumer.mjs')}
  ];

  console.log(`\n=== Benchmark with ${CPU_LOAD}% CPU load on main thread ===\n`);
  console.log(`N=${N}, ITERS=${ITERS}\n`);

  for (const t of targets) {
    console.log(`\n${t.name.toUpperCase()} parser (with ${CPU_LOAD}% CPU load):`);
    const results = [];
    
    try {
      // warmup
      await Promise.race([
        runOne({consumerFile: t.file, withCpuLoad: true}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 20000))
      ]);
    } catch (err) {
      console.log(`  ⚠️  Warmup failed: ${err.message}, skipping...`);
      continue;
    }
    
    for (let i = 0; i < ITERS; i++) {
      try {
        const r = await Promise.race([
          runOne({consumerFile: t.file, withCpuLoad: true}),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Iteration timeout')), 20000))
        ]);
        results.push(r.ms);
        console.log(`  iter ${i + 1}/${ITERS}: ${r.ms.toFixed(2)} ms (count=${r.count})`);
      } catch (err) {
        console.log(`  ⚠️  iter ${i + 1}/${ITERS} failed: ${err.message}`);
        break;
      }
    }
    
    if (results.length > 0) {
      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      console.log(`  avg: ${avg.toFixed(2)} ms`);
    }
  }

  console.log('\n=== Baseline (no CPU load) ===\n');
  
  for (const t of targets) {
    console.log(`\n${t.name.toUpperCase()} parser (baseline):`);
    const results = [];
    
    try {
      // warmup
      await Promise.race([
        runOne({consumerFile: t.file, withCpuLoad: false}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 20000))
      ]);
    } catch (err) {
      console.log(`  ⚠️  Warmup failed: ${err.message}, skipping...`);
      continue;
    }
    
    for (let i = 0; i < ITERS; i++) {
      try {
        const r = await Promise.race([
          runOne({consumerFile: t.file, withCpuLoad: false}),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Iteration timeout')), 20000))
        ]);
        results.push(r.ms);
        console.log(`  iter ${i + 1}/${ITERS}: ${r.ms.toFixed(2)} ms (count=${r.count})`);
      } catch (err) {
        console.log(`  ⚠️  iter ${i + 1}/${ITERS} failed: ${err.message}`);
        break;
      }
    }
    
    if (results.length > 0) {
      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      console.log(`  avg: ${avg.toFixed(2)} ms`);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

