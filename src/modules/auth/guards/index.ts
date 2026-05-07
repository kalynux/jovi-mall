import { Request, Response, NextFunction } from 'express';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Checks if the User account is active.
 */
export const requireActiveUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth?.user) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
  }
  if (req.auth.user.status !== 'active') {
    return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'User account is suspended'));
  }
  next();
};

/**
 * Checks if the current role matches the required role.
 * (Note: Existing requireRole in auth.middleware handles array, this is specific factory as requested)
 */
export const requireRole = (role: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.role !== role) {
      return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Invalid role for this action'));
    }
    next();
  };
};

/**
 * Checks if the Role Entity profile is active/verified.
 */
export const requireRoleEntityActive = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth?.role_entity) {
    return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Role profile not found'));
  }

  if (req.auth.role_entity.status !== 'active') {
    return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Role is not active or not verified'));
  }
  next();
};

/**
 * Checks if the Business (Vendor/Agency) is verified.
 */
export const requireLegitBusiness = (req: Request, res: Response, next: NextFunction) => {
  const entity = req.auth?.role_entity;
  if (!entity) {
    return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Business profile not found'));
  }

  // Only applies to vendor and agency
  const role = req.auth?.role;
  if (role !== 'vendor' && role !== 'agency' && role !== 'delivery_agency') {
    // Assuming it doesn't apply to others, or should we error? 
    // "Applies ONLY to vendor, agency"
    // If called on other roles, it depends on usage. 
    // Safe default: if strict, error. If permissive, pass.
    // Given the error message "Business is not approved", it implies we expect a business.
    // So if I call this on a Customer, it should probably fail or be irrelevant.
    // Let's enforce it checks the property.
  }

  if (entity.legit_verified !== true) {
    return next(createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Business is not approved yet'));
  }
  next();
};
