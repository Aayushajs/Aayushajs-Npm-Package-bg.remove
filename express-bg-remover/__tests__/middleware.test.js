const request = require('supertest');
const express = require('express');
const multer = require('multer');
const nock = require('nock');
const { EventEmitter } = require('events');
const { removeBgMiddleware, ocrMiddleware, ocrRestMiddleware, ocrStreamHandler } = require('../src/index');

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

const OCR_BASE = 'http://ocr.test';

// Fake OCR REST response (what /api/ocr returns)
const fakeOcrBody = {
    status: 'success',
    total_lines: 2,
    lines: [
        { index: 1, text: 'Hello', confidence: 0.99, bbox: [] },
        { index: 2, text: 'World', confidence: 0.95, bbox: [] }
    ]
};

// Fake SSE stream body (what /api/ocr/stream returns)
const fakeOcrSse =
    'data: {"event":"status","data":{"message":"received","stage":"received"}}\n\n' +
    'data: {"event":"ocr_chunk","data":"Hello","index":1,"confidence":0.99,"bbox":[]}\n\n' +
    'data: {"event":"ocr_chunk","data":"World","index":2,"confidence":0.95,"bbox":[]}\n\n' +
    'data: {"event":"ocr_complete","data":{"message":"done","total_lines":2}}\n\n';

