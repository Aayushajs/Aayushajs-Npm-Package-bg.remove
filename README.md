# @development-team/bg-remover

[![NPM Version](https://img.shields.io/npm/v/@development-team/bg-remover)](https://www.npmjs.com/package/@development-team/bg-remover)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org)

A production-ready Express middleware suite for **AI-powered image background removal** and **real-time OCR text extraction** — built on top of industrial-grade AI APIs with WebSocket streaming support.

---

## Features

| Feature | Description |
|---|---|
| Background Removal | Remove image backgrounds via a REST API call |
| OCR — Buffered | Extract all text from an image, result attached to `req` |
| OCR — Live Stream | Stream OCR results line-by-line to the client via SSE |
| Fail-Safe | Errors never crash your middleware chain — always calls `next()` |
| Retry Logic | Configurable retry attempts for transient failures |
| Zero-Config | Sensible defaults — most options are optional |

---

## Installation

```bash
npm install @development-team/bg-remover multer
```

> `multer` is required for handling `multipart/form-data` file uploads.

---

## Table of Contents

1. [Background Removal](#1-background-removal)
2. [OCR — Buffered Middleware](#2-ocr--buffered-middleware)
3. [OCR — Live SSE Stream Handler](#3-ocr--live-sse-stream-handler)
4. [Options Reference](#4-options-reference)
5. [Request Object Properties](#5-request-object-properties)
6. [Frontend Integration](#6-frontend-integration)
7. [Error Handling](#7-error-handling)
8. [Environment Variables](#8-environment-variables)
9. [Changelog](#9-changelog)

---

## 1. Background Removal

**`removeBgMiddleware(options)`**

Processes the uploaded image through an AI background removal API and attaches the result to `req.processedImage`. Always calls `next()` — even on failure.

### Basic Example

```javascript
const express = require('express');
const multer = require('multer');
const { removeBgMiddleware } = require('@development-team/bg-remover');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.post(
    '/remove-background',
    upload.single('image'),
    removeBgMiddleware({
        timeout: 15000,   // optional: 15s timeout
        retries: 2        // optional: retry twice on failure
    }),
    (req, res) => {
        if (req.bgError) {
            return res.status(500).json({ error: req.bgError.message });
        }

        if (!req.processedImage) {
            return res.status(400).json({ error: 'No valid image provided' });
        }

        // req.processedImage.buffer  → Buffer of the transparent PNG
        // req.processedImage.mimetype → 'image/png'

        res.set('Content-Type', req.processedImage.mimetype);
        res.send(req.processedImage.buffer);
    }
);
```

### Replace Original File In-Place

Set `replaceOriginal: true` to overwrite `req.file` directly. Useful when you want downstream middleware to receive the processed image transparently.

```javascript
app.post(
    '/upload',
    upload.single('image'),
    removeBgMiddleware({ replaceOriginal: true }),
    (req, res) => {
        if (req.bgError) return res.status(500).json({ error: 'Processing failed' });

        // req.file.buffer   → processed image buffer
        // req.file.mimetype → updated to 'image/png'
        // req.file.size     → updated to new file size
        // req.file filename → extension changed from .jpg to .png

        res.json({ message: 'Uploaded', size: req.file.size });
    }
);
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(built-in)* | REST endpoint for background removal POST. |
| `timeout` | `number` | `10000` | Request timeout in milliseconds. |
| `retries` | `number` | `2` | Retry attempts after a failed request. |
| `replaceOriginal` | `boolean` | `false` | If `true`, overwrites `req.file` with the processed image. |
| `fieldName` | `string` | `"file"` | Form-data field name sent to the external API. |

---

## 2. OCR — Buffered Middleware

**`ocrMiddleware(options)`**

Sends the uploaded image to an AI OCR server over **WebSocket**, waits for the full result, then attaches it to `req.ocrResult` and calls `next()`.

Use this when you want a standard request/response flow and don't need real-time streaming to your HTTP client.

### Basic Example

```javascript
const express = require('express');
const multer = require('multer');
const { ocrMiddleware } = require('@development-team/bg-remover');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.post(
    '/ocr',
    upload.single('image'),
    ocrMiddleware({
        wsUrl: process.env.OCR_WS_URL, // your OCR server WebSocket base URL
        timeout: 30000,
        retries: 1
    }),
    (req, res) => {
        if (req.ocrError) {
            return res.status(500).json({ error: req.ocrError.message });
        }

        res.json({
            full_text:   req.ocrResult.full_text,    // full extracted text
            total_lines: req.ocrResult.total_lines,   // number of lines detected
            lines:       req.ocrResult.lines          // [{text, confidence}, ...]
        });
    }
);
```

### Response Object Shape

```json
{
  "full_text": "Paracetamol 500mg\nTake 2 times a day.",
  "total_lines": 2,
  "lines": [
    { "text": "Paracetamol 500mg", "confidence": 0.985 },
    { "text": "Take 2 times a day.", "confidence": 0.912 }
  ]
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `wsUrl` | `string` | `OCR_WS_URL` env var | WebSocket **base URL** of the OCR server (e.g. `wss://your-space.hf.space`). |
| `timeout` | `number` | `30000` | Connection timeout in milliseconds. |
| `retries` | `number` | `1` | Retry attempts on failure. |

---

## 3. OCR — Live SSE Stream Handler

**`ocrStreamHandler(options)`**

A complete **route handler** (not a middleware) that pipes OCR events from the WebSocket server directly to the HTTP client as **Server-Sent Events (SSE)** — giving users a real-time "live typing" experience as text is extracted line-by-line.

> This is a **route handler**, not middleware — it sends the HTTP response itself. Do not call `next()` after it.

### Basic Example

```javascript
const express = require('express');
const multer = require('multer');
const { ocrStreamHandler } = require('@development-team/bg-remover');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// This single line is the entire route — no extra handler needed.
app.post(
    '/ocr/stream',
    upload.single('image'),
    ocrStreamHandler({
        wsUrl: process.env.OCR_WS_URL,
        timeout: 30000
    })
);
```

### SSE Event Stream Format

The client receives a stream of `text/event-stream` events:

```
data: {"event":"status","message":"Preprocessing image..."}

data: {"event":"status","message":"Extracting text..."}

data: {"event":"ocr_chunk","text":"Paracetamol 500mg","confidence":0.985}

data: {"event":"ocr_chunk","text":"Take 2 times a day.","confidence":0.912}

data: {"event":"ocr_complete","full_text":"Paracetamol 500mg\nTake 2 times a day."}
```

| Event | Fields | Description |
|---|---|---|
| `status` | `message` | Processing stage update |
| `ocr_chunk` | `text`, `confidence` | One detected line of text, streamed live |
| `ocr_complete` | `full_text` | Full extracted text — connection closes after this |
| `error` | `message` | Error from the OCR server or timeout |

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `wsUrl` | `string` | `OCR_WS_URL` env var | WebSocket **base URL** of the OCR server. |
| `timeout` | `number` | `30000` | Connection timeout in milliseconds. |

---

## 4. Options Reference (All Middlewares)

### `removeBgMiddleware(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(internal)* | Background removal API endpoint. |
| `timeout` | `number` | `10000` | HTTP request timeout (ms). |
| `retries` | `number` | `2` | Retry attempts on failure. |
| `replaceOriginal` | `boolean` | `false` | Overwrite `req.file` with the processed result. |
| `fieldName` | `string` | `"file"` | Form-data field name sent to the API. |

### `ocrMiddleware(options)` and `ocrStreamHandler(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `wsUrl` | `string` | `process.env.OCR_WS_URL` | WebSocket base URL of the OCR server. |
| `timeout` | `number` | `30000` | WebSocket connection timeout (ms). |
| `retries` | `number` | `1` | *(ocrMiddleware only)* Retry attempts on failure. |

---

## 5. Request Object Properties

After each middleware runs, the following properties are attached to the `req` object:

### `removeBgMiddleware`

| Property | Type | Set When |
|---|---|---|
| `req.processedImage.buffer` | `Buffer` | Success |
| `req.processedImage.mimetype` | `string` | Success |
| `req.bgError` | `Error` | All retries failed |

### `ocrMiddleware`

| Property | Type | Set When |
|---|---|---|
| `req.ocrResult.full_text` | `string` | Success |
| `req.ocrResult.lines` | `Array<{text, confidence}>` | Success |
| `req.ocrResult.total_lines` | `number` | Success |
| `req.ocrChunks` | `Array<{text, confidence}>` | Success (alias for `lines`) |
| `req.ocrError` | `Error` | All retries failed |

---

## 6. Frontend Integration

### OCR Buffered — Fetch API

```javascript
const extractText = async (file) => {
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch('/ocr', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('OCR request failed');

    const data = await res.json();
    console.log('Full text:', data.full_text);
    data.lines.forEach(line => {
        console.log(`"${line.text}" (${(line.confidence * 100).toFixed(1)}%)`);
    });
};
```

### OCR Live Stream — fetch with ReadableStream

```javascript
const streamOcr = async (file, onChunk, onComplete) => {
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch('/ocr/stream', { method: 'POST', body: formData });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep any incomplete trailing chunk

        for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            const event = JSON.parse(part.slice(6));

            if (event.event === 'ocr_chunk') {
                onChunk(event.text, event.confidence);
            } else if (event.event === 'ocr_complete') {
                onComplete(event.full_text);
            } else if (event.event === 'error') {
                console.error('OCR error:', event.message);
            }
        }
    }
};

// Usage
streamOcr(
    imageFile,
    (text, confidence) => console.log('Line found:', text),
    (fullText) => console.log('Done:\n', fullText)
);
```

### React Hook — Live OCR

```jsx
import { useState } from 'react';

function useOcrStream() {
    const [lines, setLines] = useState([]);
    const [fullText, setFullText] = useState('');
    const [loading, setLoading] = useState(false);

    const runOcr = async (file) => {
        setLines([]);
        setFullText('');
        setLoading(true);

        const formData = new FormData();
        formData.append('image', file);

        const res = await fetch('/ocr/stream', { method: 'POST', body: formData });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop();

            for (const part of parts) {
                if (!part.startsWith('data: ')) continue;
                const event = JSON.parse(part.slice(6));

                if (event.event === 'ocr_chunk') {
                    setLines((prev) => [...prev, event.text]);
                } else if (event.event === 'ocr_complete') {
                    setFullText(event.full_text);
                    setLoading(false);
                }
            }
        }
    };

    return { lines, fullText, loading, runOcr };
}
```

---

## 7. Error Handling

All middlewares follow a **fail-safe** design: they never throw or crash your server. Errors are captured and attached to `req` so you decide how to respond.

### Background Removal

```javascript
removeBgMiddleware({ retries: 2 }),
(req, res) => {
    if (req.bgError) {
        console.error(req.bgError.message);
        return res.status(502).json({ error: 'Image processing service unavailable' });
    }
    // proceed normally...
}
```

### OCR Middleware

```javascript
ocrMiddleware({ retries: 1 }),
(req, res) => {
    if (req.ocrError) {
        return res.status(502).json({ error: 'OCR service unavailable' });
    }
    // proceed normally...
}
```

### OCR Stream Handler

On failure, the stream handler automatically sends an SSE error event and closes the connection. The client should always handle it:

```javascript
if (event.event === 'error') {
    console.error('OCR error:', event.message);
    // update UI state accordingly
}
```

### Skipped Files

If `req.file` is missing or the mimetype does not start with `image/`, all middlewares silently skip processing and call `next()` with no modifications.

---

## 8. Environment Variables

| Variable | Used By | Description |
|---|---|---|
| `OCR_WS_URL` | `ocrMiddleware`, `ocrStreamHandler` | Fallback WebSocket base URL when `wsUrl` option is not passed. |

Set in your `.env`:

```env
OCR_WS_URL=wss://your-ocr-server.hf.space
```

---

## 9. Changelog

### v1.1.0
- **Added** `ocrMiddleware` — buffered OCR over WebSocket, result on `req.ocrResult`
- **Added** `ocrStreamHandler` — live OCR via Server-Sent Events
- **Added** `ws` dependency for WebSocket client
- **Added** `OCR_WS_URL` environment variable support

### v1.0.1
- Made Hugging Face endpoint internal
- Package renamed to `@development-team/bg-remover`

### v1.0.0
- Initial release: `removeBgMiddleware` for background removal

---

## License

MIT © Development Team
