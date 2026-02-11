import { Router, Request, Response } from 'express';
import { DigitalEntitlementService } from '../../digital-delivery/services/digital-entitlement.service';
import { DownloadLinkService } from '../../digital-delivery/services/download-link.service';

/**
 * Customer Digital Product Routes
 * 
 * Allows customers to view their digital product library and generate download links.
 */

const router = Router();
const entitlementService = new DigitalEntitlementService();
const downloadLinkService = new DownloadLinkService();

/**
 * GET /api/customer/digital-products
 * List customer's digital product library
 * 
 * Returns all digital products the customer has purchased with entitlement status.
 */
router.get('/digital-products', async (req: Request, res: Response) => {
  try {
    // TODO: Extract customerId from auth middleware
    const customerId = (req as any).user?.customerId;
    if (!customerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const entitlements = await entitlementService.getCustomerEntitlements(customerId);

    return res.status(200).json({
      products: entitlements,
      total: entitlements.length,
    });
  } catch (error: any) {
    console.error('Error fetching customer digital products:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/customer/digital-products/:id/download-link
 * Generate a download link for a purchased digital product
 * 
 * Param :id = entitlementId
 * Returns: { url, expiresAt, downloadsRemaining }
 */
router.post('/digital-products/:id/download-link', async (req: Request, res: Response) => {
  try {
    // TODO: Extract customerId from auth middleware
    const customerId = (req as any).user?.customerId;
    if (!customerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id: entitlementId } = req.params;

    const result = await downloadLinkService.createDownloadLink({
      entitlementId,
      customerId,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Error creating download link:', error);
    return res.status(400).json({ error: error.message });
  }
});

export default router;
