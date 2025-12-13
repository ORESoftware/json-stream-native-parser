#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';

process.on('unhandledRejection', (reason, p) => {
  // note: unless we force process to exit with 1, process may exit with 0 upon an unhandledRejection
  console.error(reason);
  process.exit(1);
});

console.log('Running test', import.meta.url);

import {JSONParser} from '@oresoftware/json-native-stream-parser';

const k = cp.spawn('bash');
k.stdin.end(`echo '{"foo":"bar"}\n'`);

const to = setTimeout(() => {
  console.error('did not receive parsed JSON object within alloted time.');
  process.exit(1);
}, 300);

k.stdout.pipe(new JSONParser()).on('data', d => {
  
  clearTimeout(to);
  try {
    assert.deepStrictEqual(d, {foo: 'bar'});
    process.exit(0);
  }
  catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  
});

