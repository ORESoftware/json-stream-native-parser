#!/usr/bin/env node
/**
 * Modern native addon build script with fallback support
 * Tries cmake-js first, then node-gyp-build, then node-gyp
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      shell: true,
      cwd: projectRoot
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function checkCommandAvailable(command) {
  return new Promise((resolve) => {
    const proc = spawn(command, ['--version'], {
      stdio: 'ignore',
      shell: true
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function tryBuild() {
  const methods = [
    {
      name: 'cmake-js',
      check: async () => {
        if (!existsSync(join(projectRoot, 'CMakeLists.txt'))) {
          return false;
        }
        // Try to use npx cmake-js (doesn't require global install)
        return await checkCommandAvailable('npx cmake-js');
      },
      build: async () => {
        console.log('🔨 Building with cmake-js (modern CMake-based build)...');
        await runCommand('npx', ['-y', 'cmake-js', 'compile']);
      }
    },
    {
      name: 'node-gyp-build',
      check: async () => {
        if (!existsSync(join(projectRoot, 'binding.gyp'))) {
          return false;
        }
        // Try to use npx node-gyp-build (doesn't require global install)
        return await checkCommandAvailable('npx node-gyp-build');
      },
      build: async () => {
        console.log('🔨 Building with node-gyp-build (modern wrapper)...');
        await runCommand('npx', ['-y', 'node-gyp-build', 'rebuild']);
      }
    },
    {
      name: 'node-gyp',
      check: async () => {
        if (!existsSync(join(projectRoot, 'binding.gyp'))) {
          return false;
        }
        // node-gyp is usually available via npm/npx
        return await checkCommandAvailable('npx node-gyp');
      },
      build: async () => {
        console.log('🔨 Building with node-gyp (traditional fallback)...');
        await runCommand('npx', ['-y', 'node-gyp', 'rebuild']);
      }
    }
  ];

  for (const method of methods) {
    if (await method.check()) {
      try {
        await method.build();
        console.log(`✅ Successfully built with ${method.name}`);
        return true;
      } catch (err) {
        console.warn(`⚠️  ${method.name} failed:`, err.message);
        // Continue to next method
      }
    }
  }

  return false;
}

// Main execution
tryBuild().then((success) => {
  if (!success) {
    console.error('❌ All build methods failed. Native addon will not be available.');
    console.error('💡 The package will work but native parser will be unavailable.');
    console.error('💡 To enable native parser, install one of:');
    console.error('   - cmake-js: npm install -g cmake-js (requires CMake)');
    console.error('   - node-gyp-build: npm install -g node-gyp-build');
    console.error('   - node-gyp: npm install -g node-gyp (usually bundled with npm)');
    // Don't exit with error - allow package to work without native addon
    process.exit(0);
  }
}).catch((err) => {
  console.error('❌ Build script error:', err);
  // Don't exit with error - allow package to work without native addon
  process.exit(0);
});

