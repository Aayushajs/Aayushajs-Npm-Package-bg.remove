const request = require('supertest');
const express = require('express');
const multer = require('multer');
const nock = require('nock');
const { removeBgMiddleware } = require('../src/index');

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

    test('should throw error if apiUrl is not provided', () => {
        expect(() => removeBgMiddleware({})).toThrow('requires an apiUrl option');
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

        // Will fail twice (initial + 1 retry because retries=1)
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
