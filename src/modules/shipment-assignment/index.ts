/**
 * Shipment-assignment module — the agent-acceptance workflow + auto-assignment.
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
export type {
  ScoredCandidate,
  RankedCandidate,
  RankingResult,
  CandidateScoreInput,
  CandidateScoreBreakdown,
} from './domain/services/assignment-candidate.service';

export { ASSIGNMENT_CONFIG } from './config/assignment.config';
export { ShipmentAssignmentOfferModel } from './models/shipment-assignment-offer.model';
export { ShipmentAssignmentSessionModel } from './models/shipment-assignment-session.model';
export { geoRoutingClient, GeoRoutingClient } from './services/geo-routing.client';
export { registerAssignmentEventSubscriber } from './services/assignment-event-subscriber';
export { assignmentSweepWorker, offerExpiryWorker } from './workers/offer-expiry.worker';

import { registerAssignmentEventSubscriber } from './services/assignment-event-subscriber';
import { assignmentSweepWorker } from './workers/offer-expiry.worker';

/**
 * Register the auto-assignment subscriber and start the assignment sweep (session
 * advancement + manual-offer expiry). Call once at boot, after Mongo connects.
 */
export function initializeShipmentAssignment(): void {
  registerAssignmentEventSubscriber();
  assignmentSweepWorker.start();
}
