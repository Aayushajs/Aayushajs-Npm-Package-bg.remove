const axios = require('axios');
const FormData = require('form-data');

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
        apiUrl,
        timeout = 10000,
        retries = 2,
        replaceOriginal = false,
        fieldName = 'file'
    } = options;

    if (!apiUrl) {
        throw new Error('removeBgMiddleware requires an apiUrl option');
    }

    return async function(req, res, next) {
        try {
            // 1. Validate file exists
            if (!req || !req.file || !req.file.buffer) {
                return next();
            }

            // 2. Validate mimetype starts with "image/"
            if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
                return next();
            }

            let attempts = 0;
            let success = false;
            let lastError = null;
            const maxAttempts = retries + 1; // 1 initial attempt + retries

            while (attempts < maxAttempts && !success) {
                attempts++;
                try {
                    // 3. Create FormData and append file buffer
                    const form = new FormData();
                    form.append(fieldName, req.file.buffer, {
                        filename: req.file.originalname || 'image.jpg',
                        contentType: req.file.mimetype
                    });

                    // 4. Send POST request
                    const response = await axios.post(apiUrl, form, {
                        headers: {
                            ...form.getHeaders()
                        },
                        responseType: 'arraybuffer',
                        timeout: timeout
                    });

                    // 5. On success, parse buffer and attach result
                    const processedBuffer = Buffer.from(response.data);
                    
                    const contentTypeHeader = response.headers['content-type']?.toLowerCase();
                    const outMimeType = (contentTypeHeader && contentTypeHeader.startsWith('image/')) 
                        ? contentTypeHeader 
                        : 'image/png';

                    req.processedImage = {
                        buffer: processedBuffer,
                        mimetype: outMimeType
                    };

                    // 6. Replace original if replaceOriginal = true
                    if (replaceOriginal) {
                        req.file.buffer = processedBuffer;
                        req.file.mimetype = outMimeType;
                        req.file.size = processedBuffer.length;
                        
                        // Update extension in originalname if format changed to png
                        if (outMimeType === 'image/png' && req.file.originalname) {
                            req.file.originalname = req.file.originalname.replace(/\.[^/.]+$/, ".png");
                        }
                    }

                    success = true;
                } catch (err) {
                    lastError = err;
                }
            }

            // 7. If still fails -> attach error to req.bgError
            if (!success) {
                const errMsg = lastError?.message || 'Unknown error';
                req.bgError = new Error(`Background removal API failed after ${attempts} attempts. Last error: ${errMsg}`);
            }

            next();
        } catch (err) {
            // Failsafe catch block to guarantee next() is always called and no crash happens
            req.bgError = err;
            next();
        }
    };
}

module.exports = {
    removeBgMiddleware
};
