#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const N = Number(process.env.N || 100000);
const ITERS = Number(process.env.ITERS || 3);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 10);
const LOAD_PERIOD_MS = Number(process.env.LOAD_PERIOD_MS || 20);
const YIELD_EVERY = Number(process.env.YIELD_EVERY || 8192);

// Use 3 load levels by default: low/medium/high
const loads = (process.env.LOADS || '0,0.5,0.9')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = path.join(os.tmpdir(), `json-native-parser-compare-load-4x-${process.pid}-${Date.now()}.jsonl`);

function nestedObj(i) {
  // Nested objects + arrays, deterministic, single-line JSON.
  return {
    id: i,
    msg: 'hello',
    tags: ['a', 'b', 'c', i % 2 ? 'odd' : 'even'],
    nums: [i, i + 1, i + 2, i * 2],
    nested: {
      a: {b: {c: i}},
      list: [
        {k: 'v', n: i},
        {k: 'w', n: i + 1},
        {k: 'x', n: i + 2}
      ]
    },
    mix: [i, {x: i * 3, y: [1, 2, 3, {z: i}]} , [i, i + 1, i + 2]]
  };
}

function genFile() {
  const fd = fs.openSync(tmp, 'w');
  try {
    for (let i = 1; i <= N; i++) {
      fs.writeSync(fd, JSON.stringify(nestedObj(i)) + '\n');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function runConsumer(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {...process.env, ...env}
    });
    fs.createReadStream(tmp).pipe(child.stdin);

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => (out += d));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${file} exited with code ${code}`));
      const line = out.trim().split('\n').pop();
      resolve(JSON.parse(line));
    });
  });
}

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function objsPerSec(r) {
  return r.count / (r.ms / 1000);
}

async function runSuite(load) {
  const ts = [];
  const worker = [];
  const nativeBuf = [];
  const nativeCpp = [];

  const tsFile = path.join(root, 'bench', 'load-consumer-ts.mjs');
  const workerFile = path.join(root, 'bench', 'load-consumer-worker.mjs');
  const nativeFile = path.join(root, 'bench', 'load-consumer-native.mjs');

  // warmups
  await runConsumer(tsFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS});
  await runConsumer(workerFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS});
  await runConsumer(nativeFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, PASS_RAW_BUFFERS: '1'});
  await runConsumer(nativeFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, PASS_RAW_BUFFERS: '0'});

  for (let i = 0; i < ITERS; i++) {
    ts.push(await runConsumer(tsFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS}));
    worker.push(await runConsumer(workerFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS}));
    nativeBuf.push(await runConsumer(nativeFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, PASS_RAW_BUFFERS: '1'}));
    nativeCpp.push(await runConsumer(nativeFile, {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, PASS_RAW_BUFFERS: '0'}));
  }

  return {
    load,
    ts: {ms: avg(ts.map(x => x.ms)), objsPerSec: avg(ts.map(objsPerSec))},
    worker: {ms: avg(worker.map(x => x.ms)), objsPerSec: avg(worker.map(objsPerSec))},
    nativeBuf: {ms: avg(nativeBuf.map(x => x.ms)), objsPerSec: avg(nativeBuf.map(objsPerSec))},
    nativeCpp: {ms: avg(nativeCpp.map(x => x.ms)), objsPerSec: avg(nativeCpp.map(objsPerSec))}
  };
}

function fmt(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return Math.round(n).toLocaleString('en-US');
}

function loadLabel(load) {
  if (load <= 0.01) return 'Low';
  if (load <= 0.6) return 'Medium';
  return 'High';
}

async function main() {
  genFile();
  try {
    const rows = [];
    for (const l of loads) {
      rows.push(await runSuite(l));
    }

    // Emit JSON (for audit) then a markdown table (for humans)
    process.stdout.write(JSON.stringify({N, ITERS, INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, rows}, null, 2) + '\n');

    process.stdout.write('\n');
    process.stdout.write('| Main thread load | regular JS parses (TS) | webworker parser | native addon 1 (passRawBuffers=true) | native addon 2 (passRawBuffers=false) |\n');
    process.stdout.write('|---|---:|---:|---:|---:|\n');
    for (const r of rows) {
      process.stdout.write(
        `| ${loadLabel(r.load)} (${r.load}) | ${fmt(r.ts.objsPerSec)} | ${fmt(r.worker.objsPerSec)} | ${fmt(r.nativeBuf.objsPerSec)} | ${fmt(r.nativeCpp.objsPerSec)} |\n`
      );
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});


