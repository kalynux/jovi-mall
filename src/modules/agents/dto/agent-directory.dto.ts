import { IDeliveryAgent, AgentAvailabilityState, AgentWorkingState } from '../models/agent.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { ContractStatus } from '../models/agent-agency-membership.model';

/**
 * The agent as seen by an agency that has not contracted with them yet.
 *
 * This is a PUBLIC work profile, not a roster entry. `AgentRosterEntryDto`
 * (agent-profile.dto.ts) is the roster view and deliberately carries `email`
 * and `phone` — an agency that already holds a contract needs to reach its
 * agent. Nothing in the directory does, so nothing here does either. The two
 * DTOs are not interchangeable; do not "unify" them.
 */

export interface AgentDirectoryHomeBaseDto {
  /** Human label the agent set ("Douala — Akwa"). */
  label: string | null;
  /** GeoJSON [lng, lat], or null if the agent has not set a home base. */
  coordinates: [number, number] | null;
  serviceRadiusKm: number | null;
}

export interface AgentDirectoryRatingDto {
  average: number | null;
  count: number;
}

export interface AgentDirectoryItemDto {
  id: string;
  name: string;
  avatar: FileDetail | null;
  vehicleType: 'bike' | 'car' | 'van' | 'truck' | null;
  homeBase: AgentDirectoryHomeBaseDto;
  /** Composite 0–100 trust score. */
  trustScore: number;
  /** Always true in the directory — unverified agents are filtered out. */
  kycVerified: boolean;
  /** Does the agent want work right now? */
  availability: AgentAvailabilityState;
  /**
   * How loaded the agent is, as a LABEL. The raw counters
   * (`capacity.active_shipment_count` / `max_active_shipments`) are the
   * agent's own business and are never exposed to an agency that has no
   * contract with them.
   */
  workingState: AgentWorkingState;
  completedShipments: number;
  /** 0–1, or null before enough deliveries to mean anything. */
  onTimeRate: number | null;
  ratings: {
    customer: AgentDirectoryRatingDto;
    agency: AgentDirectoryRatingDto;
    vendor: AgentDirectoryRatingDto;
  };
}

/** The contract state between the caller and this counterparty, if any. */
export interface DirectoryContractRefDto {
  id: string;
  status: ContractStatus;
  /** Which party raised it — drives Withdraw vs Accept/Reject in the UI. */
  initiatedBy: 'agent' | 'agency';
  isPrimary: boolean;
}

/** A directory row: the counterparty plus the caller's standing with them. */
export type WithContractRef<T> = T & { contract: DirectoryContractRefDto | null };

export interface DirectoryListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AgentDirectoryMapper {
  /**
   * Map an agent document to the agency-facing directory item.
   *
   * SECURITY — never returned here, and each for its own reason:
   * - `email` / `phone` — contact details are earned by contracting, not by
   *   browsing. Exposing them would hand every agency on the platform a
   *   scrapeable list of couriers' personal numbers.
   * - `legal_identity` (licence, national ID) — admin-only, always.
   * - `payout_details` — financial.
   * - `emergency_contact` — a third party who never consented to the platform.
   * - `device` / `wa` / `last_known_tracking_state` — operational telemetry;
   *   position in particular is geo-tracker's to serve, under Tracking Allow.
   * - `cod.max_threshold` and the raw capacity counters — the agent's standing
   *   with OTHER agencies is none of this agency's business.
   */
  static toListItemDto(
    agent: IDeliveryAgent,
    avatar: FileDetail | null = null
  ): AgentDirectoryItemDto {
    const signals = agent.trust_signals;

    return {
      id: agent._id.toString(),
      name: agent.name,
      avatar,
      vehicleType: agent.vehicle_info?.vehicle_type ?? null,
      homeBase: {
        label: agent.home_base?.label ?? null,
        coordinates: agent.home_base?.location?.coordinates ?? null,
        serviceRadiusKm: agent.home_base?.service_radius_km ?? null,
      },
      trustScore: agent.cod?.trust_score ?? 100,
      kycVerified: agent.kyc?.status === 'verified',
      availability: agent.availability?.state ?? 'offline',
      workingState: agent.working_state?.state ?? 'idle',
      completedShipments: signals?.completed_shipments ?? 0,
      onTimeRate: signals?.on_time_rate ?? null,
      ratings: {
        customer: {
          average: signals?.customer_rating_avg ?? null,
          count: signals?.customer_rating_count ?? 0,
        },
        agency: {
          average: signals?.agency_rating_avg ?? null,
          count: signals?.agency_rating_count ?? 0,
        },
        vendor: {
          average: signals?.vendor_rating_avg ?? null,
          count: signals?.vendor_rating_count ?? 0,
        },
      },
    };
  }
}
