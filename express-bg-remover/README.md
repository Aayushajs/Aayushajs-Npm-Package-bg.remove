# @development-team/bg-remover

[![NPM Version](https://img.shields.io/npm/v/@development-team/bg-remover)](https://www.npmjs.com/package/@development-team/bg-remover)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org)

A production-ready Express middleware suite for **AI-powered image background removal** and **real-time OCR text extraction**.

> **v1.2.0** — Image is always sent as normal `multipart/form-data` (PNG/JPG). No WebSocket binary conversion required. Output available as a complete HTTP response or a real-time SSE stream.

---

## Features

| Feature | Description |
|---|---|
| Background Removal | Remove image backgrounds via HTTP multipart upload |
| OCR — Buffered | Upload image as PNG/JPG, get complete text result in `req.ocrResult` |
| OCR — Live Stream | Upload image as PNG/JPG, receive OCR chunks in real-time via SSE |
| Fail-Safe | Errors never crash your middleware chain — always calls `next()` |
| Retry Logic | Configurable retry attempts; smart — skips retry on 4xx errors |
| Backward Compat | `wsUrl` still accepted — auto-converted to `https://` internally |

---

## Requirements

- Node.js `>= 16.0.0`
- `multer` (peer dependency for file uploads)

---

## Installation

```bash
npm install @development-team/bg-remover multer
```

---

## Table of Contents

1. [Background Removal](#1-background-removal)
2. [OCR — Buffered (Complete Result)](#2-ocr--buffered-complete-result)
3. [OCR — Live SSE Stream](#3-ocr--live-sse-stream)
4. [Options Reference](#4-options-reference)
5. [Request Object Properties](#5-request-object-properties)
6. [Frontend Integration](#6-frontend-integration)
7. [Error Handling](#7-error-handling)
8. [Environment Variables](#8-environment-variables)
9. [Changelog](#9-changelog)

---

## 1. Background Removal

**`removeBgMiddleware(options)`**

Uploads the image to a background removal REST API and attaches the result to `req.processedImage`. Always calls `next()` — even on failure.

### Basic Example

```javascript
const express = require('express');
const multer  = require('multer');
const { removeBgMiddleware } = require('@development-team/bg-remover');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.post(
    '/remove-background',
    upload.single('image'),
    removeBgMiddleware({ timeout: 15000, retries: 2 }),
    (req, res) => {
        if (req.bgError) {
            return res.status(500).json({ error: req.bgError.message });
        }
        // req.processedImage.buffer  → Buffer (transparent PNG)
        // req.processedImage.mimetype → 'image/png'
        res.set('Content-Type', req.processedImage.mimetype);
        res.send(req.processedImage.buffer);
    }
);
```

### Replace Original File In-Place

```javascript
app.post(
    '/upload',
    upload.single('image'),
    removeBgMiddleware({ replaceOriginal: true }),
    (req, res) => {
        if (req.bgError) return res.status(500).json({ error: 'Processing failed' });
        // req.file.buffer   → processed image
        // req.file.mimetype → 'image/png'
        res.json({ size: req.file.size });
    }
);
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(built-in)* | Full URL of the background removal endpoint |
| `timeout` | `number` | `10000` | Request timeout in ms |
| `retries` | `number` | `2` | Retry attempts on failure |
| `replaceOriginal` | `boolean` | `false` | Overwrite `req.file` with the processed result |
| `fieldName` | `string` | `"file"` | Form-data field name sent to the API |

---

## 2. OCR Middleware

**`ocrMiddleware(options)`**

Uploads the image to the OCR API and returns the extracted text. This middleware supports **both** buffered complete results and live SSE streaming, controlled by the `stream` parameter. It follows a fail-safe design—if the connection to the OCR API fails, it attaches the error to `req.ocrError` and safely calls `next()`, allowing your API to handle the error gracefully without crashing.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `stream` | `boolean` | `true` | If `true`, streams results live via SSE. If `false`, buffers the complete result and attaches to `req`. |
| `apiUrl` | `string` | *(internal)* | HTTP(S) base URL of the OCR server |
| `timeout` | `number` | `30000` | Request timeout in ms |
| `retries` | `number` | `1` | Retry attempts on failure (skipped on 4xx errors) |
| `fieldName` | `string` | `"file"` | Form-data field name sent to the API |

### Example 1: Buffered Mode (`stream: false`)

Use this when you want a standard request/response flow. The middleware waits for the complete result, attaches it to `req.ocrResult`, and calls `next()`.

```javascript
const express = require('express');
const multer  = require('multer');
const { ocrMiddleware } = require('@development-team/bg-remover');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.post(
    '/ocr',
    upload.single('image'),       // accepts PNG, JPG, WEBP, etc.
    ocrMiddleware({
        stream: false,            // <--- Disable streaming
        timeout: 30000,
        retries: 1
    }),
    (req, res) => {
        // Fallback error handling if middleware connection failed
        if (req.ocrError) {
            return res.status(502).json({ error: req.ocrError.message });
        }
        res.json({
            full_text:   req.ocrResult.full_text,
            total_lines: req.ocrResult.total_lines,
            lines:       req.ocrResult.lines
        });
    }
);
```

### Example 2: Live SSE Stream Mode (`stream: true` - default)

Use this to pipe the OCR results back to the client as **Server-Sent Events** in real-time. If the initial connection fails, it calls `next()` with `req.ocrError` so you can send a standard JSON error response. If successful, it automatically handles the HTTP response and streams the data.

```javascript
app.post(
    '/ocr/stream',
    upload.single('image'),
    ocrMiddleware({ stream: true }), // stream is true by default
    (req, res) => {
        // We only reach this handler if the initial stream connection FAILED.
        // If the stream connects successfully, the middleware streams the data and ends the response automatically.
        if (req.ocrError) {
            return res.status(502).json({ error: req.ocrError.message });
        }
    }
);
```

### SSE Event Stream Format (Live Mode)

The client receives a `text/event-stream` response with these events:

```
data: {"event":"status","data":{"message":"📷 Image received","stage":"received"}}

data: {"event":"status","data":{"message":"📝 Reading text…","stage":"ocr_started"}}

data: {"event":"ocr_chunk","data":"Paracetamol 500mg","index":1,"confidence":0.985,"bbox":[[...]]}

data: {"event":"ocr_complete","data":{"message":"✅ Done","total_lines":2}}
```

> **Backward Compatibility:** `ocrStreamHandler` and `ocrRestMiddleware` are still exported and map to `ocrMiddleware` internally.

---

## 4. Options Reference (All Middlewares)

### `removeBgMiddleware(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(internal)* | Full URL of the remove-bg endpoint |
| `timeout` | `number` | `10000` | HTTP request timeout (ms) |
| `retries` | `number` | `2` | Retry attempts on failure |
| `replaceOriginal` | `boolean` | `false` | Overwrite `req.file` with processed result |
| `fieldName` | `string` | `"file"` | Form-data field name sent to the API |

### `ocrMiddleware(options)` / `ocrRestMiddleware(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(internal)* | HTTP(S) base URL of the OCR server |
| `wsUrl` | `string` | `process.env.OCR_WS_URL` | Backward compat — auto-converted to `https://` |
| `timeout` | `number` | `30000` | Request timeout (ms) |
| `retries` | `number` | `1` | Retry attempts (skipped on 4xx errors) |
| `fieldName` | `string` | `"file"` | Form-data field name |

### `ocrStreamHandler(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | *(internal)* | HTTP(S) base URL of the OCR server |
| `wsUrl` | `string` | `process.env.OCR_WS_URL` | Backward compat — auto-converted to `https://` |
| `timeout` | `number` | `30000` | Request timeout (ms) |
| `fieldName` | `string` | `"file"` | Form-data field name |

---

## 5. Request Object Properties

### `removeBgMiddleware`

| Property | Type | Set When |
|---|---|---|
| `req.processedImage.buffer` | `Buffer` | Success |
| `req.processedImage.mimetype` | `string` | Success |
| `req.bgError` | `Error` | All retries failed |

### `ocrMiddleware` / `ocrRestMiddleware`

| Property | Type | Set When |
|---|---|---|
| `req.ocrResult.full_text` | `string` | Success |
| `req.ocrResult.lines` | `Array<{text, confidence}>` | Success |
| `req.ocrResult.total_lines` | `number` | Success |
| `req.ocrChunks` | `Array<{text, confidence}>` | Success (shallow copy of `lines`) |
| `req.ocrError` | `Error` | All retries failed |

> All middlewares silently skip and call `next()` if `req.file` is missing or the file is not an image.

---

## 6. Frontend Integration

### OCR Buffered — Fetch API

```javascript
const extractText = async (file) => {
    const formData = new FormData();
    formData.append('image', file);   // PNG, JPG, WEBP — any image format

    const res  = await fetch('/ocr', { method: 'POST', body: formData });
    const data = await res.json();

    console.log('Full text:', data.full_text);
    data.lines.forEach(line => {
        console.log(`"${line.text}" (${(line.confidence * 100).toFixed(1)}%)`);
    });
};
```

### OCR Live Stream — fetch with ReadableStream

```javascript
const streamOcr = async (file, onChunk, onComplete, onError) => {
    const formData = new FormData();
    formData.append('image', file);   // PNG, JPG, WEBP — any image format

    const res     = await fetch('/ocr/stream', { method: 'POST', body: formData });
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop();   // keep incomplete last frame

        for (const frame of frames) {
            if (!frame.startsWith('data: ')) continue;
            const event = JSON.parse(frame.slice(6));

            if (event.event === 'ocr_chunk') {
                onChunk(event.data, event.confidence);   // event.data = extracted text
            } else if (event.event === 'ocr_complete') {
                onComplete(event.data.total_lines);
            } else if (event.event === 'error') {
                onError(event.message);
            }
        }
    }
};

// Usage
streamOcr(
    imageFile,
    (text, conf) => console.log(`Line: "${text}" (${(conf * 100).toFixed(1)}%)`),
    (total)      => console.log(`Done — ${total} lines extracted`),
    (err)        => console.error('OCR error:', err)
);
```

### React Hook — Live OCR

```jsx
import { useState } from 'react';

function useOcrStream(endpoint = '/ocr/stream') {
    const [lines,    setLines]    = useState([]);
    const [done,     setDone]     = useState(false);
    const [loading,  setLoading]  = useState(false);
    const [error,    setError]    = useState(null);

    const runOcr = async (file) => {
        setLines([]);
        setDone(false);
        setError(null);
        setLoading(true);

        const formData = new FormData();
        formData.append('image', file);

        const res     = await fetch(endpoint, { method: 'POST', body: formData });
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer    = '';

        while (true) {
            const { done: streamDone, value } = await reader.read();
            if (streamDone) break;

            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop();

            for (const frame of frames) {
                if (!frame.startsWith('data: ')) continue;
                const event = JSON.parse(frame.slice(6));

                if (event.event === 'ocr_chunk') {
                    setLines((prev) => [...prev, { text: event.data, confidence: event.confidence }]);
                } else if (event.event === 'ocr_complete') {
                    setDone(true);
                    setLoading(false);
                } else if (event.event === 'error') {
                    setError(event.message);
                    setLoading(false);
                }
            }
        }
    };

    return { lines, done, loading, error, runOcr };
}

// Usage in component:
// const { lines, loading, runOcr } = useOcrStream();
// <input type="file" onChange={e => runOcr(e.target.files[0])} />
// {lines.map((l, i) => <p key={i}>{l.text}</p>)}
```

---

## 7. Error Handling

All middlewares follow a **fail-safe** design — they never throw or crash your server.

### Background Removal

```javascript
removeBgMiddleware({ retries: 2 }),
(req, res) => {
    if (req.bgError) {
        return res.status(502).json({ error: 'Image processing service unavailable' });
    }
    // proceed normally
}
```

### OCR Buffered

```javascript
ocrMiddleware({ retries: 1 }),
(req, res) => {
    if (req.ocrError) {
        // Includes server error detail when available, e.g.:
        // "OCR failed after 1 attempt(s). Last error: Request failed with status code 422 (File too large)"
        return res.status(502).json({ error: req.ocrError.message });
    }
    // proceed normally
}
```

### OCR Stream

The stream handler automatically sends an SSE `error` event and closes the connection. Always listen for it on the client:

```javascript
if (event.event === 'error') {
    console.error('OCR error:', event.message);
    // show error UI, stop spinner, etc.
}
```

---

## 8. Environment Variables

| Variable | Used By | Description |
|---|---|---|
| `OCR_API_URL` | `ocrMiddleware`, `ocrStreamHandler` | HTTP(S) base URL of the OCR server. **Recommended.** |
| `OCR_WS_URL` | `ocrMiddleware`, `ocrStreamHandler` | Legacy: WebSocket URL — auto-converted to `https://` |

Set in your `.env`:

```env
# Recommended (v1.2.0+)
OCR_API_URL=https://your-ocr-server.hf.space

# Or use the legacy variable (still works — auto-converted to https://)
OCR_WS_URL=wss://your-ocr-server.hf.space
```

> If both are set, `OCR_API_URL` takes precedence.

---

## 9. Changelog

### v1.2.0
- **Breaking (internal):** OCR transport changed from WebSocket binary to **HTTP multipart/form-data**
  - Images are now sent as normal PNG/JPG files — no binary or base64 conversion needed
  - `ocrMiddleware` → uses `POST /api/ocr` (complete JSON result)
  - `ocrStreamHandler` → uses `POST /api/ocr/stream` (real-time SSE chunks)
- **Added** `apiUrl` option to both OCR functions (direct HTTP URL)
- **Added** `ocrRestMiddleware` export (alias of `ocrMiddleware`)
- **Added** `fieldName` option to `ocrStreamHandler`
- **Added** `res.flush()` calls for immediate SSE event delivery
- **Added** smart retry: 4xx errors are not retried (only 5xx)
- **Added** upstream error detail in `req.ocrError.message`
- **Changed** `req.ocrChunks` is now a shallow copy (not an alias) of `req.ocrResult.lines`
- **Removed** `ws` (WebSocket) dependency — no longer needed
- **Updated** Node.js requirement: `>= 16.0.0` (was `>= 14.0.0`)
- **Backward compat:** `wsUrl` still accepted — auto-converted to `https://`/`http://`

### v1.1.0
- Added `ocrMiddleware` — buffered OCR over WebSocket
- Added `ocrStreamHandler` — live OCR via Server-Sent Events
- Added `ws` dependency for WebSocket client
- Added `OCR_WS_URL` environment variable support

### v1.0.1
- Made Hugging Face endpoint internal
- Package renamed to `@development-team/bg-remover`

### v1.0.0
- Initial release: `removeBgMiddleware` for background removal

---

## License

MIT © Development Team
