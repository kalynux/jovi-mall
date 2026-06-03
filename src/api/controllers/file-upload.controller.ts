import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { UploadIntakeService } from '../../core/uploads/upload-intake.service';
import { loadUploadConfig } from '../../core/uploads/upload-config';
import { getStorageProvider } from '../../core/storage';
import { FileRepositoryMongo } from '../../modules/catalog/repositories/mongo/file.repository.mongo';
import { IUploadObserver, IVirusScanner } from '../../core/uploads/upload-policy.types';

// Role-based file size limits (in bytes)
const ROLE_UPLOAD_LIMITS = {
    vendor: 500 * 1024 * 1024,      // 500 MB
    agent: 1024 * 1024 * 1024,      // 1 GB
    admin: 2 * 1024 * 1024 * 1024,  // 2 GB
    customer: 100 * 1024 * 1024,    // 100 MB
};

// No-op implementations for observer and scanner
class NoOpUploadObserver implements IUploadObserver { }

class NoOpVirusScanner implements IVirusScanner {
    async scan(buffer: Buffer, filename?: string): Promise<{ clean: boolean; reason?: string; virus?: string }> {
        return { clean: true };
    }
}

// Memory storage for multer
const storage = multer.memoryStorage();

// Multer instance for multi-file uploads (max 10 files)
export const uploadMultiple = multer({
    storage,
    limits: {
        files: 10, // Maximum 10 files per request
        fileSize: 2 * 1024 * 1024 * 1024, // 2 GB max (actual limit checked per-role)
    },
    fileFilter: (req, file, cb) => {
        // Accept all files - validation happens in controller
        cb(null, true);
    },
}).array('files', 10); // Field name: 'files', max 10 files

/**
 * FileUploadController
 * 
 * Global file upload endpoint with role-based limits.
 * Handles 1-10 files per request.
 */
export class FileUploadController {
    /**
     * POST /api/files/upload
     * Upload 1-10 files with role-based size limits
     */
    static async uploadFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const vendorId = userRole === 'vendor' ? req.auth!.role_entity._id.toString() : undefined;

            // Validate files were uploaded
            if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'NO_FILES_UPLOADED',
                        message: 'At least one file is required',
                    },
                });
                return;
            }

            // Validate file count
            if (req.files.length > 10) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'TOO_MANY_FILES',
                        message: 'Maximum 10 files per request',
                    },
                });
                return;
            }

            // Get role-based size limit
            const maxFileSize = ROLE_UPLOAD_LIMITS[userRole as keyof typeof ROLE_UPLOAD_LIMITS] || ROLE_UPLOAD_LIMITS.customer;

            // Validate each file size against role limit
            for (const file of req.files) {
                if (file.size > maxFileSize) {
                    res.status(413).json({
                        success: false,
                        error: {
                            code: 'FILE_TOO_LARGE',
                            message: `File "${file.originalname}" exceeds ${userRole} limit of ${maxFileSize / (1024 * 1024)} MB`,
                        },
                    });
                    return;
                }
            }

            // Initialize services
            const config = loadUploadConfig();
            const storageProvider = getStorageProvider();
            const fileRepository = new FileRepositoryMongo();
            const observer = new NoOpUploadObserver();
            const virusScanner = new NoOpVirusScanner();

            const uploadIntakeService = new UploadIntakeService(
                config,
                storageProvider,
                fileRepository,
                observer,
                virusScanner
            );

            // Execute upload
            const uploadedFiles = await uploadIntakeService.execute({
                folder: 'products',
                context: {
                    userId,
                    vendorId,
                    role: userRole === 'admin' ? 'admin' : userRole === 'vendor' ? 'vendor' : 'user',
                },
                files: req.files.map(file => ({
                    buffer: file.buffer,
                    originalName: file.originalname,
                    size: file.size,
                    mimeType: file.mimetype,
                })),
            });

            res.status(201).json({
                success: true,
                data: uploadedFiles,
                message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
                meta: {
                    count: uploadedFiles.length,
                    roleLimit: `${maxFileSize / (1024 * 1024)} MB`,
                },
            });
        } catch (error) {
            // Forward to the global error handler, which normalises AppError
            // (including its `details`, e.g. the per-file policy violations) into
            // the standard response envelope. See error-handler.middleware.ts.
            next(error);
        }
    }
}
