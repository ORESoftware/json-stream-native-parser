#!/usr/bin/env node
/**
 * Comprehensive benchmark comparing all 4 parser implementations:
 * 1. Regular JS parser (JSONParser - TypeScript Transform Stream)
 * 2. Web Worker parser (createJsonParserWorkerFromFd)
 * 3. Native addon 1 (passRawBuffers: true - optimized mode)
 * 4. Native addon 2 (passRawBuffers: false - C++ parsing mode)
 * 
 * Tests under low, medium, and high CPU load on main thread.
 * Uses nested JSON objects/arrays.
 * Reports JSON blobs per second.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// Import parsers
import { JSONParser, createJsonParserNativeFromFd, createJsonParserWorkerFromFd } from '../dist/main.js';

// Configuration
const N = 5000; // Number of JSON objects
const ITERS = 3; // Number of iterations per test
const CPU_LOADS = {
  low: 0.1,    // 10% CPU load
  medium: 0.5, // 50% CPU load
  high: 0.9    // 90% CPU load
};

// Generate nested JSON test data
function generateNestedJSON(index) {
  return {
    id: index,
    name: `Item ${index}`,
    metadata: {
      created: Date.now(),
      tags: ['tag1', 'tag2', 'tag3'],
      nested: {
        level: 2,
        data: {
          values: [1, 2, 3, 4, 5],
          flags: { active: true, verified: false },
          deep: {
            x: index * 2,
            y: index * 3,
            z: [index, index + 1, index + 2]
          }
        }
      }
    },
    items: [
      { a: 1, b: 2, c: { d: 3 } },
      { a: 4, b: 5, c: { d: 6 } },
      { a: 7, b: 8, c: { d: 9 } }
    ],
    scores: [10, 20, 30, 40, 50],
    active: index % 2 === 0
  };
}

// Create CPU load on main thread
function startCpuLoad(targetLoad) {
  if (targetLoad === 0) return () => {};
  
  let running = true;
  const interval = setInterval(() => {
    if (!running) {
      clearInterval(interval);
      return;
    }
    const start = Date.now();
    // Busy-wait to consume CPU
    while (Date.now() - start < (targetLoad * 10)) {
      // Spin
    }
  }, 10);
  
  return () => {
    running = false;
    clearInterval(interval);
  };
}

// Benchmark a single parser implementation
async function benchmarkParser(name, createParser, loadLevel, loadValue) {
  const results = [];
  
  for (let iter = 0; iter < ITERS; iter++) {
    // Create temp file with test data
    const tmpFile = path.join(os.tmpdir(), `json-parser-bench-${process.pid}-${Date.now()}-${iter}.jsonl`);
    const lines = [];
    for (let i = 0; i < N; i++) {
      lines.push(JSON.stringify(generateNestedJSON(i)) + '\n');
    }
    fs.writeFileSync(tmpFile, lines.join(''), 'utf8');
    
    // Start CPU load
    const stopCpuLoad = startCpuLoad(loadValue);
    
    try {
      const start = process.hrtime.bigint();
      let count = 0;
      let error = null;
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout'));
        }, 60000); // 60 second timeout
        
        const parser = createParser(tmpFile);
        
        parser.on('data', () => {
          count++;
        });
        
        parser.on('end', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        parser.on('error', (err) => {
          clearTimeout(timeout);
          error = err;
          reject(err);
        });
      });
      
      stopCpuLoad();
      
      if (error) {
        throw error;
      }
      
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // Convert to ms
      const blobsPerSecond = (count / elapsed) * 1000;
      
      results.push({
        count,
        elapsed,
        blobsPerSecond
      });
      
      // Cleanup
      try { fs.unlinkSync(tmpFile); } catch {}
    } catch (err) {
      stopCpuLoad();
      try { fs.unlinkSync(tmpFile); } catch {}
      throw err;
    }
  }
  
  // Calculate average
  const avgBlobsPerSecond = results.reduce((sum, r) => sum + r.blobsPerSecond, 0) / results.length;
  const avgElapsed = results.reduce((sum, r) => sum + r.elapsed, 0) / results.length;
  
  return {
    name,
    loadLevel,
    avgBlobsPerSecond,
    avgElapsed,
    results
  };
}

// Parser factory functions
function createJSParser(filePath) {
  const parser = new JSONParser();
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  stream.pipe(parser);
  return parser;
}

function createWorkerParser(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const parser = createJsonParserWorkerFromFd(fd, {
    delimiter: '\n',
    batchSize: 512
  });
  parser.on('end', () => {
    try { fs.closeSync(fd); } catch {}
  });
  return parser;
}

function createNativeParser1(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const parser = createJsonParserNativeFromFd(fd, {
    delimiter: '\n',
    batchSize: 2048,
    passRawBuffers: true // Optimized mode
  });
  parser.on('end', () => {
    try { fs.closeSync(fd); } catch {}
  });
  return parser;
}

function createNativeParser2(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const parser = createJsonParserNativeFromFd(fd, {
    delimiter: '\n',
    batchSize: 2048,
    passRawBuffers: false // C++ parsing mode
  });
  parser.on('end', () => {
    try { fs.closeSync(fd); } catch {}
  });
  return parser;
}

// Main benchmark function
async function runBenchmarks() {
  console.log('🚀 Starting comprehensive parser benchmark...\n');
  console.log(`Configuration:`);
  console.log(`  - Objects per test: ${N.toLocaleString()}`);
  console.log(`  - Iterations per test: ${ITERS}`);
  console.log(`  - CPU Load levels: Low (10%), Medium (50%), High (90%)\n`);
  
  const parsers = [
    { name: 'Regular JS Parser', factory: createJSParser },
    { name: 'Web Worker Parser', factory: createWorkerParser },
    { name: 'Native Addon 1 (passRawBuffers: true)', factory: createNativeParser1 },
    { name: 'Native Addon 2 (passRawBuffers: false)', factory: createNativeParser2 }
  ];
  
  const allResults = [];
  
  for (const [loadName, loadValue] of Object.entries(CPU_LOADS)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing under ${loadName.toUpperCase()} CPU load (${(loadValue * 100).toFixed(0)}%)`);
    console.log('='.repeat(60));
    
    for (const parser of parsers) {
      try {
        console.log(`\n  Testing: ${parser.name}...`);
        const result = await benchmarkParser(parser.name, parser.factory, loadName, loadValue);
        allResults.push(result);
        console.log(`    ✓ Average: ${result.avgBlobsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} blobs/sec (${result.avgElapsed.toFixed(2)} ms)`);
      } catch (err) {
        console.error(`    ✗ Error: ${err.message}`);
        allResults.push({
          name: parser.name,
          loadLevel: loadName,
          avgBlobsPerSecond: 0,
          avgElapsed: 0,
          error: err.message
        });
      }
    }
  }
  
  // Generate results table
  console.log('\n\n' + '='.repeat(80));
  console.log('RESULTS TABLE: JSON Blobs Per Second');
  console.log('='.repeat(80));
  console.log();
  
  // Header
  const header = '| Parser | Low Load (10%) | Medium Load (50%) | High Load (90%) |';
  const separator = '|' + header.split('|').slice(1, -1).map(() => '---').join('|') + '|';
  console.log(header);
  console.log(separator);
  
  // Data rows
  for (const parser of parsers) {
    const row = [
      parser.name,
      ...['low', 'medium', 'high'].map(load => {
        const result = allResults.find(r => r.name === parser.name && r.loadLevel === load);
        if (!result || result.error) return 'N/A';
        return result.avgBlobsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 });
      })
    ];
    console.log('| ' + row.join(' | ') + ' |');
  }
  
  console.log();
  console.log('='.repeat(80));
  console.log('Detailed Results:');
  console.log('='.repeat(80));
  
  for (const result of allResults) {
    if (result.error) {
      console.log(`\n${result.name} (${result.loadLevel}): ERROR - ${result.error}`);
    } else {
      console.log(`\n${result.name} (${result.loadLevel}):`);
      console.log(`  Average: ${result.avgBlobsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} blobs/sec`);
      console.log(`  Average time: ${result.avgElapsed.toFixed(2)} ms`);
      console.log(`  Individual runs: ${result.results.map(r => r.blobsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })).join(', ')} blobs/sec`);
    }
  }
  
  // Save to CSV
  const csvFile = path.join(ROOT, 'bench', 'all-4-parsers-results.csv');
  const csvLines = [
    'Parser,Load Level,Blobs Per Second,Time (ms)',
    ...allResults.map(r => {
      if (r.error) {
        return `${r.name},${r.loadLevel},ERROR,${r.error}`;
      }
      return `${r.name},${r.loadLevel},${r.avgBlobsPerSecond.toFixed(2)},${r.avgElapsed.toFixed(2)}`;
    })
  ];
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n', 'utf8');
  console.log(`\n\n📊 Results saved to: ${csvFile}`);
}

// Run benchmarks
runBenchmarks().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

