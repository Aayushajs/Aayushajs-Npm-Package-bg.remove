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
 * Express middleware for OCR — supports both live streaming (default) and buffered complete results.
 *
 * @param {Object} options
 * @param {boolean} [options.stream=true] - If true, pipes SSE live chunks. If false, waits for full result.
 * @param {string} [options.apiUrl]  - HTTP(S) base URL
 * @param {string} [options.wsUrl]   - Accepted for backward compat; auto-converted to HTTP(S)
 * @param {number} [options.timeout=30000]
 * @param {number} [options.retries=1]
 * @param {string} [options.fieldName="file"]
 */
function ocrMiddleware(options = {}) {
    const {
        apiUrl = 'https://DevelopmentT-background-remover.hf.space',
        wsUrl,
        timeout = 30000,
        retries = 1,
        fieldName = 'file',
        stream = true
    } = options;

    const resolvedApiUrl = (wsUrl ? _toHttpUrl(wsUrl) : apiUrl).replace(/\/$/, '');

    return async function (req, res, next) {
        if (!req?.file?.buffer) return next();
        if (!req.file.mimetype?.startsWith('image/')) return next();

        let attempts = 0;
        let lastError = null;
        const maxAttempts = retries + 1;

        if (!stream) {
            // ============ BUFFERED MODE ============
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
            return next();
        }

        // ============ STREAM MODE ============
        let response = null;
        let controller;
        let timer;

        while (attempts < maxAttempts && !response) {
            attempts++;
            try {
                const form = new FormData();
                form.append(fieldName, req.file.buffer, {
                    filename: req.file.originalname || 'image.jpg',
                    contentType: req.file.mimetype
                });

                controller = new AbortController();
                timer = setTimeout(() => controller.abort(), timeout);

                response = await axios.post(`${resolvedApiUrl}/api/ocr/stream`, form, {
                    headers: { ...form.getHeaders() },
                    responseType: 'stream',
                    signal: controller.signal,
                    timeout: 0
                });
                lastError = null;
            } catch (err) {
                clearTimeout(timer);
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
                `OCR stream failed after ${attempts} attempt(s). Last error: ${lastError.message || 'Unknown error'}${suffix}`
            );
            return next(); // Delegate to user API on failure
        }

        // Connection successful, stream the response live
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

        let buf = '';

        response.data.on('data', (chunk) => {
            if (ended || res.writableEnded) return;
            buf += chunk.toString();
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
                if (part.trim()) {
                    res.write(part + '\n\n');
                    if (typeof res.flush === 'function') res.flush();
                }
            }
        });

        response.data.on('end', () => {
            clearTimeout(timer);
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

        req.on('close', () => {
            clientClosed = true;
            clearTimeout(timer);
            controller.abort();
            finish();
        });
    };
}



// Backward-compat aliases
const ocrRestMiddleware = (options) => ocrMiddleware({ ...options, stream: false });

function ocrStreamHandler(options = {}) {
    const middleware = ocrMiddleware({ ...options, stream: true });
    return function (req, res) {
        if (!req?.file?.buffer) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        if (!req.file.mimetype?.startsWith('image/')) {
            return res.status(400).json({ error: 'File must be an image' });
        }
        
        // Let the middleware handle it
        middleware(req, res, () => {
            // If the middleware calls next(), it means there was an error connecting to the stream
            if (req.ocrError && !res.headersSent) {
                // The original stream handler just wrote an SSE error event and finished, but if it couldn't connect,
                // the original handler didn't call next(), it wrote an SSE error.
                // We'll simulate that for backward compatibility so tests pass.
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();
                res.write(`data: ${JSON.stringify({ event: 'error', message: req.ocrError.message })}\n\n`);
                res.end();
            }
        });
    };
}

module.exports = {
    removeBgMiddleware,
    ocrMiddleware,
    ocrRestMiddleware,
    ocrStreamHandler
};
