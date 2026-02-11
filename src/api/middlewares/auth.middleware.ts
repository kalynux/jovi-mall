import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../../modules/users/user.repository';
import { CustomerRepository } from '../../modules/customers/customer.repository';
import { VendorRepository } from '../../modules/vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../modules/delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../../modules/delivery/delivery-agent.repository';
import { AdminRepository } from '../../modules/admins/admin.repository';

// Repositories
const userRepo = new UserRepository();
const customerRepo = new CustomerRepository();
const vendorRepo = new VendorRepository();
const agencyRepo = new DeliveryAgencyRepository();
const agentRepo = new DeliveryAgentRepository();
const adminRepo = new AdminRepository();

export interface AuthUserPayload {
  userId: string;
  role: string;
}

declare global { 
  namespace Express {
    interface Request {
      auth?: {
        user: import('../../modules/users/user.model').IUser;
        role: string;
        role_entity: any;
      };
      // Deprecated aliases for backward compatibility (optional, but keeping for safety)
      user?: import('../../modules/users/user.model').IUser;
      role?: string;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing token' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'secret') as AuthUserPayload;
    
    // 1. Load User
    const user = await userRepo.findById(payload.userId);
    if (!user) {
        res.status(401).json({ error: 'Unauthorized: User not found' });
        return;
    }

    // 2. Load Role Entity
    let entity = null;
    const role = payload.role;

    if (role === 'customer') entity = await customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await agentRepo.findByUserId(user.id);
    else if (role === 'admin') entity = await adminRepo.findByUserId(user.id);
    
    if (!entity) {
         res.status(401).json({ error: 'Unauthorized: Role profile not found' });
         return;
    }

    // 3. Attach to Request
    req.auth = {
        user,
        role,
        role_entity: entity
    };

    // Backward compatibility aliases
    req.user = user;
    req.role = role;
    (req as any).role_entity = entity; // Keeping this for now if used elsewhere

    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.role) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }
    next();
  };
};
