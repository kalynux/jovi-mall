import { ClientSession } from 'mongoose';
import {
  ContractStatusRequestModel,
  IContractStatusRequest,
  ContractTransition,
  StatusRequestState,
  ContractParty,
} from '../models/contract-status-request.model';
import { ContractStatus } from '../models/agent-agency-membership.model';

export interface CreateStatusRequestInput {
  contractId: string;
  agentId: string;
  agencyId: string;
  transition: ContractTransition;
  targetStatus: ContractStatus;
  fromStatus: ContractStatus;
  requestedByRole: ContractParty;
  requestedByUserId: string | null;
  reason: string | null;
  blockingConditions?: Record<string, unknown> | null;
}

/** Persistence for proposed contract transitions. */
export class ContractStatusRequestRepository {
  async create(input: CreateStatusRequestInput, session?: ClientSession): Promise<IContractStatusRequest> {
    const [request] = await ContractStatusRequestModel.create(
      [
        {
          contract_id: input.contractId,
          agent_id: input.agentId,
          agency_id: input.agencyId,
          transition: input.transition,
          target_status: input.targetStatus,
          from_status: input.fromStatus,
          state: 'pending',
          requested_by_role: input.requestedByRole,
          requested_by_user_id: input.requestedByUserId,
          reason: input.reason,
          blocking_conditions: input.blockingConditions ?? null,
        },
      ],
      session ? { session } : {}
    );
    return request;
  }

  async findById(requestId: string, session?: ClientSession): Promise<IContractStatusRequest | null> {
    return await ContractStatusRequestModel.findById(requestId).session(session ?? null);
  }

  async findPending(
    contractId: string,
    transition: ContractTransition,
    session?: ClientSession
  ): Promise<IContractStatusRequest | null> {
    return await ContractStatusRequestModel.findOne({
      contract_id: contractId,
      transition,
      state: 'pending',
    }).session(session ?? null);
  }

  async listForContract(contractId: string): Promise<IContractStatusRequest[]> {
    return await ContractStatusRequestModel.find({ contract_id: contractId }).sort({ created_at: -1 });
  }

  /** "What needs my decision?" — the counterparty's inbox. */
  async listPendingForAgency(agencyId: string): Promise<IContractStatusRequest[]> {
    return await ContractStatusRequestModel.find({ agency_id: agencyId, state: 'pending' }).sort({
      created_at: -1,
    });
  }

  async listPendingForAgent(agentId: string): Promise<IContractStatusRequest[]> {
    return await ContractStatusRequestModel.find({ agent_id: agentId, state: 'pending' }).sort({
      created_at: -1,
    });
  }

  /**
   * Compare-and-set the resolution. Filtered on `state: 'pending'` so two
   * simultaneous decisions produce one resolution and one visible conflict.
   */
  async resolve(
    requestId: string,
    state: Exclude<StatusRequestState, 'pending'>,
    actor: { userId: string | null; role: string },
    note: string | null,
    session?: ClientSession,
    autoApproved = false
  ): Promise<IContractStatusRequest | null> {
    return await ContractStatusRequestModel.findOneAndUpdate(
      { _id: requestId, state: 'pending' },
      {
        $set: {
          state,
          resolved_by_role: actor.role as ContractParty,
          resolved_by_user_id: actor.userId,
          resolved_at: new Date(),
          resolution_note: note,
          auto_approved: autoApproved,
        },
      },
      { new: true, session }
    );
  }

  /** Refresh why a pending deactivation still cannot proceed. */
  async setBlockingConditions(
    requestId: string,
    conditions: Record<string, unknown> | null,
    session?: ClientSession
  ): Promise<IContractStatusRequest | null> {
    return await ContractStatusRequestModel.findByIdAndUpdate(
      requestId,
      { $set: { blocking_conditions: conditions } },
      { new: true, session }
    );
  }
}

export const contractStatusRequestRepository = new ContractStatusRequestRepository();
