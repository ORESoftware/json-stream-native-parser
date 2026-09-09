#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { JSONParser } from '../dist/main.js';

async function collectStream(readable) {
  return await new Promise((resolve, reject) => {
    const out = [];
    readable.on('data', value => out.push(value));
    readable.on('error', reject);
    readable.on('end', () => resolve(out));
  });
}

async function parseAtSplit(payload, splitAt, opts = {}) {
  const parser = new JSONParser(opts);
  const input = new PassThrough();
  const output = collectStream(input.pipe(parser));
  const bytes = Buffer.from(payload, 'utf8');

  input.write(bytes.subarray(0, splitAt));
  input.end(bytes.subarray(splitAt));

  return await output;
}

async function assertEveryByteSplit(payload, expected, opts = {}) {
  const bytes = Buffer.from(payload, 'utf8');
  for (let splitAt = 1; splitAt < bytes.length; splitAt += 1) {
    const actual = await parseAtSplit(payload, splitAt, opts);
    assert.deepEqual(actual, expected, `failed at byte split ${splitAt}/${bytes.length}`);
  }
}

await assertEveryByteSplit(
  '{"city":"Lima","note":"café ☕ 🚲"}\n{"ok":true}\n',
  [{ city: 'Lima', note: 'café ☕ 🚲' }, { ok: true }]
);

await assertEveryByteSplit(
  '{"first":"mañana"}∆∆∆{"second":"東京"}∆∆∆',
  [{ first: 'mañana' }, { second: '東京' }],
  { delimiter: '∆∆∆' }
);

process.stdout.write('ok - UTF-8 JSON and multibyte delimiters survive every byte split\n');
