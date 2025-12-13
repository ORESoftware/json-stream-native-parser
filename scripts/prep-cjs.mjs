import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = new URL('../dist/cjs/', import.meta.url);
await mkdir(dir, { recursive: true });

// Ensure Node treats dist/cjs/*.js as CommonJS even though the package root is "type": "module".
await writeFile(join(dir.pathname, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

// Fix import.meta.url in CJS files - replace with __filename-based solution
const cjsDir = fileURLToPath(dir);
const workerFile = join(cjsDir, 'json-parser-worker.js');

try {
  let content = await readFile(workerFile, 'utf8');
  
  // Replace import.meta.url usage with __filename-based solution for CJS
  if (content.includes('import.meta.url')) {
    // Replace: const currentFileUrl = import.meta.url;
    // With: const currentFileUrl = 'file://' + __filename;
    content = content.replace(
      /const currentFileUrl = import\.meta\.url;/g,
      `const currentFileUrl = 'file://' + __filename;`
    );
    
    // Replace the workerScript line that uses fileURLToPath with currentFileUrl
    // Pattern: const workerScript = (0, node_url_1.fileURLToPath)(new URL('./json-parser-worker-thread.js', currentFileUrl));
    // Replace with: const workerScript = require('path').join(require('path').dirname(__filename), 'json-parser-worker-thread.js');
    content = content.replace(
      /const workerScript = \(0, node_url_1\.fileURLToPath\)\(new URL\('\.\/json-parser-worker-thread\.js', currentFileUrl\)\);/g,
      `const workerScript = require('path').join(require('path').dirname(__filename), 'json-parser-worker-thread.js');`
    );
    
    await writeFile(workerFile, content, 'utf8');
    console.log('Fixed import.meta.url in CJS worker file');
  }
} catch (err) {
  // File might not exist, that's okay
  if (err.code !== 'ENOENT') {
    console.warn('Warning: Could not fix CJS worker file:', err.message);
  }
}


