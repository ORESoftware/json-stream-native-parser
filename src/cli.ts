#!/usr/bin/env node
'use strict';

import {JSONParser, createJsonParserNativeFromFd} from './main.js';

// example use:  echo '{"foo":"bar", "zoo": {"star":3}}' | json_parser

// example output line 1: 'foo' '"bar"'
// example output line 2: 'zoo' '{"star":3}'

// it's always a tuple, key value, for top-level keys
// the key is always a string, the value is always a string parseable by JSON.parse().

const onData = (d: any) => {
  if (!(d && typeof d === 'object')) {
    console.error('json-parser: parsed value was not an object:', d);
    return;
  }

  return Object.keys(d).forEach(k => {
    console.log(`'${k}'`, `'${JSON.stringify(d[k])}'`);
  });
};

// Prefer native fd parser (reads fd=0 directly in a background thread),
// but fall back to the JS Transform parser if native isn't built/available.
try {
  const s = createJsonParserNativeFromFd(0, {debug: true});
  s.on('data', onData);
  s.on('string', (line: string) => {
    // if emitNonJSON ever becomes enabled in CLI
    console.error('json-parser: non-json line:', line);
  });
  s.on('error', (err: any) => {
    console.error('json-parser:', err?.message || err);
    process.exitCode = 1;
  });
} catch (err: any) {
  // Native addon not built/available → JS parser path.
  process.stdin.resume().pipe(new JSONParser({debug: true})).on('data', onData);
}