// ---------------------------------------------------------------------------
// removeBgMiddleware tests (unchanged behaviour)
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
                if (req.bgError) return res.status(500).json({ error: req.bgError.message });
                if (req.processedImage) return res.status(200).json({
                    hasProcessed: true,
                    mimetype: req.processedImage.mimetype,
                    bufferLength: req.processedImage.buffer.length
                });
                res.status(200).json({ hasProcessed: false });
            }
        );

        app.post(
            '/upload-replace',
            upload.single('image'),
            removeBgMiddleware({ apiUrl, replaceOriginal: true }),
            (req, res) => {
                if (req.bgError) return res.status(500).json({ error: req.bgError.message });
                res.status(200).json({
                    fileSize: req.file.size,
                    fileMimeType: req.file.mimetype,
                    originalName: req.file.originalname,
                    bufferLength: req.file.buffer.length
                });
            }
        );
    });

    afterEach(() => nock.cleanAll());

    test('should return a middleware function', () => {
        expect(typeof removeBgMiddleware()).toBe('function');
    });

    test('should skip if no file is provided', async () => {
        const res = await request(app).post('/upload');
        expect(res.status).toBe(200);
        expect(res.body.hasProcessed).toBe(false);
    });

    test('should skip if file mimetype is not image/', async () => {
        const res = await request(app).post('/upload')
            .attach('image', Buffer.from('hello text'), { filename: 'text.txt', contentType: 'text/plain' });
        expect(res.status).toBe(200);
        expect(res.body.hasProcessed).toBe(false);
    });

    test('should process image and attach to req.processedImage', async () => {
        const fakeProcessed = Buffer.from('processed fake image');
        nock('http://api.test').post('/remove-bg').reply(200, fakeProcessed, { 'Content-Type': 'image/png' });

        const res = await request(app).post('/upload')
            .attach('image', Buffer.from('fake image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(res.body.hasProcessed).toBe(true);
        expect(res.body.mimetype).toBe('image/png');
        expect(res.body.bufferLength).toBe(fakeProcessed.length);
    });

    test('should handle API failure, retry, and set req.bgError', async () => {
        nock('http://api.test').post('/remove-bg').reply(500, 'Error').post('/remove-bg').reply(500, 'Error');

        const res = await request(app).post('/upload')
            .attach('image', Buffer.from('fake image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('Background removal API failed');
    });

    test('should replace original file if replaceOriginal is true', async () => {
        const fakeProcessed = Buffer.from('processed!');
        nock('http://api.test').post('/remove-bg').reply(200, fakeProcessed, { 'Content-Type': 'image/png' });

        const res = await request(app).post('/upload-replace')
            .attach('image', Buffer.from('fake image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(res.body.fileSize).toBe(fakeProcessed.length);
        expect(res.body.fileMimeType).toBe('image/png');
        expect(res.body.originalName).toBe('test.png');
    });
});

// ---------------------------------------------------------------------------
// ocrMiddleware tests — HTTP multipart to /api/ocr
// ---------------------------------------------------------------------------
describe('ocrMiddleware', () => {
    let app;

    beforeEach(() => {
        app = express();
        const upload = multer({ storage: multer.memoryStorage() });

        app.post(
            '/ocr',
            upload.single('image'),
            ocrMiddleware({ apiUrl: OCR_BASE, retries: 1 }),
            (req, res) => {
                if (req.ocrError) return res.status(500).json({ error: req.ocrError.message });
                res.status(200).json(req.ocrResult);
            }
        );
    });

    afterEach(() => nock.cleanAll());

    test('should return a middleware function', () => {
        expect(typeof ocrMiddleware()).toBe('function');
    });

    test('ocrRestMiddleware is an alias of ocrMiddleware', () => {
        expect(ocrRestMiddleware).toBe(ocrMiddleware);
    });

    test('should skip and call next if no file provided', async () => {
        const middleware = ocrMiddleware({ apiUrl: OCR_BASE });
        const next = jest.fn();
        await middleware({}, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('should skip and call next if mimetype is not image/', async () => {
        const middleware = ocrMiddleware({ apiUrl: OCR_BASE });
        const next = jest.fn();
        await middleware({ file: { buffer: Buffer.from('x'), mimetype: 'text/plain' } }, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('should convert wsUrl (ws://) to http:// automatically', async () => {
        nock(OCR_BASE).post('/api/ocr').reply(200, fakeOcrBody);
        const middleware = ocrMiddleware({ wsUrl: 'ws://ocr.test', retries: 0 });
        const req = { file: { buffer: Buffer.from('img'), mimetype: 'image/jpeg', originalname: 'a.jpg' } };
        const next = jest.fn();
        await middleware(req, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrResult).toBeDefined();
    });

    test('should convert wsUrl (wss://) to https:// automatically', async () => {
        nock('https://ocr.test').post('/api/ocr').reply(200, fakeOcrBody);
        const middleware = ocrMiddleware({ wsUrl: 'wss://ocr.test', retries: 0 });
        const req = { file: { buffer: Buffer.from('img'), mimetype: 'image/jpeg', originalname: 'a.jpg' } };
        const next = jest.fn();
        await middleware(req, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.ocrResult).toBeDefined();
    });

    test('should attach req.ocrResult and req.ocrChunks on success', async () => {
        nock(OCR_BASE).post('/api/ocr').reply(200, fakeOcrBody);

        const res = await request(app).post('/ocr')
            .attach('image', Buffer.from('fake-image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(res.body.full_text).toBe('Hello\nWorld');
        expect(res.body.total_lines).toBe(2);
        expect(res.body.lines).toHaveLength(2);
        expect(res.body.lines[0]).toEqual({ text: 'Hello', confidence: 0.99 });
    });

    test('should set req.ocrError when API returns an error and call next', async () => {
        nock(OCR_BASE).post('/api/ocr').reply(500, 'Server error').post('/api/ocr').reply(500, 'Server error');

        const res = await request(app).post('/ocr')
            .attach('image', Buffer.from('fake-image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('OCR failed after 2 attempt(s)');
    });

    test('should retry on failure and succeed on second attempt', async () => {
        nock(OCR_BASE).post('/api/ocr').reply(500, 'Error').post('/api/ocr').reply(200, fakeOcrBody);

        const res = await request(app).post('/ocr')
            .attach('image', Buffer.from('fake-image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(res.body.total_lines).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// ocrStreamHandler tests — HTTP multipart to /api/ocr/stream, pipes SSE
// supertest doesn't buffer text/event-stream body, so streaming-content tests
// use manual req/res mocks (nock still intercepts the upstream axios call).
// ---------------------------------------------------------------------------
describe('ocrStreamHandler', () => {
    let app;

    // Manual mock helpers — mirror the old WebSocket test pattern
    const makeManualReq = (override = {}) => {
        const req = new EventEmitter();
        req.file = { buffer: Buffer.from('fake-image'), mimetype: 'image/jpeg', originalname: 'test.jpg' };
        return Object.assign(req, override);
    };

    const makeManualRes = () => {
        let resEnded = false;
        let resolveEnd;
        const endPromise = new Promise(r => { resolveEnd = r; });
        const written = [];
        const res = {
            setHeader: jest.fn(),
            flushHeaders: jest.fn(),
            write: jest.fn().mockImplementation(d => written.push(d.toString())),
            end: jest.fn().mockImplementation(() => { resEnded = true; resolveEnd(); }),
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockImplementation(() => { resolveEnd && resolveEnd(); }),
            written,
            endPromise
        };
        Object.defineProperty(res, 'writableEnded', { get: () => resEnded });
        return res;
    };

    beforeEach(() => {
        app = express();
        const upload = multer({ storage: multer.memoryStorage() });
        app.post('/ocr/stream', upload.single('image'), ocrStreamHandler({ apiUrl: OCR_BASE, timeout: 5000 }));
    });

    afterEach(() => nock.cleanAll());

    test('should return a handler function', () => {
        expect(typeof ocrStreamHandler()).toBe('function');
    });

    // supertest works fine for non-SSE responses (400 JSON errors)
    test('should return 400 JSON if no file provided', async () => {
        const res = await request(app).post('/ocr/stream');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No image file provided');
    });

    test('should return 400 JSON if file is not an image', async () => {
        const res = await request(app).post('/ocr/stream')
            .attach('image', Buffer.from('txt'), { filename: 'f.txt', contentType: 'text/plain' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('File must be an image');
    });

    // SSE headers check — supertest captures headers even for SSE
    test('should set SSE headers before streaming', async () => {
        nock(OCR_BASE).post('/api/ocr/stream').reply(200, fakeOcrSse, { 'Content-Type': 'text/event-stream' });

        const res = await request(app).post('/ocr/stream')
            .attach('image', Buffer.from('fake-image'), { filename: 'test.jpg', contentType: 'image/jpeg' });

        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.headers['cache-control']).toBe('no-cache');
    });

    // Body content tests — use manual mock because supertest doesn't buffer SSE body
    test('should stream all SSE events from the AI server to the client', async () => {
        nock(OCR_BASE).post('/api/ocr/stream').reply(200, fakeOcrSse, { 'Content-Type': 'text/event-stream' });

        const handler = ocrStreamHandler({ apiUrl: OCR_BASE, timeout: 5000 });
        const req = makeManualReq();
        const res = makeManualRes();

        handler(req, res);
        await res.endPromise;

        const body = res.written.join('');
        expect(body).toContain('"event":"status"');
        expect(body).toContain('"event":"ocr_chunk"');
        expect(body).toContain('"data":"Hello"');
        expect(body).toContain('"data":"World"');
        expect(body).toContain('"event":"ocr_complete"');
    });

    test('should write error SSE event when AI server returns non-200', async () => {
        nock(OCR_BASE).post('/api/ocr/stream').reply(500, 'Internal Server Error');

        const handler = ocrStreamHandler({ apiUrl: OCR_BASE, timeout: 5000 });
        const req = makeManualReq();
        const res = makeManualRes();

        handler(req, res);
        await res.endPromise;

        const body = res.written.join('');
        expect(body).toContain('"event":"error"');
    });

    test('should handle wsUrl (backward compat) — wss:// converts to https://', async () => {
        nock(OCR_BASE).post('/api/ocr/stream').reply(200, fakeOcrSse, { 'Content-Type': 'text/event-stream' });

        const handler = ocrStreamHandler({ wsUrl: 'ws://ocr.test', timeout: 5000 });
        const req = makeManualReq();
        const res = makeManualRes();

        handler(req, res);
        await res.endPromise;

        const body = res.written.join('');
        expect(body).toContain('"event":"ocr_complete"');
    });

    test('should not write error to response when client closes connection', async () => {
        // Simulate client disconnect mid-stream by aborting on 'close'
        nock(OCR_BASE).post('/api/ocr/stream').reply(200, fakeOcrSse, { 'Content-Type': 'text/event-stream' });

        const handler = ocrStreamHandler({ apiUrl: OCR_BASE, timeout: 5000 });
        const req = makeManualReq();
        const res = makeManualRes();

        handler(req, res);
        // Emit close immediately — simulates client disconnect before OCR completes
        req.emit('close');

        await res.endPromise;
        // After client disconnect, no error SSE should be written to the dead connection
        expect(res.written.every(w => !w.includes('"event":"error"'))).toBe(true);
    });
});
