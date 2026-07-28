import { createSubscriberBillingController } from './subscriber-billing.controller';
import { entitlementService } from '../services/entitlement.service';
import { ShipmentRepository } from '../../shipments/shipment.repository';

const shipmentRepo = new ShipmentRepository();

/**
 * Agency billing endpoints — plan discovery, current plan (with unterminated
 * -shipment usage against the soft cap), credit balance, top-ups, settings.
 * Mounted at `/api/agency`.
 */
export const AgencyBillingController = createSubscriberBillingController('agency', async (agencyId) => {
  const { maxUnterminatedShipments } = await entitlementService.getShipmentEntitlements('agency', agencyId);
  const currentUnterminated = await shipmentRepo.countUnterminatedByAgency(agencyId);
  const remaining =
    maxUnterminatedShipments === null ? null : Math.max(0, maxUnterminatedShipments - currentUnterminated);
  return { shipments: { maxUnterminatedShipments, currentUnterminated, remaining } };
});
