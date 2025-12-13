# Using JSON Stream Parser with TCP Connections

## Overview

This library provides multiple parsers optimized for different use cases:

- **`JSONParser`** (TypeScript Transform Stream) - Best for **streams** (TCP, stdin, pipes)
- **`createJsonParserNativeFromFd`** (Native C++ Parser) - Best for **file descriptors** (files, inherited FDs)

## TCP Connection Example

For TCP connections and other Node.js streams, use the **TypeScript `JSONParser`**:

```typescript
import * as net from 'net';
import {JSONParser} from '@oresoftware/json-stream-parser';

const [port, host] = [6970, 'localhost'];
const ws = net.createConnection(port, host);

// Pipe TCP stream through JSON parser
ws.setEncoding('utf8')
  .pipe(new JSONParser())   // TCP connection is bidirectional/full-duplex
  .on('data', (obj) => {
    // Receive parsed JSON objects from the TCP server
    console.log('Received:', obj);
  });

// Send JSON data to the server
ws.write(JSON.stringify({some: 'data'}) + '\n', 'utf8', (err) => {
  if (err) console.error('Write error:', err);
});
```

## Complete TCP Client Example

```typescript
import * as net from 'net';
import {JSONParser} from '@oresoftware/json-stream-parser';

function createTcpJsonClient(port: number, host: string) {
  const client = net.createConnection(port, host);
  
  // Create JSON parser
  const parser = new JSONParser({
    delimiter: '\n',  // Default delimiter
    emitNonJSON: true  // Emit non-JSON lines as 'string' events
  });
  
  // Pipe TCP stream to parser
  client.setEncoding('utf8').pipe(parser);
  
  // Handle parsed JSON objects
  parser.on('data', (obj) => {
    console.log('Received JSON object:', obj);
    // Process your data here
  });
  
  // Handle non-JSON lines (if emitNonJSON is enabled)
  parser.on('string', (line) => {
    console.log('Received non-JSON line:', line);
  });
  
  // Handle connection events
  client.on('connect', () => {
    console.log('Connected to server');
    
    // Send JSON data
    client.write(JSON.stringify({type: 'hello', message: 'world'}) + '\n');
  });
  
  client.on('error', (err) => {
    console.error('Connection error:', err);
  });
  
  client.on('close', () => {
    console.log('Connection closed');
  });
  
  return {
    send: (data: any) => {
      client.write(JSON.stringify(data) + '\n', 'utf8');
    },
    close: () => {
      client.end();
    }
  };
}

// Usage
const client = createTcpJsonClient(6970, 'localhost');

// Send data
client.send({command: 'getStatus'});
client.send({command: 'update', value: 42});

// Close connection
// client.close();
```

## TCP Server Example

```typescript
import * as net from 'net';
import {JSONParser} from '@oresoftware/json-stream-parser';

const server = net.createServer((socket) => {
  console.log('Client connected');
  
  // Create parser for this connection
  const parser = new JSONParser();
  
  // Pipe socket to parser
  socket.setEncoding('utf8').pipe(parser);
  
  // Handle parsed JSON objects
  parser.on('data', (obj) => {
    console.log('Received from client:', obj);
    
    // Echo back with response
    socket.write(JSON.stringify({
      echo: obj,
      timestamp: Date.now()
    }) + '\n');
  });
  
  socket.on('end', () => {
    console.log('Client disconnected');
  });
});

server.listen(6970, () => {
  console.log('TCP JSON server listening on port 6970');
});
```

## When to Use Native Parser vs TS Parser

### Use `JSONParser` (TS Transform Stream) for:
- ✅ **TCP/WebSocket connections** (streams)
- ✅ **stdin/stdout** (process streams)
- ✅ **Child process pipes** (spawn stdout)
- ✅ **HTTP request/response streams**
- ✅ **Any Node.js Readable stream**

### Use `createJsonParserNativeFromFd` (Native) for:
- ✅ **File descriptors** (from `fs.openSync()`)
- ✅ **Inherited file descriptors** (passed from parent process)
- ✅ **Large file processing** (better performance)
- ✅ **When main thread is busy** (background I/O thread)

## Performance Comparison

For **streams** (TCP, stdin, etc.):
- **`JSONParser`** is the only option (streams don't have file descriptors)
- Very fast when main thread is idle (~16ms for 5K objects)

For **file descriptors**:
- **Native-optimized** is faster under load (1.5x slower at 90% CPU vs 1.0x idle)
- **`JSONParser`** can also work with file streams via `fs.createReadStream()`

## Custom Delimiters

If your JSON is separated by something other than newlines:

```typescript
// Use custom delimiter
const parser = new JSONParser({
  delimiter: '∆∆∆'  // Use 3 deltas to separate JSON chunks
});

socket.pipe(parser);
```

## Error Handling

```typescript
const parser = new JSONParser();

parser.on('error', (err) => {
  console.error('Parse error:', err);
  // Parser continues processing other chunks
});

parser.on('data', (obj) => {
  try {
    // Process object
  } catch (err) {
    console.error('Processing error:', err);
  }
});
```

## Metadata (Raw String and Byte Count)

```typescript
import {JSONParser, RawStringSymbol, RawJSONBytesSymbol} from '@oresoftware/json-stream-parser';

const parser = new JSONParser({
  includeRawString: true,
  includeByteCount: true
});

parser.on('data', (obj) => {
  // Access metadata
  const rawJson = obj[RawStringSymbol];      // Original JSON string
  const byteCount = obj[RawJSONBytesSymbol]; // Byte count
  
  // Your parsed object
  console.log('Parsed:', obj);
});
```

