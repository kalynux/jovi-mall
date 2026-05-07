import { Router, Request, Response, NextFunction } from 'express';
import { VendorInventoryController } from '../controllers/vendor-inventory.controller';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import multer from 'multer';

const router = Router();
const controller = new VendorInventoryController();

// Configure multer for CSV uploads (in-memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'));
        }
    }
});

// Vendor auth middleware
const vendorAuth = [requireAuth, requireRole(['vendor'])];

/**
 * Vendor Inventory Management Routes
 * 
 * All routes require vendor authentication.
 * All operations are vendor-scoped.
 */

// GET /api/vendor/inventory/alerts
router.get('/alerts', vendorAuth, (req: Request, res: Response, next: NextFunction) => controller.getAlerts(req, res, next));

// PATCH /api/vendor/inventory/bulk-update
// Supports both JSON and CSV uploads
router.patch(
    '/bulk-update',
    vendorAuth,
    upload.single('file'),
    (req: Request, res: Response, next: NextFunction) => controller.bulkUpdate(req, res, next)
);

// GET /api/vendor/inventory/history
router.get('/history', vendorAuth, (req: Request, res: Response, next: NextFunction) => controller.getHistory(req, res, next));

// GET /api/vendor/inventory/reservations
router.get('/reservations', vendorAuth, (req: Request, res: Response, next: NextFunction) => controller.getReservations(req, res, next));

export default router;
