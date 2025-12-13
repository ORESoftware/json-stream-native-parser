#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';

process.on('unhandledRejection', (reason, p) => {
  // note: unless we force process to exit with 1, process may exit with 0 upon an unhandledRejection
  console.error(reason);
  process.exit(1);
});

import {JSONParser} from '@oresoftware/json-native-stream-parser';

console.log('Running test', import.meta.url);

const k = cp.spawn('bash');
const foo = 'medicine';

k.stdin.end(`

  foo="${foo}"
  cat <<EOF\n{"foo":"$foo"}\nEOF

`);

const to = setTimeout(() => {
  console.error('did not receive parsed JSON object within alloted time.');
  process.exit(1);
}, 300);

k.stdout.pipe(new JSONParser()).on('data', d => {
  
  clearTimeout(to);
  try {
    assert.deepStrictEqual(d, {foo: foo});
    process.exit(0);
  }
  catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  
});

