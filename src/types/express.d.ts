import 'express';

// Extend Express Request type to include Multer file properties
declare global {
    namespace Express {
        interface Request {
            file?: Express.Multer.File;
            files?: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
        }
    }
}
