import { z } from 'zod';

/**
 * Shipment API Validators
 */

// Set/update the carrier tracking number on a shipment.
// Mirrors the tracking-number constraint used by the ticket validator.
export const SetTrackingNumberSchema = z.object({
    trackingNumber: z.string().trim().min(1, 'Tracking number is required').max(120, 'Tracking number too long')
});

export type SetTrackingNumberDto = z.infer<typeof SetTrackingNumberSchema>;
