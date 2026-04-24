const request = require('supertest');
const express = require('express');
const multer = require('multer');
const nock = require('nock');
const { EventEmitter } = require('events');
const { removeBgMiddleware, ocrMiddleware, ocrStreamHandler } = require('../src/index');

// ---------------------------------------------------------------------------
// WebSocket mock — must be declared before any require('../src/index') resolves
// ---------------------------------------------------------------------------
jest.mock('ws', () => {
    const { EventEmitter } = require('events');

    class MockWebSocket extends EventEmitter {
        constructor(url) {
            super();
            this.url = url;
            this.send = jest.fn();
            this.close = jest.fn();
            this.terminate = jest.fn();
            MockWebSocket.__instances.push(this);
        }
    }
    MockWebSocket.__instances = [];

    return MockWebSocket;
});

const WebSocket = require('ws');

// Flush the microtask/Promise queue so async middleware can resume
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// removeBgMiddleware tests (unchanged)
// ---------------------------------------------------------------------------
describe('removeBgMiddleware', () => {
    let app;
    const apiUrl = 'http://api.test/remove-bg';

    beforeEach(() => {
        app = express();
        const upload = multer({ storage: multer.memoryStorage() });

        app.post(
            '/upload',
            upload.single('image'),
            removeBgMiddleware({ apiUrl, retries: 1 }),
            (req, res) => {
                if (req.bgError) {
                    res.status(500).json({ error: req.bgError.message });
                } else if (req.processedImage) {
                    res.status(200).json({
                        hasProcessed: true,
                        mimetype: req.processedImage.mimetype,
                        bufferLength: req.processedImage.buffer.length
                    });
                } else {
                    res.status(200).json({ hasProcessed: false });
                }
            }
        );

        app.post(
            '/upload-replace',
            upload.single('image'),
            removeBgMiddleware({ apiUrl, replaceOriginal: true }),
            (req, res) => {
                if (req.bgError) {
                    return res.status(500).json({ error: req.bgError.message });
                }
                res.status(200).json({
                    fileSize: req.file.size,
                    fileMimeType: req.file.mimetype,
                    originalName: req.file.originalname,
                    bufferLength: req.file.buffer.length
                });
            }
        );
    });

    afterEach(() => {
        nock.cleanAll();
    });

    test('should use default apiUrl if not provided', () => {
        const middleware = removeBgMiddleware({});
        expect(typeof middleware).toBe('function');
    });

    test('should skip if no file is provided', async () => {
        const response = await request(app).post('/upload');
        expect(response.status).toBe(200);
        expect(response.body.hasProcessed).toBe(false);
    });

    test('should skip if file mimetype is not image/', async () => {
        const response = await request(app)
            .post('/upload')
            .attach('image', Buffer.from('hello text'), {
                filename: 'text.txt',
                contentType: 'text/plain'
            });
        expect(response.status).toBe(200);
        expect(response.body.hasProcessed).toBe(false);
    });

    test('should process image and attach to req.processedImage', async () => {
        const fakeImage = Buffer.from('fake image data');
        const fakeProcessed = Buffer.from('processed fake image');

        nock('http://api.test')
            .post('/remove-bg')
            .reply(200, fakeProcessed, { 'Content-Type': 'image/png' });

        const response = await request(app)
            .post('/upload')
            .attach('image', fakeImage, {
                filename: 'test.jpg',
                contentType: 'image/jpeg'
            });

        expect(response.status).toBe(200);
        expect(response.body.hasProcessed).toBe(true);
        expect(response.body.mimetype).toBe('image/png');
        expect(response.body.bufferLength).toBe(fakeProcessed.length);
    });

    test('should handle API failure, retry, and set req.bgError', async () => {
        const fakeImage = Buffer.from('fake image data');

        nock('http://api.test')
            .post('/remove-bg')
            .reply(500, 'Internal Error')
            .post('/remove-bg')
            .reply(500, 'Internal Error');

        const response = await request(app)
            .post('/upload')
            .attach('image', fakeImage, {
                filename: 'test.jpg',
                contentType: 'image/jpeg'
            });

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('Background removal API failed');
    });

    test('should replace original file if replaceOriginal is true', async () => {
        const fakeImage = Buffer.from('fake image data');
        const fakeProcessed = Buffer.from('processed!');

        nock('http://api.test')
            .post('/remove-bg')
            .reply(200, fakeProcessed, { 'Content-Type': 'image/png' });

        const response = await request(app)
            .post('/upload-replace')
            .attach('image', fakeImage, {
                filename: 'test.jpg',
                contentType: 'image/jpeg'
            });

        expect(response.status).toBe(200);
        expect(response.body.fileSize).toBe(fakeProcessed.length);
        expect(response.body.fileMimeType).toBe('image/png');
        expect(response.body.originalName).toBe('test.png');
    });
});

