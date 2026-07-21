/**
 * Shipment-assignment module — the agent-acceptance workflow.
 *
 * Public surface for the application layer (server.ts) and any cross-module
 * caller. Routes are mounted from delivery/agent.routes.ts and
 * delivery/agency.routes.ts (which import the controllers directly), mirroring
 * how the rest of the delivery surface is wired.
 */

export { shipmentAssignmentService, ShipmentAssignmentService } from './domain/services/shipment-assignment.service';
export type { OfferCreator, OfferResult } from './domain/services/shipment-assignment.service';
export {
  assignmentCandidateService,
  AssignmentCandidateService,
  scoreCandidate,
  rankScored,
  distanceScore,
  haversineKm,
} from './domain/services/assignment-candidate.service';
export type { ScoredCandidate, CandidateScoreInput, CandidateScoreBreakdown } from './domain/services/assignment-candidate.service';

export { ASSIGNMENT_CONFIG } from './config/assignment.config';
export { ShipmentAssignmentOfferModel } from './models/shipment-assignment-offer.model';
export { registerAssignmentEventSubscriber } from './services/assignment-event-subscriber';
export { offerExpiryWorker } from './workers/offer-expiry.worker';

import { registerAssignmentEventSubscriber } from './services/assignment-event-subscriber';
import { offerExpiryWorker } from './workers/offer-expiry.worker';

/**
 * Register the auto-assignment subscriber and start the offer-expiry sweep.
 * Call once at boot, after the Mongo connection is up.
 */
export function initializeShipmentAssignment(): void {
  registerAssignmentEventSubscriber();
  offerExpiryWorker.start();
}
