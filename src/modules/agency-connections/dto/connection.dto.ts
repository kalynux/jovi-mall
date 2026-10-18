import { IVendorAgencyConnection, ConnectionStatus, ConnectionParty } from '../connection.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

/**
 * The OTHER party's account status, as the caller sees it (2026-10-18). Same three values
 * on both sides — `Vendor.status` and `DeliveryAgency.status` share the enum.
 * `null` only when the counterparty row no longer exists.
 */
export type CounterpartyStatus = 'active' | 'pending_verification' | 'inactive';

/**
 * The OTHER party's display fields (2026-10-18), so a connection row can be rendered
 * without a second lookup. Same shape on both sides:
 *   - for an agency caller: the vendor's Store name + logo, the vendor's display name;
 *   - for a vendor caller:  the agency's Magazin name + logo, the agency's display name.
 *
 * ⚠ It exists because the directories list ACTIVE accounts only since the same day, and the
 * agency dashboard had been naming connection rows by scanning `/browse` for the vendor id —
 * so the rows that most needed a name (a `pending_verification` counterparty) lost it. A
 * connection row must never depend on the directory to name itself.
 *
 * `businessName` is `''` when the counterparty has no Store/Magazin yet (the browse DTOs use
 * the same fallback). Public fields only — the same ones the browse cards already show.
 */
export interface CounterpartyProfile {
  businessName: string;
  displayName: string | null;
  logo: FileDetail | null;
  kycVerified: boolean;
}

/** Both counterparty fields, resolved together by `ConnectionService.counterpartiesFor`. */
export interface Counterparty {
  status: CounterpartyStatus;
  profile: CounterpartyProfile;
}

export interface ConnectionDto {
  id: string;
  vendorId: string;
  agencyId: string;
  status: ConnectionStatus;

  requesterRole: ConnectionParty;
  requestedByUserId: string;
  requestedAt: string;

  respondedByUserId: string | null;
  respondedAt: string | null;

  reapprovalRequiredFrom: ConnectionParty | null;
  pausedAt: string | null;
  pausedReason: 'vendor_policy_changed' | 'agency_policy_changed' | null;

  rejection: {
    reason: string | null;
    rejectedByRole: ConnectionParty;
    rejectedAt: string;
  } | null;
  withdrawal: {
    withdrawnByRole: ConnectionParty;
    withdrawnAt: string;
  } | null;
  termination: {
    terminatedByRole: ConnectionParty;
    terminatedAt: string;
    reason: 'unilateral' | 'reapproval_declined' | 'role_closed';
    note: string | null;
  } | null;

  /**
   * The counterparty's account status — the AGENCY's for a vendor caller, the VENDOR's for
   * an agency caller. ⚠ Approvals deliberately ignore it, so a connection can be `active`
   * while this is `pending_verification`; for a vendor that means the agency cannot carry
   * physical products yet (the activation gate requires an `active` agency) and the
   * dashboard should say so beside the approve button and on the connection.
   */
  counterpartyStatus: CounterpartyStatus | null;

  /** The counterparty's name, logo and KYC badge — see `CounterpartyProfile`. `null` only when the counterparty row no longer exists. */
  counterpartyProfile: CounterpartyProfile | null;

  createdAt: string;
  updatedAt: string;
}

export interface ConnectionListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ConnectionMapper {
  /**
   * `counterparty` is REQUIRED rather than optional so a new call site cannot forget it and
   * silently ship `undefined` — resolve it with `ConnectionService.counterpartiesFor`.
   * `null` means the counterparty row no longer exists.
   */
  static toDto(connection: IVendorAgencyConnection, counterparty: Counterparty | null): ConnectionDto {
    return {
      id: connection._id.toString(),
      vendorId: connection.vendor_id.toString(),
      agencyId: connection.agency_id.toString(),
      status: connection.status,

      requesterRole: connection.requester_role,
      requestedByUserId: connection.requested_by_user_id.toString(),
      requestedAt: connection.requested_at.toISOString(),

      respondedByUserId: connection.responded_by_user_id?.toString() ?? null,
      respondedAt: connection.responded_at?.toISOString() ?? null,

      reapprovalRequiredFrom: connection.reapproval_required_from,
      pausedAt: connection.paused_at?.toISOString() ?? null,
      pausedReason: connection.paused_reason,

      rejection: connection.rejection
        ? {
          reason: connection.rejection.reason,
          rejectedByRole: connection.rejection.rejected_by_role,
          rejectedAt: connection.rejection.rejected_at.toISOString(),
        }
        : null,
      withdrawal: connection.withdrawal
        ? {
          withdrawnByRole: connection.withdrawal.withdrawn_by_role,
          withdrawnAt: connection.withdrawal.withdrawn_at.toISOString(),
        }
        : null,
      termination: connection.termination
        ? {
          terminatedByRole: connection.termination.terminated_by_role,
          terminatedAt: connection.termination.terminated_at.toISOString(),
          reason: connection.termination.reason,
          note: connection.termination.note,
        }
        : null,

      counterpartyStatus: counterparty?.status ?? null,
      counterpartyProfile: counterparty?.profile ?? null,

      createdAt: connection.created_at.toISOString(),
      updatedAt: connection.updated_at.toISOString(),
    };
  }
}