// ---------------------------------------------------------------------------
// ocrMiddleware tests
// ---------------------------------------------------------------------------
describe('ocrMiddleware', () => {
    beforeEach(() => {
        WebSocket.__instances = [];
    });

    const makeReq = (override = {}) => ({
        file: {
            buffer: Buffer.from('fake-image'),
            mimetype: 'image/jpeg',
            originalname: 'test.jpg'
        },
        ...override
    });

    test('should return a middleware function', () => {
        expect(typeof ocrMiddleware()).toBe('function');
    });

    test('should skip and call next if no file is provided', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local' });
        const next = jest.fn();
        await middleware({}, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(WebSocket.__instances.length).toBe(0);
    });

    test('should skip and call next if mimetype is not image/', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local' });
        const next = jest.fn();
        const req = { file: { buffer: Buffer.from('data'), mimetype: 'text/plain' } };
        await middleware(req, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(WebSocket.__instances.length).toBe(0);
    });

    test('should attach req.ocrResult and req.ocrChunks on success', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();
        const next = jest.fn();

        const p = middleware(req, {}, next);

        const ws = WebSocket.__instances[0];
        ws.emit('open');
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_chunk', text: 'Hello', confidence: 0.99 })));
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_chunk', text: 'World', confidence: 0.95 })));
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_complete', full_text: 'Hello\nWorld' })));

        await p;

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrResult).toBeDefined();
        expect(req.ocrResult.full_text).toBe('Hello\nWorld');
        expect(req.ocrResult.total_lines).toBe(2);
        expect(req.ocrChunks).toHaveLength(2);
        expect(req.ocrChunks[0]).toEqual({ text: 'Hello', confidence: 0.99 });
        expect(req.ocrError).toBeUndefined();
    });

    test('should send the image buffer as binary over WebSocket', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();

        const p = middleware(req, {}, jest.fn());
        const ws = WebSocket.__instances[0];
        ws.emit('open');
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_complete', full_text: 'text' })));
        await p;

        expect(ws.send).toHaveBeenCalledWith(req.file.buffer);
    });

    test('should set req.ocrError when WS emits an error event and call next', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local', retries: 0, timeout: 5000 });
        const req = makeReq();
        const next = jest.fn();

        const p = middleware(req, {}, next);
        WebSocket.__instances[0].emit('error', new Error('Connection refused'));
        await p;

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrError).toBeDefined();
        expect(req.ocrError.message).toContain('OCR failed after 1 attempt(s)');
        expect(req.ocrError.message).toContain('Connection refused');
        expect(req.ocrResult).toBeUndefined();
    });

    test('should set req.ocrError when server sends an error event', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local', retries: 0, timeout: 5000 });
        const req = makeReq();
        const next = jest.fn();

        const p = middleware(req, {}, next);
        const ws = WebSocket.__instances[0];
        ws.emit('open');
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'error', message: 'Invalid image format' })));
        await p;

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrError).toBeDefined();
        expect(req.ocrError.message).toContain('Invalid image format');
    });

    test('should retry on failure and set req.ocrError after all retries fail', async () => {
        const middleware = ocrMiddleware({ wsUrl: 'ws://test.local', retries: 1, timeout: 5000 });
        const req = makeReq();
        const next = jest.fn();

        const p = middleware(req, {}, next);

        // First attempt fails
        expect(WebSocket.__instances.length).toBe(1);
        WebSocket.__instances[0].emit('error', new Error('Connection refused'));

        // Allow microtasks to run so retry loop can create the second WS instance
        await flushPromises();

        // Second attempt (retry) fails
        expect(WebSocket.__instances.length).toBe(2);
        WebSocket.__instances[1].emit('error', new Error('Connection refused'));

        await p;

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrError).toBeDefined();
        expect(req.ocrError.message).toContain('OCR failed after 2 attempt(s)');
    });
});

