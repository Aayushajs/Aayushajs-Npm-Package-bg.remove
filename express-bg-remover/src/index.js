const axios = require('axios');
const FormData = require('form-data');

const DEFAULT_OCR_API_URL = process.env.OCR_API_URL
    || (process.env.OCR_WS_URL
        ? process.env.OCR_WS_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        : 'https://DevelopmentT-background-remover.hf.space');

function _toHttpUrl(url) {
    if (!url) return DEFAULT_OCR_API_URL;
    return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

/**
 * Express middleware for background removal via HTTP multipart/form-data.
 * @param {Object} options
 * @param {string} [options.apiUrl] - Full URL of the remove-bg endpoint
 * @param {number} [options.timeout=10000]
 * @param {number} [options.retries=2]
 * @param {boolean} [options.replaceOriginal=false]
 * @param {string} [options.fieldName="file"]
 */
function removeBgMiddleware(options = {}) {
    const {
        apiUrl = 'https://DevelopmentT-background-remover.hf.space/remove-bg',
        timeout = 10000,
        retries = 2,
        replaceOriginal = false,
        fieldName = 'file'
    } = options;

    return async function (req, res, next) {
        try {
            if (!req?.file?.buffer) return next();
            if (!req.file.mimetype?.startsWith('image/')) return next();

            let attempts = 0;
            let success = false;
            let lastError = null;
            const maxAttempts = retries + 1;

            while (attempts < maxAttempts && !success) {
                attempts++;
                try {
                    const form = new FormData();
                    form.append(fieldName, req.file.buffer, {
                        filename: req.file.originalname || 'image.jpg',
                        contentType: req.file.mimetype
                    });

                    const response = await axios.post(apiUrl, form, {
                        headers: { ...form.getHeaders() },
                        responseType: 'arraybuffer',
                        timeout
                    });

                    const processedBuffer = Buffer.from(response.data);
                    const ct = response.headers['content-type']?.toLowerCase();
                    const outMimeType = ct?.startsWith('image/') ? ct : 'image/png';

                    req.processedImage = { buffer: processedBuffer, mimetype: outMimeType };

                    if (replaceOriginal) {
                        req.file.buffer = processedBuffer;
                        req.file.mimetype = outMimeType;
                        req.file.size = processedBuffer.length;
                        if (outMimeType === 'image/png' && req.file.originalname) {
                            req.file.originalname = req.file.originalname.replace(/\.[^/.]+$/, '.png');
                        }
                    }
                    success = true;
                } catch (err) {
                    lastError = err;
                }
            }

            if (!success) {
                req.bgError = new Error(
                    `Background removal API failed after ${attempts} attempts. Last error: ${lastError?.message || 'Unknown error'}`
                );
            }
            next();
        } catch (err) {
            req.bgError = err;
            next();
        }
    };
}

/**
 * Express middleware for OCR — sends image as multipart/form-data to POST /api/ocr,
 * buffers the complete result, then calls next().
 * Attaches req.ocrResult on success, req.ocrError on failure. Always calls next().
 *
 * @param {Object} options
 * @param {string} [options.apiUrl]  - HTTP(S) base URL  e.g. "https://my-server.com"
 * @param {string} [options.wsUrl]   - Accepted for backward compat; auto-converted to HTTP(S)
 * @param {number} [options.timeout=30000]
 * @param {number} [options.retries=1]
 * @param {string} [options.fieldName="file"]
 */
function ocrMiddleware(options = {}) {
    const {
        apiUrl,
        wsUrl,
        timeout = 30000,
        retries = 1,
        fieldName = 'file'
    } = options;

    const resolvedApiUrl = (apiUrl || _toHttpUrl(wsUrl)).replace(/\/$/, '');

    return async function (req, res, next) {
        if (!req?.file?.buffer) return next();
        if (!req.file.mimetype?.startsWith('image/')) return next();

        let attempts = 0;
        let lastError = null;
        const maxAttempts = retries + 1;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const form = new FormData();
                form.append(fieldName, req.file.buffer, {
                    filename: req.file.originalname || 'image.jpg',
                    contentType: req.file.mimetype
                });

                const response = await axios.post(`${resolvedApiUrl}/api/ocr`, form, {
                    headers: { ...form.getHeaders() },
                    timeout
                });

                const body = response.data;
                const lines = (body.lines || []).map(l => ({ text: l.text, confidence: l.confidence }));
                req.ocrResult = {
                    full_text: lines.map(l => l.text).join('\n'),
                    lines,
                    total_lines: body.total_lines || 0
                };
                req.ocrChunks = [...lines]; // shallow copy — avoids aliasing req.ocrResult.lines
                lastError = null;
                break;
            } catch (err) {
                // Don't retry on 4xx — problem is with the request, not the server
                if (err.response && err.response.status >= 400 && err.response.status < 500) {
                    lastError = err;
                    break;
                }
                lastError = err;
            }
        }

        if (lastError) {
            const detail = lastError.response?.data?.detail || lastError.response?.data?.error;
            const suffix = detail ? ` (${detail})` : '';
            req.ocrError = new Error(
                `OCR failed after ${attempts} attempt(s). Last error: ${lastError.message || 'Unknown error'}${suffix}`
            );
        }
        next();
    };
}

