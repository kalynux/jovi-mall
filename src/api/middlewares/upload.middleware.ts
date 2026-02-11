import multer from 'multer';

/**
 * File Upload Middleware Configuration
 * 
 * Uses memory storage for streaming uploads to prevent disk I/O.
 * Files are validated and uploaded directly to storage provider.
 */

const MAX_FILE_SIZE = parseInt(process.env.MAX_DIGITAL_ASSET_SIZE || '524288000'); // 500MB

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
