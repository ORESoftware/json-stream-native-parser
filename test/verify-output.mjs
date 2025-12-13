#!/usr/bin/env node
/**
 * Verify that output POJSOs correctly represent the input stream
 * Tests round-trip: input JSON -> parse -> output POJSO -> stringify -> should match input
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  JSONParser,
  createJsonParserNativeFromFd,
  createJsonParserWorkerFromFd
} from '../dist/main.js';

async function collectStream(readable) {
  return await new Promise((resolve, reject) => {
    const out = [];
    readable.on('data', v => out.push(v));
    readable.on('error', reject);
    readable.on('end', () => resolve(out));
  });
}

function roundTripTest(inputJson, expectedObj) {
  const inputStr = JSON.stringify(inputJson);
  const parsed = JSON.parse(inputStr);
  const outputStr = JSON.stringify(parsed);
  assert.equal(outputStr, inputStr, 'Round-trip should match');
  assert.deepEqual(parsed, expectedObj, 'Parsed object should match expected');
  return parsed;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// Test cases with various JSON structures
const testCases = [
  { input: '{"a":1}\n', expected: { a: 1 } },
  { input: '{"b":2,"c":"hello"}\n', expected: { b: 2, c: 'hello' } },
  { input: '{"nested":{"deep":{"value":42}}}\n', expected: { nested: { deep: { value: 42 } } } },
  { input: '{"arr":[1,2,3]}\n', expected: { arr: [1, 2, 3] } },
  { input: '{"arr":[1,{"nested":true},3]}\n', expected: { arr: [1, { nested: true }, 3] } },
  { input: '{"null":null,"bool":true,"num":123.45}\n', expected: { null: null, bool: true, num: 123.45 } },
  { input: '{"empty":{},"emptyArr":[]}\n', expected: { empty: {}, emptyArr: [] } },
  { input: '{"unicode":"你好世界"}\n', expected: { unicode: '你好世界' } },
  { input: '{"escaped":"line1\\nline2"}\n', expected: { escaped: 'line1\nline2' } },
];

await test('JSONParser: Output POJSOs match input stream (round-trip)', async () => {
  for (const testCase of testCases) {
    const p = new JSONParser();
    const input = new PassThrough();
    const outP = collectStream(input.pipe(p));
    input.end(testCase.input);
    const out = await outP;
    
    assert.equal(out.length, 1, `Should emit exactly 1 object for: ${testCase.input.trim()}`);
    
    // Verify the object matches expected
    assert.deepEqual(out[0], testCase.expected, `Object should match expected for: ${testCase.input.trim()}`);
    
    // Round-trip test: stringify the output and it should match the input JSON (minus delimiter)
    const outputStr = JSON.stringify(out[0]);
    const inputJson = testCase.input.trim();
    assert.equal(outputStr, inputJson, `Round-trip should match for: ${testCase.input.trim()}`);
  }
});

await test('JSONParser: Multiple objects in stream', async () => {
  const input = '{"a":1}\n{"b":2}\n{"c":3}\n';
  const p = new JSONParser();
  const stream = new PassThrough();
  const outP = collectStream(stream.pipe(p));
  stream.end(input);
  const out = await outP;
  
  assert.equal(out.length, 3);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  
  // Verify round-trip for each
  assert.equal(JSON.stringify(out[0]), '{"a":1}');
  assert.equal(JSON.stringify(out[1]), '{"b":2}');
  assert.equal(JSON.stringify(out[2]), '{"c":3}');
});

await test('JSONParser: Nested objects and arrays', async () => {
  const input = '{"obj":{"nested":{"value":42},"arr":[1,2,{"item":3}]}}\n';
  const p = new JSONParser();
  const stream = new PassThrough();
  const outP = collectStream(stream.pipe(p));
  stream.end(input);
  const out = await outP;
  
  assert.equal(out.length, 1);
  const expected = { obj: { nested: { value: 42 }, arr: [1, 2, { item: 3 }] } };
  assert.deepEqual(out[0], expected);
  
  // Round-trip
  assert.equal(JSON.stringify(out[0]), input.trim());
});

await test('Native parser: Output POJSOs match input stream (round-trip)', async () => {
  const tmp = path.join(os.tmpdir(), `json-native-parser-verify-${process.pid}-${Date.now()}.jsonl`);
  
  try {
    // Write test cases to file
    const fileContent = testCases.map(tc => tc.input.trim()).join('\n');
    fs.writeFileSync(tmp, fileContent + '\n', 'utf8');
    
    const fd = fs.openSync(tmp, 'r');
    try {
      let parser;
      try {
        parser = createJsonParserNativeFromFd(fd, { delimiter: '\n' });
      } catch (err) {
        if (err && err.code === 'NATIVE_ADDON_NOT_BUILT') {
          console.log('  (skipped - native addon not built)');
          return;
        }
        throw err;
      }
      
      const out = await collectStream(parser);
      assert.equal(out.length, testCases.length, 'Should emit all objects');
      
      // Verify each object matches expected and round-trips
      for (let i = 0; i < testCases.length; i++) {
        assert.deepEqual(out[i], testCases[i].expected, `Object ${i} should match expected`);
        const outputStr = JSON.stringify(out[i]);
        const inputJson = testCases[i].input.trim();
        assert.equal(outputStr, inputJson, `Round-trip should match for object ${i}`);
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

await test('Worker parser: Output POJSOs match input stream (round-trip)', async () => {
  const tmp = path.join(os.tmpdir(), `json-worker-parser-verify-${process.pid}-${Date.now()}.jsonl`);
  
  try {
    // Write test cases to file
    const fileContent = testCases.map(tc => tc.input.trim()).join('\n');
    fs.writeFileSync(tmp, fileContent + '\n', 'utf8');
    
    const fd = fs.openSync(tmp, 'r');
    try {
      const parser = createJsonParserWorkerFromFd(fd, { delimiter: '\n' });
      const out = await collectStream(parser);
      
      assert.equal(out.length, testCases.length, 'Should emit all objects');
      
      // Verify each object matches expected and round-trips
      for (let i = 0; i < testCases.length; i++) {
        assert.deepEqual(out[i], testCases[i].expected, `Object ${i} should match expected`);
        const outputStr = JSON.stringify(out[i]);
        const inputJson = testCases[i].input.trim();
        assert.equal(outputStr, inputJson, `Round-trip should match for object ${i}`);
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

await test('All parsers: Complex nested structure round-trip', async () => {
  const complexJson = {
    "level1": {
      "level2": {
        "level3": {
          "array": [
            {"item": 1, "nested": {"value": "a"}},
            {"item": 2, "nested": {"value": "b"}},
            {"item": 3, "nested": {"value": "c"}}
          ],
          "mixed": {
            "strings": ["hello", "world"],
            "numbers": [1, 2, 3.14],
            "booleans": [true, false],
            "nulls": [null, null]
          }
        }
      }
    }
  };
  
  const inputStr = JSON.stringify(complexJson) + '\n';
  
  // Test JSONParser
  {
    const p = new JSONParser();
    const stream = new PassThrough();
    const outP = collectStream(stream.pipe(p));
    stream.end(inputStr);
    const out = await outP;
    
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], complexJson);
    assert.equal(JSON.stringify(out[0]), inputStr.trim());
  }
  
  // Test Native parser
  {
    const tmp = path.join(os.tmpdir(), `json-native-complex-${process.pid}-${Date.now()}.jsonl`);
    try {
      fs.writeFileSync(tmp, inputStr, 'utf8');
      const fd = fs.openSync(tmp, 'r');
      try {
        let parser;
        try {
          parser = createJsonParserNativeFromFd(fd, { delimiter: '\n' });
        } catch (err) {
          if (err && err.code === 'NATIVE_ADDON_NOT_BUILT') {
            console.log('  (skipped - native addon not built)');
          } else {
            throw err;
          }
        }
        
        if (parser) {
          const out = await collectStream(parser);
          assert.equal(out.length, 1);
          assert.deepEqual(out[0], complexJson);
          assert.equal(JSON.stringify(out[0]), inputStr.trim());
        }
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  
  // Test Worker parser
  {
    const tmp = path.join(os.tmpdir(), `json-worker-complex-${process.pid}-${Date.now()}.jsonl`);
    try {
      fs.writeFileSync(tmp, inputStr, 'utf8');
      const fd = fs.openSync(tmp, 'r');
      try {
        const parser = createJsonParserWorkerFromFd(fd, { delimiter: '\n' });
        const out = await collectStream(parser);
        
        assert.equal(out.length, 1);
        assert.deepEqual(out[0], complexJson);
        assert.equal(JSON.stringify(out[0]), inputStr.trim());
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
});

console.log('\n✅ All output verification tests passed!');

