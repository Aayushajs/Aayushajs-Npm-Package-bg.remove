# express-bg-remover

A production-ready, lightweight Express middleware for removing image backgrounds using an external API (like Hugging Face spaces).

## Features
- **Lightweight**: Minimal dependencies (`axios`, `form-data`), highly optimized.
- **Fail-safe**: Graceful error handling that guarantees the middleware chain is never broken (`next()` is always called).
- **Flexible**: Processed image can be attached separately or replace the original upload.
- **Robust**: Built-in timeout and retry mechanisms.

---

## 🚀 Complete Setup & Usage Guide

Follow these steps to seamlessly integrate `express-bg-remover` into your existing backend.

### Step 1: Install Dependencies
Install the package along with `multer` (required for parsing `multipart/form-data`).

```bash
npm install express-bg-remover multer
```

### Step 2: Basic Configuration in Express
Here is a complete, working example of how to configure your Express route using `multer` and our background removal middleware.

```javascript
const express = require('express');
const multer = require('multer');
const { removeBgMiddleware } = require('express-bg-remover');

const app = express();

// Set up multer to store uploaded files in memory
const upload = multer({ storage: multer.memoryStorage() });

// The API endpoint performing the background removal (e.g., Hugging Face Space)
const BG_API_URL = 'https://DevelopmentT-background-remover.hf.space/remove-bg';

// Define the POST upload route
app.post(
    '/upload',
    // 1. Multer parses the 'image' field and stores it in req.file
    upload.single('image'),
    
    // 2. Background Remover Middleware
    removeBgMiddleware({
        apiUrl: BG_API_URL,      // Required: API URL
        timeout: 10000,          // Optional: max 10 seconds wait (default)
        retries: 2,              // Optional: 2 retries on fail (default)
        replaceOriginal: false,  // Optional: keep original image, attach processed one (default)
        fieldName: 'file'        // Optional: field name sent to the API
    }),
    
    // 3. Final Request Handler
    (req, res) => {
        // Handle Middleware Errors (if the external API failed)
        if (req.bgError) {
            console.error('Background removal failed:', req.bgError.message);
            // We can return 500, or gracefully fallback to not editing the image at all.
            return res.status(500).json({ error: 'Background removal process failed' });
        }

        // Access the processed image
        if (req.processedImage) {
            console.log('Processed Buffer Size:', req.processedImage.buffer.length);
            console.log('Mime Type:', req.processedImage.mimetype);
            
            // You can now upload this buffer to S3 or write it to a file
            // require('fs').writeFileSync('output.png', req.processedImage.buffer);
            
            return res.status(200).json({ 
                success: true, 
                message: 'Image processed successfully!' 
            });
        }

        // Fallback for missing/invalid uploads
        res.status(400).json({ error: 'No valid image provided' });
    }
);

app.listen(3000, () => console.log('Server running on port 3000'));
```

### Step 3: Replace Original Concept
If you'd rather pretend the original uploaded file *was* the transparent one from the start, just set `replaceOriginal: true`.

```javascript
app.post(
    '/upload-replace',
    upload.single('image'),
    removeBgMiddleware({
        apiUrl: BG_API_URL,
        replaceOriginal: true // Overwrites req.file.buffer directly
    }),
    (req, res) => {
        if (req.bgError) return res.status(500).json({ error: 'Failed' });

        // req.file now contains the background-removed image buffer!
        // req.file.mimetype and req.file.size are automatically updated.
        res.json({ message: 'Success', size: req.file.size });
    }
);
```

---

## ⚙️ Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | **Required** | Endpoint for POSTing the image. |
| `timeout` | `number` | `10000` | Request timeout in milliseconds. |
| `retries` | `number` | `2` | Number of times to retry if API fails. |
| `replaceOriginal`| `boolean` | `false` | If true, updates `req.file.buffer`, `mimetype`, and `originalname` with the processed image. |
| `fieldName` | `string` | `"file"` | Name of the form-data parameter sent to the external API. |

## 🛡️ Error Handling Mechanics

If the file is not provided or its mimetype does not start with `image/`, processing is **skipped** entirely and the next middleware is called without any modifications. This ensures you can apply it globally if needed.

If the external API request fails after all retries or times out, the server **will not crash**. Instead, the error will be attached to the request object as `req.bgError`. You should manually check for `req.bgError` in your final controller logic.
