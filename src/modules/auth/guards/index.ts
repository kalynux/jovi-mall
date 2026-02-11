import { Request, Response, NextFunction } from 'express';

/**
 * Checks if the User account is active.
 */
export const requireActiveUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth?.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (req.auth.user.status !== 'active') {
    res.status(403).json({ error: 'User account is suspended' });
    return;
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
      res.status(403).json({ error: 'Invalid role for this action' });
      return;
    }
    next();
  };
};

/**
 * Checks if the Role Entity profile is active/verified.
 */
export const requireRoleEntityActive = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth?.role_entity) {
    res.status(403).json({ error: 'Role profile not found' });
    return;
  }
  
  if (req.auth.role_entity.status !== 'active') {
    res.status(403).json({ error: 'Role is not active or not verified' });
    return;
  }
  next();
};

/**
 * Checks if the Business (Vendor/Agency) is verified.
 */
export const requireLegitBusiness = (req: Request, res: Response, next: NextFunction) => {
  const entity = req.auth?.role_entity;
  if (!entity) {
    res.status(403).json({ error: 'Business profile not found' });
    return;
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
    res.status(403).json({ error: 'Business is not approved yet' });
    return;
  }
  next();
};
