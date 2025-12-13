
## @oresoftware/json-stream-parser

[![Version](https://img.shields.io/npm/v/@oresoftware/json-stream-parser.svg?colorB=green)](https://www.npmjs.com/package/@oresoftware/json-stream-parser)


### Transform stream

>
>  Transforms JSON stream to JS Objects
>

### Installation

```bash

$ npm install '@oresoftware/json-stream-parser'

```

### Import

```js

import {JSONParser} from '@oresoftware/json-stream-parser';

```

### Import (CommonJS)

```js

const {JSONParser} = require('@oresoftware/json-stream-parser');

```

### Usage

Right now, the library assumes each separate chunk of json is separated by newline characters. <br>
In the future, we could attempt to use a different delimiting character, as a user-provided input variable. <br>
Recommendations welcome.


## Examples

#### Simple Node.js example:

###### Reading from stdin

```typescript

process.stdin.resume().pipe(new JSONParser()).on('data', d => {
  // now we got some POJSOs!
});

```

###### Reading/writing to a tcp socket

```typescript

import * as net from 'net';
const [port,host] = [6970,'localhost'];
const ws = net.createConnection(port, host);

ws.setEncoding('utf8')
  .pipe(new JSONParser())   // tcp connection is bidirection/full-duplex .. we send JSON strings each way
  .on('data', onData);    // we receive data coming from the tcp server here


// and we send data like this:
ws.write(JSON.stringify({'some':'data'}) + '\n', 'utf8', cb); // make sure to include the newline char when you write

```

#### Using bash shell

###### Simple bash example:

```js

const k = cp.spawn('bash');
k.stdin.end(`echo '{"foo":"bar"}\n'`);  // make sure to include the newline char when you write

k.stdout.pipe(new JSONParser()).on('data', d => {
  // => {foo: 'bar'}
});

```

###### Bash example with bash variables:

```js

const k = cp.spawn('bash');

k.stdin.end(`

  foo="medicine"
  cat <<EOF\n{"foo":"$foo"}\nEOF  # make sure to include the newline char when you write

`);

k.stdout.pipe(new JSONParser()).on('data', d => {
    assert.deepStrictEqual(d, {foo: 'medicine'});  // should pass
});


```

### If your JSON has white space (newlines etc)

If you JSON has unescaped newlines, or the JSON is separated by some other character, then use the delimiter option.

```js
new JSONParser({delimiter: '∆∆∆'});  // use 3 alt-j's to separate json chunks, since newlines won't work

```

For other solutions to parsing JSON from CLIs, see:
https://stackoverflow.com/questions/56014438/get-single-line-json-from-aws-cli



### Other options

1. delayEvery: integer  

> every x chunks, will use setImmediate to delay processing, good for not blocking the event loop too much.


2. emitNonJSON: boolean

> if there is a line of input that cannot be JSON parsed, it will be emitted as "string", but it will not pushed to output


3. there are some secret options in the code, have a look in `lib/main.ts`


### Native fd parser (optimized by default, emits POJOs)

If you already have a **file descriptor** (for example from `fs.openSync()` or passed in from another process), you can parse it on a **native C++ background thread** (`std::thread`) and stream **JS objects** back to the main thread.

**By default, the native parser uses optimized mode** (`passRawBuffers: true`) which:
- Uses **zero-copy external buffers** for efficient data transfer (just passes memory pointer)
- Leverages V8's highly optimized `JSON.parse()` on the main thread
- Provides better performance than worker threads (avoids structured cloning overhead)
- Works with **nested objects and arrays** of any depth

Build the native addon:

```bash
node-gyp rebuild
```

Usage:

```js
import * as fs from 'node:fs';
import {
  createJsonParserNativeFromFd,
  RawStringSymbol,
  RawJSONBytesSymbol
} from '@oresoftware/json-native-stream-parser';

const fd = fs.openSync('/path/to/file.jsonl', 'r');

// Optimized mode is the default (passRawBuffers: true)
const s = createJsonParserNativeFromFd(fd, {
  delimiter: '\n',
  batchSize: 2048,  // Larger batches for better performance
  includeRawString: true,
  includeByteCount: true,
  emitNonJSON: true
  // passRawBuffers: true is the default (can be set to false to use C++ parsing)
});

s.on('data', (obj) => {
  // obj is a fully parsed POJO/array/value (nested OK)
  // metadata (if enabled) uses the same symbols as the TS parser:
  // obj[RawStringSymbol], obj[RawJSONBytesSymbol]
});

s.on('string', (line) => {
  // only when emitNonJSON: true
});

s.on('stats', (stats) => {
  // { bytesRead, bytesWritten, linesOk, linesFailed, ended }
});
```

### Worker thread parser (alternative implementation)

For a pure JavaScript implementation using Node.js worker threads:

```js
import {createJsonParserWorkerFromFd} from '@oresoftware/json-native-stream-parser';

const fd = fs.openSync('/path/to/file.jsonl', 'r');

const s = createJsonParserWorkerFromFd(fd, {
  delimiter: '\n',
  batchSize: 512
});

s.on('data', (obj) => {
  // obj is a fully parsed POJO (parsed in worker thread, passed via structured cloning)
  // Works with nested objects and arrays
});
```

**Note:** The native parser is typically faster than the worker parser because:
- Native uses **zero-copy buffers** (just pointer transfer)
- Worker uses **structured cloning** (full serialization/deserialization of object graph)
- For nested objects, structured cloning overhead can be significant
