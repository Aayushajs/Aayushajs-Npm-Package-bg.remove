const axios = require('axios');
const FormData = require('form-data');
const WebSocket = require('ws');
const crypto = require('crypto');

const DEFAULT_OCR_WS_URL = process.env.OCR_WS_URL || 'wss://DevelopmentT-background-remover.hf.space';

/**
 * Express middleware for background removal
 * @param {Object} options
 * @param {string} options.apiUrl - The API URL for background removal
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @param {number} [options.retries=2] - Number of retries on failure
 * @param {boolean} [options.replaceOriginal=false] - Whether to replace req.file.buffer with processed image
 * @param {string} [options.fieldName="file"] - Name of the form-data field expected by the API
 * @returns {Function} Express middleware function
 */
function removeBgMiddleware(options = {}) {
    const {
        apiUrl = 'https://DevelopmentT-background-remover.hf.space/remove-bg',
        timeout = 10000,
        retries = 2,
        replaceOriginal = false,
        fieldName = 'file'
    } = options;

    return async function(req, res, next) {
        try {
            if (!req || !req.file || !req.file.buffer) {
                return next();
            }

            if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
                return next();
            }

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
                        headers: {
                            ...form.getHeaders()
                        },
                        responseType: 'arraybuffer',
                        timeout: timeout
                    });

                    const processedBuffer = Buffer.from(response.data);

                    const contentTypeHeader = response.headers['content-type']?.toLowerCase();
                    const outMimeType = (contentTypeHeader && contentTypeHeader.startsWith('image/'))
                        ? contentTypeHeader
                        : 'image/png';

                    req.processedImage = {
                        buffer: processedBuffer,
                        mimetype: outMimeType
                    };

                    if (replaceOriginal) {
                        req.file.buffer = processedBuffer;
                        req.file.mimetype = outMimeType;
                        req.file.size = processedBuffer.length;

                        if (outMimeType === 'image/png' && req.file.originalname) {
                            req.file.originalname = req.file.originalname.replace(/\.[^/.]+$/, ".png");
                        }
                    }

                    success = true;
                } catch (err) {
                    lastError = err;
                }
            }

            if (!success) {
                const errMsg = lastError?.message || 'Unknown error';
                req.bgError = new Error(`Background removal API failed after ${attempts} attempts. Last error: ${errMsg}`);
            }

            next();
        } catch (err) {
            req.bgError = err;
            next();
        }
    };
}

/**
 * Internal helper: connects to the OCR WebSocket server, sends the image buffer,
 * and resolves with the full OCR result once processing is complete.
 * @param {string} wsUrl - Base WebSocket URL
 * @param {Buffer} imageBuffer - Raw image buffer to send
 * @param {number} timeout - Milliseconds before timing out
 * @returns {Promise<{full_text: string, lines: Array, total_lines: number}>}
 */
function _runOcrOverWs(wsUrl, imageBuffer, timeout) {
    return new Promise((resolve, reject) => {
        const userId = 'user_' + crypto.randomBytes(4).toString('hex');
        const wsEndpoint = `${wsUrl}/ws/ocr?user_id=${userId}`;
        const ws = new WebSocket(wsEndpoint);
        const chunks = [];

        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('OCR WebSocket connection timed out'));
        }, timeout);

        ws.on('open', () => {
            ws.send(imageBuffer);
        });

        ws.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                if (parsed.event === 'ocr_chunk') {
                    chunks.push({ text: parsed.text, confidence: parsed.confidence });
                } else if (parsed.event === 'ocr_complete') {
                    clearTimeout(timer);
                    ws.close();
                    resolve({
                        full_text: parsed.full_text,
                        lines: chunks,
                        total_lines: chunks.length
                    });
                } else if (parsed.event === 'error') {
                    clearTimeout(timer);
                    ws.close();
                    reject(new Error(parsed.message || 'OCR server returned an error'));
                }
            } catch (e) {
                // ignore malformed messages
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Express middleware for OCR — buffers the full result, then calls next().
 * Attaches req.ocrResult on success, req.ocrError on failure. Always calls next().
 * @param {Object} options
 * @param {string} [options.wsUrl] - WebSocket base URL of the OCR server
 * @param {number} [options.timeout=30000] - Connection timeout in ms
 * @param {number} [options.retries=1] - Number of retry attempts on failure
 * @returns {Function} Express middleware function
 */
function ocrMiddleware(options = {}) {
    const {
        wsUrl = DEFAULT_OCR_WS_URL,
        timeout = 30000,
        retries = 1
    } = options;

    return async function(req, res, next) {
        try {
            if (!req?.file?.buffer) return next();
            if (!req.file.mimetype?.startsWith('image/')) return next();

            let attempts = 0;
            let lastError = null;
            const maxAttempts = retries + 1;

            while (attempts < maxAttempts) {
                attempts++;
                try {
                    const result = await _runOcrOverWs(wsUrl, req.file.buffer, timeout);
                    req.ocrResult = result;
                    req.ocrChunks = result.lines;
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                }
            }

            if (lastError) {
                const errMsg = lastError.message || 'Unknown error';
                req.ocrError = new Error(`OCR failed after ${attempts} attempt(s). Last error: ${errMsg}`);
            }

            next();
        } catch (err) {
            req.ocrError = err;
            next();
        }
    };
}

/**
 * Express route handler for OCR with live Server-Sent Events streaming.
 * Streams OCR events (status, ocr_chunk, ocr_complete, error) directly to the client
 * as they arrive from the WebSocket server. Client disconnects cleanly terminate the WS.
 * @param {Object} options
 * @param {string} [options.wsUrl] - WebSocket base URL of the OCR server
 * @param {number} [options.timeout=30000] - Connection timeout in ms
 * @returns {Function} Express route handler function (does NOT call next)
 */
function ocrStreamHandler(options = {}) {
    const {
        wsUrl = DEFAULT_OCR_WS_URL,
        timeout = 30000
    } = options;

    return function(req, res) {
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

        const userId = 'user_' + crypto.randomBytes(4).toString('hex');
        const wsEndpoint = `${wsUrl}/ws/ocr?user_id=${userId}`;
        const ws = new WebSocket(wsEndpoint);
        let ended = false;

        const sendEvent = (payload) => {
            if (!ended && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }
        };

        const finish = () => {
            if (!ended) {
                ended = true;
                if (!res.writableEnded) res.end();
            }
        };

        const timer = setTimeout(() => {
            ws.terminate();
            sendEvent({ event: 'error', message: 'OCR connection timed out' });
            finish();
        }, timeout);

        ws.on('open', () => {
            ws.send(req.file.buffer);
        });

        ws.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                sendEvent(parsed);
                if (parsed.event === 'ocr_complete' || parsed.event === 'error') {
                    clearTimeout(timer);
                    ws.close();
                    finish();
                }
            } catch (e) {
                // ignore malformed messages
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            sendEvent({ event: 'error', message: err.message });
            finish();
        });

        ws.on('close', () => {
            clearTimeout(timer);
            finish();
        });

        req.on('close', () => {
            clearTimeout(timer);
            ws.terminate();
        });
    };
}

module.exports = {
    removeBgMiddleware,
    ocrMiddleware,
    ocrStreamHandler
};
