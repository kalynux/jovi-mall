import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { ActorRef, actorStamp } from '../../../core/types/actor-source.types';
import { AgencyRemittanceModel, IAgencyRemittance, AgencyRemittanceStatus } from '../models/agency-remittance.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodSettlementService, FifoSettlementResult, codSettlementService } from './cod-settlement.service';
import { CodCashProofFileInput, CodCashProofService, codCashProofService } from './cod-cash-proof.service';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

/**
 * AgencyRemittanceService - the Agency → Platform leg of the cash chain.
 *
 * The agency DECLARES a remittance (with a required proof image and an optional
 * external transfer reference);
 * an admin CONFIRMS receipt, which — in one transaction — lowers the agency's
 * cash liability and FIFO-settles its collected CashCollections (unlocking the
 * escrow release of the earnings that cash backs). Rejection changes nothing.
 */
export class AgencyRemittanceService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly settlement: CodSettlementService = codSettlementService,
    private readonly proofs: CodCashProofService = codCashProofService
  ) {}

  /**
   * ⚠ The proof image is REQUIRED and the reference is not — the administrator confirming
   * this compares the platform's own account against the photo of the transfer. It is
   * uploaded only after the liability check passes, so a refused declaration leaves no file.
   */
  async declare(params: {
    agencyId: string;
    amount: number;
    reference?: string | null;
    note?: string | null;
    proof: CodCashProofFileInput;
    declaredByUserId: string;
  }): Promise<IAgencyRemittance> {
    const { agencyId, amount, note, proof, declaredByUserId } = params;
    const reference = params.reference?.trim() || null;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_INVALID_AMOUNT, 422, undefined, { amount });
    }

    // Can't declare more than the agency actually owes — the declared amounts
    // of still-open declarations count against the same liability.
    const { balance, currency } = await this.cashAccounts.getBalance('agency', agencyId);
    const pendingDeclared = await this.sumDeclared(agencyId);
    if (amount + pendingDeclared > balance) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_EXCEEDS_LIABILITY, 422, undefined, {
        amount,
        pendingDeclared,
        outstanding: balance,
      });
    }

    const owner = { type: 'agency' as const, id: agencyId };
    const proofFileId = await this.proofs.store(proof, owner, declaredByUserId);

    let remittance: IAgencyRemittance | null = null;
    try {
      await transactionManager.runInTransaction(async (session) => {
        const [created] = await AgencyRemittanceModel.create(
          [
            {
              agency_id: agencyId,
              amount,
              currency,
              reference,
              note: note ?? null,
              proof_file_id: proofFileId,
              status: 'declared',
              declared_by_user_id: declaredByUserId,
              declared_at: new Date(),
            },
          ],
          { session }
        );
        await this.proofs.attach(proofFileId, owner, 'agency_remittance', created._id.toString(), session);
        remittance = created;
      });
    } catch (error) {
      await this.proofs.discard(proofFileId);
      throw error;
    }
    const declared = remittance as unknown as IAgencyRemittance;

    try {
      await eventBus.publish('cod.remittance.declared', {
        eventType: 'cod.remittance.declared',
        aggregateId: declared._id.toString(),
        occurredAt: new Date(),
        payload: { remittanceId: declared._id.toString(), agencyId, amount, currency, reference },
      });
    } catch (error) {
      console.error('[AgencyRemittanceService] Failed to emit cod.remittance.declared:', error);
    }

    return declared;
  }

  /**
   * The proof image's BYTES for the agency that declared it. 404 for another agency's
   * remittance, never 403. Administrators read it through
   * `GET /api/internal/admin/files/:id/content`.
   */
  async streamProofForAgency(agencyId: string, remittanceId: string) {
    const remittance = Types.ObjectId.isValid(remittanceId)
      ? await AgencyRemittanceModel.findById(remittanceId)
      : null;
    if (!remittance || remittance.agency_id.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_NOT_FOUND, 404);
    }
    return this.proofs.stream(remittance.proof_file_id?.toString());
  }

  /**
   * Admin confirms the platform received the cash. ONE transaction: remittance
   * resolved, agency liability debited (+ledger), FIFO settlement applied.
   */
  async confirm(remittanceId: string, actor: ActorRef) {
    const remittance = await AgencyRemittanceModel.findById(remittanceId);
    if (!remittance) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_NOT_FOUND, 404);
    }

    let settledCollectionIds: string[] = [];
    let settlement: FifoSettlementResult | null = null;
    await transactionManager.runInTransaction(async (session) => {
      // Atomic claim: only a still-'declared' remittance can be confirmed.
      const claimed = await AgencyRemittanceModel.findOneAndUpdate(
        { _id: remittanceId, status: 'declared' },
        {
          $set: {
            status: 'confirmed',
            resolved_at: new Date(),
            // Three fields written together — the id, which identity space it belongs to,
            // and a name snapshot for the admin case that cannot be looked up from here.
            ...actorStamp('resolved_by', actor),
          },
        },
        { new: true, session }
      );
      if (!claimed) {
        throw createAppError(ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED, 409);
      }

      await this.cashAccounts.debitInSession(
        'agency',
        claimed.agency_id.toString(),
        claimed.amount,
        'remittance',
        'agency_remittance',
        claimed._id.toString(),
        session
      );

      const result = await this.settlement.applyFifoInSession(
        claimed.agency_id.toString(),
        claimed.amount,
        session
      );
      settledCollectionIds = result.settledCollectionIds;
      settlement = result;
    });

    // Committed: the platform holds this cash. Tell the refund side which collections it
    // covered (§ 11.4) — after the commit, never inside it.
    this.settlement.publishCollectionsSettled(settlement, remittanceId);

    try {
      await eventBus.publish('cod.remittance.confirmed', {
        eventType: 'cod.remittance.confirmed',
        aggregateId: remittanceId,
        occurredAt: new Date(),
        payload: {
          remittanceId,
          agencyId: remittance.agency_id.toString(),
          amount: remittance.amount,
          settledCollectionIds,
        },
      });
    } catch (error) {
      console.error('[AgencyRemittanceService] Failed to emit cod.remittance.confirmed:', error);
    }

    const confirmed = (await AgencyRemittanceModel.findById(remittanceId))!;
    return { remittance: this.toDto(confirmed, await this.proofOf(confirmed)), settledCollectionIds };
  }

  /** Admin rejects the declaration (nothing arrived / mismatch). No money moves. */
  async reject(remittanceId: string, actor: ActorRef, reason: string) {
    const rejected = await AgencyRemittanceModel.findOneAndUpdate(
      { _id: remittanceId, status: 'declared' },
      {
        $set: {
          status: 'rejected',
          resolved_at: new Date(),
          ...actorStamp('resolved_by', actor),
          rejection_reason: reason,
        },
      },
      { new: true }
    );
    if (!rejected) {
      const exists = await AgencyRemittanceModel.exists({ _id: remittanceId });
      throw createAppError(
        exists ? ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED : ERROR_CODES.COD_REMITTANCE_NOT_FOUND,
        exists ? 409 : 404
      );
    }
    return this.toDto(rejected, await this.proofOf(rejected));
  }


  /**
   * Record a reviewer's endorsement that this declared remittance looks genuine.
   *
   * ⚠ **Moves nothing and gates nothing.** A declaration holds no money — only a CONFIRMED
   * remittance moves cash — so unlike a payout endorsement there is not even a hold involved
   * here. Confirming never requires an endorsement, and an un-endorsed remittance is exactly as
   * confirmable as an endorsed one.
   *
   * Guarded on `status: 'declared'` AND `triage: null`: a remittance already reviewed or
   * already resolved is not re-reviewable, and a second endorsement would overwrite the
   * first reviewer's name on a record whose whole purpose is to say who vouched for it.
   *
   * ⚠ A triage REJECTION is not here — it is the ordinary `reject()` above. Rejection is
   * terminal on this record, and terminal outcomes are statuses.
   */
  async triage(remittanceId: string, actor: ActorRef, note: string | null) {
    const endorsed = await AgencyRemittanceModel.findOneAndUpdate(
      { _id: remittanceId, status: 'declared', triage: null },
      {
        $set: {
          triage: {
            verdict: 'endorsed',
            note,
            by_admin_id: actor.userId,
            by_name: actor.name ?? null,
            at: new Date(),
          },
        },
      },
      { new: true }
    );
    if (!endorsed) {
      const exists = await AgencyRemittanceModel.exists({ _id: remittanceId });
      throw createAppError(
        exists ? ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED : ERROR_CODES.COD_REMITTANCE_NOT_FOUND,
        exists ? 409 : 404
      );
    }
    return this.toAdminDto(endorsed, await this.proofOf(endorsed));
  }

  async listForAgency(agencyId: string, page: number, limit: number, status?: AgencyRemittanceStatus) {
    const filter: Record<string, unknown> = { agency_id: agencyId };
    if (status) filter.status = status;
    return this.paginate(filter, page, limit);
  }

  async listForAdmin(page: number, limit: number, status?: AgencyRemittanceStatus, agencyId?: string) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (agencyId) filter.agency_id = agencyId;
    // `forAdmin` — the endorsement is admin-to-admin commentary. See `toAdminDto`.
    return this.paginate(filter, page, limit, true);
  }

  /** Sum of this agency's still-open ('declared') remittance declarations. */
  private async sumDeclared(agencyId: string): Promise<number> {
    const [result] = await AgencyRemittanceModel.aggregate([
      { $match: { agency_id: new Types.ObjectId(agencyId), status: 'declared' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  private async paginate(
    filter: Record<string, unknown>,
    page: number,
    limit: number,
    forAdmin = false
  ) {
    const [total, docs] = await Promise.all([
      AgencyRemittanceModel.countDocuments(filter).exec(),
      AgencyRemittanceModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    const proofs = await this.proofs.resolveMany(docs.map((r) => r.proof_file_id?.toString()));
    return {
      data: docs.map((r) => {
        const proof = (r.proof_file_id && proofs.get(r.proof_file_id.toString())) || null;
        return forAdmin ? this.toAdminDto(r, proof) : this.toDto(r, proof);
      }),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

/**
   * The admin view of a remittance — everything in `toDto` plus the reviewer's endorsement.
   *
   * ⛔ **`triage` is deliberately NOT in `toDto`, and must not be moved there.** That shape is
   * served to the AGENCY and the AGENT as well, and the endorsement carries an internal review
   * note ("checked against the deposit slip", "agent has three open discrepancies") written by
   * one administrator for the next. It is commentary about the counterparty, and the
   * counterparty is not its audience.
   *
   * The payout surface draws the same line in the same place: `toAdminPayoutRequestDto` carries
   * triage and the owner-facing read does not.
   */
  private toAdminDto(remittance: IAgencyRemittance, proof: FileDetail | null) {
    return {
      ...this.toDto(remittance, proof),
      triage: remittance.triage
        ? {
            verdict: remittance.triage.verdict,
            note: remittance.triage.note ?? null,
            by: { id: remittance.triage.by_admin_id ?? null, name: remittance.triage.by_name ?? null },
            at: remittance.triage.at,
          }
        : null,
    };
  }

  private async proofOf(remittance: IAgencyRemittance): Promise<FileDetail | null> {
    return this.proofs.resolve(remittance.proof_file_id?.toString());
  }

  /**
   * `proof` is a `FileDetail` whose `url` is null (private tree) — the agency reads the bytes
   * at `GET /api/agency/cod/remittances/:id/proof/file`. Null only on legacy rows.
   */
  private toDto(remittance: IAgencyRemittance, proof: FileDetail | null) {
    return {
      id: remittance._id.toString(),
      agencyId: remittance.agency_id.toString(),
      amount: remittance.amount,
      currency: remittance.currency,
      reference: remittance.reference ?? null,
      proof,
      note: remittance.note,
      status: remittance.status,
      declaredAt: remittance.declared_at,
      resolvedAt: remittance.resolved_at,
      rejectionReason: remittance.rejection_reason,
    };
  }
}

export const agencyRemittanceService = new AgencyRemittanceService();
