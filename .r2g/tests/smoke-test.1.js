#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import {JSONParser} from '@oresoftware/json-native-stream-parser';

const parser = new JSONParser();
let count = 0;

parser.on('data', () => {
  count++;
});

parser.write('{"foo":1}\n');
parser.write('{"bar":2}\n');
parser.end();

setTimeout(() => {
  assert.equal(count, 2, 'Should have parsed 2 objects');
  console.log('✓ JSONParser smoke test passed');
  process.exit(0);
}, 100);
