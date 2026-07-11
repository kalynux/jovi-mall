import { IVendorAgencyConnection, ConnectionStatus, ConnectionParty } from '../connection.model';

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
    reason: 'unilateral' | 'reapproval_declined';
    note: string | null;
  } | null;

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
  static toDto(connection: IVendorAgencyConnection): ConnectionDto {
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

      createdAt: connection.created_at.toISOString(),
      updatedAt: connection.updated_at.toISOString(),
    };
  }
}
