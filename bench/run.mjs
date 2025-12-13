#!/usr/bin/env node
'use strict';

import {spawn} from 'node:child_process';
import * as path from 'node:path';

const N = Number(process.env.N || 10000);
const ITERS = Number(process.env.ITERS || 3);

const root = path.resolve(new URL('..', import.meta.url).pathname);

function bashGeneratorCmd(n) {
  // Fast-ish bash loop using printf (avoids heavy echo quoting/escaping)
  return [
    'bash',
    ['-lc', `i=0; while [ $i -lt ${n} ]; do i=$((i+1)); printf '{"foo":%s,"bar":"baz","nested":{"x":%s}}\\n' "$i" "$i"; done`]
  ];
}

function runOne({consumerFile}) {
  return new Promise((resolve, reject) => {
    const [bash, bashArgs] = bashGeneratorCmd(N);
    const gen = spawn(bash, bashArgs, {cwd: root, stdio: ['ignore', 'pipe', 'inherit']});

    const consumer = spawn(process.execPath, [consumerFile], {cwd: root, stdio: ['pipe', 'pipe', 'inherit']});
    gen.stdout.pipe(consumer.stdin);

    let out = '';
    consumer.stdout.setEncoding('utf8');
    consumer.stdout.on('data', d => (out += d));

    consumer.on('error', reject);
    gen.on('error', reject);

    consumer.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`consumer exited with code ${code}`));
      }
      const line = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`could not parse consumer output: ${out}`));
      }
    });
  });
}

async function main() {
  const targets = [
    {name: 'ts', file: path.join(root, 'bench', 'js-consumer.mjs')},
    {name: 'native', file: path.join(root, 'bench', 'native-consumer.mjs')}
  ];

  const results = {};

  for (const t of targets) {
    results[t.name] = [];
    // warmup
    await runOne({consumerFile: t.file});
    for (let i = 0; i < ITERS; i++) {
      const r = await runOne({consumerFile: t.file});
      results[t.name].push(r.ms);
      process.stdout.write(`${t.name} iter ${i + 1}/${ITERS}: ${r.ms.toFixed(2)} ms (count=${r.count})\n`);
    }
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const tsAvg = avg(results.ts);
  const nativeAvg = avg(results.native);
  process.stdout.write('\n');
  process.stdout.write(`N=${N}, ITERS=${ITERS}\n`);
  process.stdout.write(`ts avg:     ${tsAvg.toFixed(2)} ms\n`);
  process.stdout.write(`native avg: ${nativeAvg.toFixed(2)} ms\n`);
  process.stdout.write(`speedup:    ${(tsAvg / nativeAvg).toFixed(2)}x (higher is better)\n`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});


