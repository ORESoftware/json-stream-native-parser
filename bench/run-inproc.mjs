#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import {JSONParser, createJsonParserNativeFromFd} from '../dist/main.js';

const N = Number(process.env.N || 10000);
const ITERS = Number(process.env.ITERS || 5);

function bashGenerator(n) {
  // printf loop is faster than echo-with-escaping
  const cmd = `i=0; while [ $i -lt ${n} ]; do i=$((i+1)); printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\\n' "$i" "$i"; done`;
  return spawn('bash', ['-lc', cmd], {stdio: ['ignore', 'pipe', 'inherit']});
}

function hrMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function runTsOnce() {
  return await new Promise((resolve, reject) => {
    const child = bashGenerator(N);
    const t0 = process.hrtime.bigint();
    let count = 0;

    child.stdout
      .pipe(new JSONParser())
      .on('data', () => count++)
      .on('error', reject)
      .on('end', () => resolve({impl: 'ts', count, ms: hrMs(t0)}));

    child.on('error', reject);
  });
}

async function runNativeOnce() {
  return await new Promise((resolve, reject) => {
    const child = bashGenerator(N);
    // IMPORTANT: do not consume child.stdout in JS; native thread will read it via fd
    child.stdout.pause();

    const fd = child.stdout?._handle?.fd;
    if (typeof fd !== 'number') {
      child.kill('SIGKILL');
      return reject(new Error('Could not obtain fd for child.stdout (expected child.stdout._handle.fd to be a number).'));
    }

    const t0 = process.hrtime.bigint();
    let count = 0;
    const s = createJsonParserNativeFromFd(fd, {delimiter: '\n', batchSize: 256});

    s.on('data', () => count++);
    s.on('error', (e) => reject(e));
    s.on('end', () => resolve({impl: 'native', count, ms: hrMs(t0)}));

    child.on('error', reject);
  });
}

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

async function main() {
  const results = {ts: [], native: []};

  // warmups
  await runTsOnce();
  await runNativeOnce();

  for (let i = 0; i < ITERS; i++) {
    const r1 = await runTsOnce();
    results.ts.push(r1.ms);
    process.stdout.write(`ts iter ${i + 1}/${ITERS}: ${r1.ms.toFixed(2)} ms (count=${r1.count})\n`);
  }

  for (let i = 0; i < ITERS; i++) {
    const r2 = await runNativeOnce();
    results.native.push(r2.ms);
    process.stdout.write(`native iter ${i + 1}/${ITERS}: ${r2.ms.toFixed(2)} ms (count=${r2.count})\n`);
  }

  const tsAvg = avg(results.ts);
  const nativeAvg = avg(results.native);

  process.stdout.write('\n');
  process.stdout.write(`INPROC N=${N}, ITERS=${ITERS}\n`);
  process.stdout.write(`ts avg:     ${tsAvg.toFixed(2)} ms\n`);
  process.stdout.write(`native avg: ${nativeAvg.toFixed(2)} ms\n`);
  process.stdout.write(`speedup:    ${(tsAvg / nativeAvg).toFixed(2)}x (higher is better)\n`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});