/**
 * Express route handler for OCR with live SSE streaming.
 * Sends image as multipart/form-data to POST /api/ocr/stream and pipes the
 * SSE response to the client in real-time — chunks arrive as they come, no waiting.
 *
 * @param {Object} options
 * @param {string} [options.apiUrl]  - HTTP(S) base URL
 * @param {string} [options.wsUrl]   - Accepted for backward compat; auto-converted to HTTP(S)
 * @param {number} [options.timeout=30000]
 * @param {string} [options.fieldName="file"]
 */
function ocrStreamHandler(options = {}) {
    const {
        apiUrl,
        wsUrl,
        timeout = 30000,
        fieldName = 'file'
    } = options;

    const resolvedApiUrl = (apiUrl || _toHttpUrl(wsUrl)).replace(/\/$/, '');

    return function (req, res) {
        if (!req?.file?.buffer) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        if (!req.file.mimetype?.startsWith('image/')) {
            return res.status(400).json({ error: 'File must be an image' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let ended = false;
        let clientClosed = false;

        const finish = () => {
            if (!ended) {
                ended = true;
                if (!res.writableEnded) res.end();
            }
        };

        const controller = new AbortController();

        const timer = setTimeout(() => {
            controller.abort();
            if (!ended && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ event: 'error', message: 'OCR connection timed out' })}\n\n`);
            }
            finish();
        }, timeout);

        const form = new FormData();
        form.append(fieldName, req.file.buffer, {
            filename: req.file.originalname || 'image.jpg',
            contentType: req.file.mimetype
        });

        axios.post(`${resolvedApiUrl}/api/ocr/stream`, form, {
            headers: { ...form.getHeaders() },
            responseType: 'stream',
            signal: controller.signal,
            timeout: 0  // let our timer handle cancellation
        }).then(response => {
            let buf = '';

            response.data.on('data', (chunk) => {
                if (ended || res.writableEnded) return;
                buf += chunk.toString();
                const parts = buf.split('\n\n');
                buf = parts.pop();
                for (const part of parts) {
                    if (part.trim()) {
                        res.write(part + '\n\n');
                        // Force immediate flush (works with compression middleware too)
                        if (typeof res.flush === 'function') res.flush();
                    }
                }
            });

            response.data.on('end', () => {
                clearTimeout(timer);
                // Flush any incomplete SSE frame that arrived without a trailing \n\n
                if (buf.trim() && !ended && !res.writableEnded) {
                    res.write(buf + '\n\n');
                }
                finish();
            });

            response.data.on('error', (err) => {
                clearTimeout(timer);
                if (!clientClosed && !ended && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ event: 'error', message: err.message })}\n\n`);
                }
                finish();
            });
        }).catch(err => {
            clearTimeout(timer);
            // Don't write an error if the client itself closed the connection
            if (!clientClosed && !ended && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ event: 'error', message: err.message || 'OCR stream request failed' })}\n\n`);
            }
            finish();
        });

        req.on('close', () => {
            clientClosed = true;
            clearTimeout(timer);
            controller.abort();
        });
    };
}

// Backward-compat alias
const ocrRestMiddleware = ocrMiddleware;

module.exports = {
    removeBgMiddleware,
    ocrMiddleware,
    ocrRestMiddleware,
    ocrStreamHandler
};
