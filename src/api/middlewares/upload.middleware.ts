import multer from 'multer';

/**
 * File Upload Middleware Configuration
 * 
 * Uses memory storage for streaming uploads to prevent disk I/O.
 * Files are validated and uploaded directly to storage provider.
 */

/**
 * ⚠ The default is the CONTAINER's ceiling, not the storage provider's.
 *
 * `multer.memoryStorage()` below buffers the WHOLE file in process memory before any validator,
 * scanner or storage provider sees a byte — and Node `Buffer`s live OUTSIDE the V8 heap, so
 * `--max-old-space-size` does not bound them. `mem_limit` does. jovi-mall runs at
 * `mem_limit: 768m` in `docker-compose.prod.yml`, so the previous 500 MB default OOM-killed the
 * container on a large digital asset, whichever storage provider was configured.
 *
 * Kept in lockstep with `getDigitalAssetUploadConfig()` in `core/uploads/upload-config.ts`,
 * which reads the same variable and must carry the same fallback — see the note there.
 * Raise this only together with the container's memory limit.
 */
const MAX_FILE_SIZE = parseInt(process.env.MAX_DIGITAL_ASSET_SIZE || '157286400'); // 150MB

// Memory storage - file buffer kept in memory for direct streaming to storage
const storage = multer.memoryStorage();

// Multer instance for digital asset uploads
export const uploadDigitalAsset = multer({
    storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1, // Only one file per upload
    },
    fileFilter: (req, file, cb) => {
        // Additional filtering can be done here, but we'll do comprehensive validation in the controller
        cb(null, true);
    },
});

// Middleware for single file upload with field name "file"
export const uploadSingle = uploadDigitalAsset.single('file');