// ---------------------------------------------------------------------------
// ocrStreamHandler tests
// ---------------------------------------------------------------------------
describe('ocrStreamHandler', () => {
    beforeEach(() => {
        WebSocket.__instances = [];
    });

    const makeReq = (override = {}) => {
        const req = new EventEmitter();
        req.file = {
            buffer: Buffer.from('fake-image'),
            mimetype: 'image/jpeg',
            originalname: 'test.jpg'
        };
        return Object.assign(req, override);
    };

    const makeRes = () => {
        let resolveEnd;
        const endPromise = new Promise((r) => { resolveEnd = r; });
        const written = [];
        const state = { writableEnded: false };
        return Object.assign(state, {
            setHeader: jest.fn(),
            flushHeaders: jest.fn(),
            write: jest.fn().mockImplementation((data) => written.push(data)),
            end: jest.fn().mockImplementation(() => {
                state.writableEnded = true;
                resolveEnd();
            }),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            written,
            endPromise
        });
    };

    test('should return a handler function', () => {
        expect(typeof ocrStreamHandler()).toBe('function');
    });

    test('should return 400 JSON if no file is provided', () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local' });
        const req = new EventEmitter();
        const res = makeRes();
        handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'No image file provided' });
    });

    test('should return 400 JSON if file is not an image', () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local' });
        const req = new EventEmitter();
        req.file = { buffer: Buffer.from('data'), mimetype: 'text/plain' };
        const res = makeRes();
        handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'File must be an image' });
    });

    test('should set SSE headers before streaming', () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local' });
        const req = makeReq();
        const res = makeRes();
        handler(req, res);
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(res.flushHeaders).toHaveBeenCalled();
    });

    test('should stream all events as SSE and end after ocr_complete', async () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();
        const res = makeRes();

        handler(req, res);

        const ws = WebSocket.__instances[0];
        ws.emit('open');
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'status', message: 'Preprocessing...' })));
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_chunk', text: 'Hello', confidence: 0.99 })));
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'ocr_complete', full_text: 'Hello' })));

        await res.endPromise;

        expect(res.written).toHaveLength(3);
        expect(res.written[0]).toContain('"event":"status"');
        expect(res.written[1]).toContain('"event":"ocr_chunk"');
        expect(res.written[2]).toContain('"event":"ocr_complete"');
        expect(res.end).toHaveBeenCalled();
    });

    test('should stream error event and end on server error message', async () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();
        const res = makeRes();

        handler(req, res);

        const ws = WebSocket.__instances[0];
        ws.emit('open');
        ws.emit('message', Buffer.from(JSON.stringify({ event: 'error', message: 'Bad image' })));

        await res.endPromise;

        expect(res.written[0]).toContain('"event":"error"');
        expect(res.end).toHaveBeenCalled();
    });

    test('should send error SSE and end on WS error event', async () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();
        const res = makeRes();

        handler(req, res);

        const ws = WebSocket.__instances[0];
        ws.emit('error', new Error('Socket hang up'));

        await res.endPromise;

        expect(res.written[0]).toContain('"event":"error"');
        expect(res.written[0]).toContain('Socket hang up');
        expect(res.end).toHaveBeenCalled();
    });

    test('should terminate WS when the HTTP client disconnects', async () => {
        const handler = ocrStreamHandler({ wsUrl: 'ws://test.local', timeout: 5000 });
        const req = makeReq();
        const res = makeRes();

        handler(req, res);

        const ws = WebSocket.__instances[0];
        ws.emit('open');

        // Client closes connection before OCR completes
        req.emit('close');

        expect(ws.terminate).toHaveBeenCalled();
    });
});
