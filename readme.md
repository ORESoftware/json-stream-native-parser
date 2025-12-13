
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


### Native fd parser (worker thread, emits POJOs)

If you already have a **file descriptor** (for example from `fs.openSync()` or passed in from another process), you can parse it on a **native background thread** and stream **JS objects** back to the main thread (no `JSON.parse()` in JS-land).

Build the native addon:

```bash
npm run build:native
```

It also builds automatically on install via `postinstall`. To skip native compilation:

```bash
JSON_NATIVE_PARSER_SKIP_BUILD=1 npm i
```

Usage:

```js
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  createJsonParserNativeFromFd,
  createJsonParserNativeFromStdin,
  createJsonParserNativeFromPath,
  createJsonParserNativeFromSocket,
  RawStringSymbol,
  RawJSONBytesSymbol
} from '@oresoftware/json-native-stream-parser';

// 1) From a file path (auto-opens + auto-closes the FD)
const s1 = createJsonParserNativeFromPath('/path/to/file.jsonl', { delimiter: '\n' });

// 2) From stdin (fd=0)
// IMPORTANT: do not also do `process.stdin.pipe(...)` at the same time.
const s2 = createJsonParserNativeFromStdin({ delimiter: '\n' });

// 3) From any existing FD you already have
const fd = fs.openSync('/path/to/file.jsonl', 'r'); // you own this FD
const s3 = createJsonParserNativeFromFd(fd, { delimiter: '\n', closeFdOnEnd: false });

// 4) From a TCP socket (net.Socket)
// IMPORTANT: do not attach 'data' listeners / pipe() this socket in JS at the same time.
const sock = net.createConnection(6970, 'localhost');
const s4 = createJsonParserNativeFromSocket(sock, { delimiter: '\n' });

// 5) From a unix domain socket path (net.Socket)
const usock = net.createConnection({ path: '/tmp/my.sock' });
const s5 = createJsonParserNativeFromSocket(usock, { delimiter: '\n' });

const s = s1; // pick one of the above

s.on('data', (obj) => {
  // obj is a fully parsed POJO/array/value (nested OK)
  // metadata (if enabled) uses the same symbols as the TS parser:
  // obj[RawStringSymbol], obj[RawJSONBytesSymbol]
});

// Optional metadata + behavior flags:
const sWithMeta = createJsonParserNativeFromPath('/path/to/file.jsonl', {
  delimiter: '\n',
  batchSize: 64,
  includeRawString: true,
  includeByteCount: true,
  emitNonJSON: true
});

sWithMeta.on('string', (line) => {
  // only when emitNonJSON: true
});

sWithMeta.on('stats', (stats) => {
  // { bytesRead, bytesWritten, linesOk, linesFailed, ended }
});
```

#### Important caveat (sockets / stdin)

When you use `createJsonParserNativeFromStdin()` or `createJsonParserNativeFromSocket()`, **native code reads the FD directly**.
Do **not** also consume that same stream in JS-land (no `.pipe()`, no `'data'` listeners), or you’ll race for bytes.
