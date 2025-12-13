#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';

process.on('uncaughtException', err => {
  console.error('uncaughtException:', {err});
  process.exit(1);
});

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
  
  cat <<EOF
  
  {"foo":"$foo"}    ∆∆
  {"foo":"$foo"} ∆
  ∆{"foo":"$foo"}∆
EOF

`);

const to = setTimeout(() => {
  console.error('did not receive parsed JSON object within alloted time.');
  process.exit(1);
}, 2000);


let count = 0;

k.stdout.pipe(new JSONParser({delimiter:'∆'})).on('data', d => {
  
  count++;

  if(count > 3){
    throw new Error('too many json blobs.');
  }

  if(count === 3){
      clearTimeout(to);
      try {
        assert.deepStrictEqual(d, {foo: foo});
        process.exit(0);
      }
      catch (err) {
        console.error(err.message);
        process.exit(1);
      }
  }


});

