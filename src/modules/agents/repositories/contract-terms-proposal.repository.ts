import { ClientSession } from 'mongoose';
import {
  ContractTermsProposalModel,
  IContractTermsProposal,
  TermsProposalState,
  ProposedTerms,
} from '../models/contract-terms-proposal.model';
import { ContractTermsParty } from '../models/agent-agency-membership.model';

export interface CreateTermsProposalInput {
  contractId: string;
  agentId: string;
  agencyId: string;
  proposedByRole: ContractTermsParty;
  proposedByUserId: string | null;
  termsBefore: ProposedTerms;
  proposedTerms: ProposedTerms;
  note: string | null;
  supersedesId?: string | null;
}

/** Persistence for proposed changes to a LIVE contract's negotiated terms. */
export class ContractTermsProposalRepository {
  async create(
    input: CreateTermsProposalInput,
    session?: ClientSession
  ): Promise<IContractTermsProposal> {
    const [proposal] = await ContractTermsProposalModel.create(
      [
        {
          contract_id: input.contractId,
          agent_id: input.agentId,
          agency_id: input.agencyId,
          proposed_by_role: input.proposedByRole,
          proposed_by_user_id: input.proposedByUserId,
          terms_before: input.termsBefore,
          proposed_terms: input.proposedTerms,
          state: 'pending',
          supersedes_id: input.supersedesId ?? null,
          note: input.note,
        },
      ],
      session ? { session } : {}
    );
    return proposal;
  }

  async findById(proposalId: string, session?: ClientSession): Promise<IContractTermsProposal | null> {
    return await ContractTermsProposalModel.findById(proposalId).session(session ?? null);
  }

  async findPendingForContract(
    contractId: string,
    session?: ClientSession
  ): Promise<IContractTermsProposal | null> {
    return await ContractTermsProposalModel.findOne({
      contract_id: contractId,
      state: 'pending',
    }).session(session ?? null);
  }

  /** One contract's full negotiation trail, newest first. */
  async listForContract(contractId: string): Promise<IContractTermsProposal[]> {
    return await ContractTermsProposalModel.find({ contract_id: contractId }).sort({ created_at: -1 });
  }

  async listPendingForAgency(agencyId: string): Promise<IContractTermsProposal[]> {
    return await ContractTermsProposalModel.find({ agency_id: agencyId, state: 'pending' }).sort({
      created_at: -1,
    });
  }

  async listPendingForAgent(agentId: string): Promise<IContractTermsProposal[]> {
    return await ContractTermsProposalModel.find({ agent_id: agentId, state: 'pending' }).sort({
      created_at: -1,
    });
  }

  /**
   * Compare-and-set the resolution, filtered on `state: 'pending'`.
   *
   * A null return is a CONFLICT, never a not-found: the caller has already
   * loaded the row, so the only way to miss here is that someone else resolved
   * it first. Callers must not re-read and retry — they must report the
   * conflict, or two parties both believe they decided.
   */
  async resolve(
    proposalId: string,
    state: Exclude<TermsProposalState, 'pending'>,
    resolvedBy: { role: ContractTermsParty; userId: string | null } | null,
    note: string | null,
    session?: ClientSession
  ): Promise<IContractTermsProposal | null> {
    return await ContractTermsProposalModel.findOneAndUpdate(
      { _id: proposalId, state: 'pending' },
      {
        $set: {
          state,
          resolved_by_role: resolvedBy?.role ?? null,
          resolved_by_user_id: resolvedBy?.userId ?? null,
          resolved_at: new Date(),
          resolution_note: note,
        },
      },
      { new: true, session }
    );
  }
}

export const contractTermsProposalRepository = new ContractTermsProposalRepository();
