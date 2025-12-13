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

const loads = (process.env.LOADS || '0,0.5,0.9')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = path.join(os.tmpdir(), `json-native-parser-compare-load-${process.pid}-${Date.now()}.jsonl`);

function genFile() {
  const fd = fs.openSync(tmp, 'w');
  try {
    for (let i = 1; i <= N; i++) {
      fs.writeSync(fd, `{"foo":${i},"bar":"baz","nested":{"x":${i}}}\n`);
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

async function runSuite(load) {
  const ts = [];
  const native = [];

  // warmups
  await runConsumer(path.join(root, 'bench', 'load-consumer-ts.mjs'), {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS});
  await runConsumer(path.join(root, 'bench', 'load-consumer-native.mjs'), {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY});

  for (let i = 0; i < ITERS; i++) {
    ts.push(await runConsumer(path.join(root, 'bench', 'load-consumer-ts.mjs'), {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS}));
    native.push(await runConsumer(path.join(root, 'bench', 'load-consumer-native.mjs'), {LOAD: String(load), INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY}));
  }

  return {
    load,
    ts: {
      ms: avg(ts.map(x => x.ms)),
      maxLagMs: avg(ts.map(x => x.maxLagMs))
    },
    native: {
      ms: avg(native.map(x => x.ms)),
      maxLagMs: avg(native.map(x => x.maxLagMs))
    }
  };
}

async function main() {
  genFile();
  try {
    const rows = [];
    for (const l of loads) {
      rows.push(await runSuite(l));
    }

    // Print a compact JSON and a human summary.
    process.stdout.write(JSON.stringify({N, ITERS, INTERVAL_MS, LOAD_PERIOD_MS, YIELD_EVERY, rows}, null, 2) + '\n');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});


