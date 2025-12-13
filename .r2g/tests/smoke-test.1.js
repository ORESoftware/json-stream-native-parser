#!/usr/bin/env node
import assert from 'node:assert';
import {JSONParser} from '@oresoftware/json-native-stream-parser';

// Test that JSONParser works
const parser = new JSONParser();
let count = 0;

parser.on('data', () => {
  count++;
});

// Test with simple JSON
parser.write('{"foo":1}\n');
parser.write('{"bar":2}\n');
parser.end();

// Give it a moment to process
setTimeout(() => {
  assert.equal(count, 2, 'Should have parsed 2 objects');
  console.log('✓ JSONParser smoke test passed');
  process.exit(0);
}, 100);
