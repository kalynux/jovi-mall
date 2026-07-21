import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionRepository } from '../repositories/cash-collection.repository';
import { CashCollectionModel, ICashCollection } from '../models/cash-collection.model';
import { DeliveryCodeService, deliveryCodeService } from './delivery-code.service';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../agents/repositories/agent-contract.repository';
import { agentCapacityService } from '../../agents/domain/services/agent-capacity.service';
import { earningsSplitService } from '../../earnings/services/earnings-split.service';
import { IOrder, OrderModel, PaymentStatus } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
import {
  OrderFulfillmentAggregationService,
  orderFulfillmentAggregationService,
} from '../../orders/domain/services/OrderFulfillmentAggregationService';
import { OrderCompletionService, orderCompletionService } from '../../orders/order-completion.service';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { ShipmentRepository } from '../../shipments/shipment.repository';
import { CustomerModel } from '../../customers/customer.model';
import { resolveLanguage } from '../../notifications/catalog/notification-i18n';

export interface CollectInput {
  code: string;
  location?: { lat: number; lng: number } | null;
  deviceInfo?: string | null;
  ip?: string | null;
}

/**
 * Shipment states from which a COD collection may be recorded. The parcel must
 * be out with the agent; anything earlier has no cash to collect, and anything
 * later already has.
 */
const COLLECTIBLE_SHIPMENT_STATUSES: readonly string[] = ['picked_up', 'in_transit', 'agent_delivered'];

/**
 * CashCollectionService - the COD "payment gateway": the delivery agent is the
 * collector, and the customer's delivery code is the authorization.
 *
 * Lifecycle of one COD shipment's cash:
 *  - agent assigned → a pending CashCollection is created (expected amount +
 *    hashed delivery code snapshot) inside the SAME transaction as the
 *    assignment; the code goes to the customer post-commit (WhatsApp + in-app),
 *    so they are holding it long before anyone reaches the door.
 *  - agent submits the code at handoff → ONE transaction: collection claimed
 *    `collected` (with GPS/device evidence), shipment `delivered`, order items
 *    mirrored, fulfillment recomputed, the order's COD payment status
 *    recomputed (partially_paid/paid), and cash liabilities raised (M4).
 *  - no code after the dispute window → `autoCollectWithoutCode` does all of the
 *    above minus the evidence, on the strength of the agent having left the
 *    shipment at `agent_delivered` rather than returning it.
 *  - shipment `returned` → the pending collection is cancelled and the order's
 *    COD payment status recomputed (all returned + nothing collected → failed).
 *
 * The invariant every one of those paths keeps, and which nothing else may
 * break: for COD, `delivered` ⟺ cash collected. `recomputeCodPaymentStatus`
 * derives the order's payment status from exactly that equivalence.
 */
export class CashCollectionService {
  constructor(
    private readonly collectionRepo: CashCollectionRepository = new CashCollectionRepository(),
    private readonly codes: DeliveryCodeService = deliveryCodeService,
    private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository(),
    private readonly orderRepo: OrderRepository = new OrderRepository(),
    private readonly timelineRepo: OrderTimelineRepository = new OrderTimelineRepository(),
    private readonly aggregationService: OrderFulfillmentAggregationService = orderFulfillmentAggregationService,
    private readonly completionService: OrderCompletionService = orderCompletionService,
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly contracts: AgentContractRepository = agentContractRepository
  ) {}

  // ─── Creation (at agent assignment) ─────────────────────────────────────────

  /**
   * Ensure a COD shipment has its pending cash collection, pointing at the agent
   * currently assigned to it. Runs inside the caller's transaction.
   *
   * Called at AGENT ASSIGNMENT, so the customer gets their delivery code as soon
   * as someone is dispatched rather than at pickup — by the time the agent is at
   * the door the customer has long had it and can read it straight out. It is
   * also called again at pickup as a safety net: the invariant that a picked-up
   * COD shipment always has a collection predates the assignment hook and must
   * survive shipments assigned before it existed.
   *
   * Idempotent, and both halves of that matter:
   *  - Already exists → returns `code: null`. The customer keeps the code they
   *    have. Re-issuing on every reassignment would invalidate a code the
   *    customer may already be holding, and train them to expect a fresh one
   *    that is not coming.
   *  - Agent swapped → the PENDING collection is re-pointed at the new agent.
   *    Skip this and the cash lands on the previous agent's balance at collect
   *    (`creditCashLiabilitiesInSession` credits `collection.agent_id`), leaving
   *    one agent holding cash they never took and another accountable for none.
   */
  async ensureForShipmentInSession(
    order: IOrder,
    shipment: IShipment,
    session: ClientSession
  ): Promise<{ collection: ICashCollection; code: string | null }> {
    if (!shipment.agent_id) {
      throw createAppError(ERROR_CODES.COD_AGENT_NOT_ASSIGNED, 422, 'A COD shipment needs an assigned agent before its delivery code can be issued');
    }
    const shipmentId = shipment._id.toString();
    const agentId = shipment.agent_id.toString();

    const existing = await this.collectionRepo.findByShipmentId(shipmentId, session);
    if (existing) {
      if (existing.status === 'pending' && existing.agent_id?.toString() !== agentId) {
        const repointed = await this.collectionRepo.reassignPendingAgent(shipmentId, agentId, session);
        return { collection: repointed ?? existing, code: null };
      }
      return { collection: existing, code: null };
    }

    const expectedAmount = this.computeExpectedAmount(order, shipment);
    const code = this.codes.generateCode();

    const collection = await this.collectionRepo.create(
      {
        order_id: order._id as any,
        shipment_id: shipment._id as any,
        agency_id: shipment.agency_id,
        agent_id: shipment.agent_id,
        customer_id: order.customer_id,
        vendor_id: order.vendor_id,
        expected_amount: expectedAmount,
        currency: order.currency,
        status: 'pending',
        code_hash: this.codes.hashCode(code),
        code_plain: code,
        code_generated_at: new Date(),
        code_attempts: 0,
        code_locked: false,
      },
      session
    );

    return { collection, code };
  }

  /**
   * Re-open a RETURNED COD shipment's cancelled collection for re-delivery — used
   * when the shipment is reassigned agent → agent out of `returned`. Returning
   * the shipment cancelled its delivery code (`cancelPendingByShipment`) and drove
   * the order's COD payment status to a terminal `failed`; both must be undone or
   * the replacement can never record the cash and reach `delivered`.
   *
   * This mints a FRESH code (a new secret for the customer, since the old one was
   * voided) on the revived collection, and clears the terminal `failed` payment
   * status back to `pending` so a fresh collection can move the order forward. The
   * replacement agent is re-pointed onto the pending collection when they accept
   * (`ensureForShipmentInSession` → `reassignPendingAgent`), so no second code is
   * issued there.
   *
   * A no-op (returns `code: null`) for a non-COD order, or when there is no
   * cancelled collection to revive (e.g. reassignment out of `failed`, whose code
   * was never cancelled). Runs inside the reassignment transaction.
   */
  async reopenForRedeliveryInSession(
    order: IOrder,
    shipment: IShipment,
    session: ClientSession
  ): Promise<{ collection: ICashCollection; code: string } | { collection: null; code: null }> {
    if (order.payment_method !== 'cash_on_delivery') return { collection: null, code: null };

    const shipmentId = (shipment._id as any).toString();
    const existing = await this.collectionRepo.findByShipmentId(shipmentId, session);
    if (!existing || existing.status !== 'cancelled') return { collection: null, code: null };

    const code = this.codes.generateCode();
    const revived = await this.collectionRepo.reopenCancelledForRedelivery(
      shipmentId,
      { code_hash: this.codes.hashCode(code), code_plain: code, code_generated_at: new Date() },
      session
    );
    if (!revived) return { collection: null, code: null };

    // Clear the terminal payment status the return produced. Only `failed` is
    // touched — `paid`/`refunded` mean the money question is genuinely closed and
    // must never be re-opened by a redelivery.
    if (order.payment_status === 'failed') {
      await OrderModel.updateOne(
        { _id: order._id, payment_status: 'failed' },
        { $set: { payment_status: 'pending' } },
        { session }
      );
    }

    return { collection: revived, code };
  }

  /** Best-effort post-commit customer notification of a (re)issued code. */
  async notifyCodeIssued(order: IOrder, collection: ICashCollection, code: string): Promise<void> {
    try {
      const customer: any = await CustomerModel.findById(order.customer_id)
        .select('phone preferences.language')
        .lean()
        .exec();
      await this.codes.sendToCustomer({
        customerPhone: customer?.phone ?? null,
        code,
        orderNumber: order.order_number,
        expectedAmount: collection.expected_amount,
        currency: collection.currency,
        language: resolveLanguage(customer),
        dedupeKey: `${collection._id.toString()}:${collection.code_generated_at.getTime()}`,
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to notify customer of delivery code:', error);
    }
  }

  // ─── Collection (the handoff) ───────────────────────────────────────────────

  /**
   * Agent submits the customer's delivery code: verify, then atomically record
   * the cash and deliver the shipment. The only path by which a COD shipment
   * reaches 'delivered' with the customer's own evidence behind it — the one
   * other route, `autoCollectWithoutCode`, records the same cash on nothing but
   * the elapsed dispute window.
   *
   * `agent_delivered` is the expected state here — the agent signals arrival,
   * is told to ask for the code, and submits it. `picked_up`/`in_transit` stay
   * collectible too: the code is the thing that proves the handoff, and an agent
   * who collects without first announcing arrival has still collected.
   */
  async collect(agentId: string, agentUserId: string, shipmentId: string, input: CollectInput) {
    // 1. Scope: the shipment must be assigned to THIS agent (404 — never leak).
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.agent_id?.toString() !== agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    if (!COLLECTIBLE_SHIPMENT_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE, 422, undefined, {
        shipmentStatus: shipment.status,
      });
    }

    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection) {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404);
    }
    if (collection.status === 'collected') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_ALREADY_COLLECTED, 409);
    }
    if (collection.status !== 'pending') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE, 422, undefined, {
        collectionStatus: collection.status,
      });
    }
    if (collection.code_locked) {
      throw createAppError(ERROR_CODES.COD_CODE_ATTEMPTS_EXCEEDED, 423, 'Too many wrong codes — resend a new code to the customer');
    }

    // 2. Verify the code. Failed attempts persist OUTSIDE the transaction so a
    //    brute-force can't be reset by aborting.
    if (!this.codes.verifyCode(input.code, collection.code_hash)) {
      const updated = await this.collectionRepo.recordFailedAttempt(
        collection._id as Types.ObjectId,
        COD_CONFIG.OTP_MAX_ATTEMPTS
      );
      if (updated?.code_locked) {
        throw createAppError(ERROR_CODES.COD_CODE_ATTEMPTS_EXCEEDED, 423, 'Too many wrong codes — resend a new code to the customer');
      }
      throw createAppError(ERROR_CODES.COD_INVALID_CODE, 422, undefined, {
        attemptsRemaining: COD_CONFIG.OTP_MAX_ATTEMPTS - (updated?.code_attempts ?? 0),
      });
    }

    const orderId = shipment.order_id.toString();

    // 3. THE COD SETTLEMENT MOMENT — everything in one transaction.
    let claimed: ICashCollection | null = null;
    await transactionManager.runInTransaction(async (session) => {
      claimed = await this.collectionRepo.claimCollected(
        collection._id as Types.ObjectId,
        {
          method: 'code',
          location: input.location ?? null,
          device_info: input.deviceInfo ?? null,
          ip: input.ip ?? null,
        },
        session
      );
      if (!claimed) {
        // Concurrent submission won the claim.
        throw createAppError(ERROR_CODES.COD_COLLECTION_ALREADY_COLLECTED, 409);
      }

      // Deliver the shipment: the verified code IS the customer confirmation.
      await this.shipmentRepo.applyStatusChange(
        shipmentId,
        'delivered',
        { userId: agentUserId, role: 'agent' },
        session
      );
      await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, 'delivered', session);
      await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
      await this.recomputeCodPaymentStatusInSession(orderId, session);

      await this.creditCashLiabilitiesInSession(claimed, session);
    });

    // 4. Post-commit side effects (each best-effort, all idempotent).
    const refreshedOrder = await OrderModel.findById(orderId);
    if (
      refreshedOrder &&
      refreshedOrder.fulfillment_status === 'delivered' &&
      !refreshedOrder.completion?.confirmed_at
    ) {
      // The customer released the code at handoff — that's their confirmation.
      await this.completionService.complete(refreshedOrder, 'customer', false, agentUserId);
    }

    if (refreshedOrder) {
      await this.emitPostCollectionEvents(refreshedOrder, claimed!, agentId);
      await this.splitEarnings(refreshedOrder, claimed!);
    }

    // Delivered → the shipment left the agent's active set; free the capacity
    // slot they reserved on acceptance. Best-effort (release never throws; the
    // nightly reconcile is the backstop).
    void agentCapacityService
      .release(agentId, 'delivered')
      .catch((err) => console.error('[CashCollectionService] capacity release failed:', err));

    return this.toDto(claimed!, refreshedOrder?.payment_status ?? null);
  }

  // ─── Auto-collection (the dispute window elapsed, no code ever came) ────────

  /**
   * Record a COD collection WITHOUT code verification, attributed to the system,
   * because the shipment sat at `agent_delivered` past the dispute window.
   * Called only by `ShipmentService.autoConfirmStaleDeliveries`.
   *
   * ── Why this exists ──────────────────────────────────────────────────────
   *
   * A customer can pay cash and still never produce the code — phone not to
   * hand, or simply unwilling. The agent's duty is the other half: an agent who
   * was NOT paid must move the shipment to `failed` → `returned`. Leaving it at
   * `agent_delivered` for the whole window is therefore an implicit assertion
   * that the cash WAS collected, and this records that assertion.
   *
   * ── Why it goes THROUGH the collection rather than around it ──────────────
   *
   * The tempting shortcut — flip the shipment to `delivered` and skip the
   * collection — does NOT wrongly release money (COD allocations carry
   * `requires_cash_settlement`, so they wait for cash the platform physically
   * holds). It fails far more quietly: `splitCodCollection` only ever runs off a
   * collection, so there would be no allocations at all and NOBODY — not even
   * the vendor — would earn from the delivery; the collection would sit
   * `pending` forever, invisible to `recoverMissedCodSplits`, which only looks
   * at `collected`; and `recomputeCodPaymentStatusInSession` would never run, so
   * a delivered, completed order would keep a payment status that is a lie.
   * Going through the collection keeps every one of those mechanisms intact.
   *
   * ── The liability, deliberately, lands on the AGENT ───────────────────────
   *
   * `creditCashLiabilitiesInSession` credits `collection.agent_id`, exactly as a
   * coded collection would. That is the intent: the agent claimed delivery and
   * had the full window to mark it returned if unpaid. Non-payment is then the
   * existing deposit-deadline worker's job — it opens a `late_deposit`
   * discrepancy and applies the trust penalty once the agent sits on the cash
   * past `DEPOSIT_DEADLINE_DAYS`. This path deliberately raises no discrepancy
   * and costs no trust of its own: at this moment nothing has actually gone
   * wrong, an open discrepancy would block the AGENCY's rolling-reserve releases
   * for a customer who merely would not read out a code, and whether the
   * customer cooperates is not something the agent controls.
   *
   * No exposure check, matching `collect()`: the limit is admission control at
   * assignment, and refusing to record cash that physically exists would only
   * make the books wrong.
   *
   * Returns true when a collection was recorded, false when there was nothing
   * to do (the agent's code landed first, or there is no collection at all).
   */
  async autoCollectWithoutCode(shipment: IShipment): Promise<boolean> {
    const shipmentId = shipment._id.toString();
    const orderId = shipment.order_id.toString();

    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection) {
      // A COD shipment that reached `agent_delivered` with no collection means
      // the assignment hook never ran. Auto-collecting is impossible (there is
      // no expected amount to record), and confirming without one would create
      // exactly the ledger hole this path exists to prevent — so leave it for a
      // human and say so loudly.
      console.error(
        `[CashCollectionService] COD shipment ${shipmentId} is stale at agent_delivered with no ` +
          `cash collection; cannot auto-collect. It will not confirm until one exists.`
      );
      return false;
    }
    if (collection.status !== 'pending') return false;

    let claimed: ICashCollection | null = null;
    await transactionManager.runInTransaction(async (session) => {
      // Claim the cash first — guarded on `pending`, this is the double-collect
      // guard, and it is the same order `collect()` takes its writes in. Null
      // means the agent submitted the code while the sweep was running: they
      // win, and their collection carries real evidence where ours would not.
      const claim = await this.collectionRepo.claimCollected(
        collection._id as Types.ObjectId,
        { method: 'auto_no_code', location: null, device_info: null, ip: null },
        session
      );
      if (!claim) return;

      // Guarded on `agent_delivered`, and that guard is load-bearing: the agency
      // may have moved the shipment to `failed` since the sweep read it, and a
      // failed delivery must never be auto-collected. Throwing rolls the claim
      // above back rather than recording cash against a shipment coming home.
      const delivered = await this.shipmentRepo.applyCustomerConfirmation(
        shipmentId,
        null,
        true,
        session
      );
      if (!delivered) {
        throw createAppError(
          ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE,
          409,
          'Shipment left agent_delivered while its auto-collection was in flight',
          { shipmentId }
        );
      }

      await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, 'delivered', session);
      await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
      await this.recomputeCodPaymentStatusInSession(orderId, session);
      await this.creditCashLiabilitiesInSession(claim, session);

      claimed = claim;
    });

    if (!claimed) return false;

    // Post-commit side effects — identical to `collect()`'s, because the
    // downstream money mechanics must not be able to tell the two apart.
    const refreshedOrder = await OrderModel.findById(orderId);
    if (
      refreshedOrder &&
      !refreshedOrder.completion?.confirmed_at &&
      this.completionService.isSettled(refreshedOrder)
    ) {
      // 'system'/auto, never 'customer': nobody confirmed anything here.
      await this.completionService.complete(refreshedOrder, 'system', true, null);
    }

    const claimedAgentId = (claimed as ICashCollection).agent_id.toString();
    if (refreshedOrder) {
      await this.emitPostCollectionEvents(refreshedOrder, claimed, claimedAgentId, true);
      await this.splitEarnings(refreshedOrder, claimed);
    }

    // Delivered → free the agent's capacity slot (best-effort; see collect()).
    void agentCapacityService
      .release(claimedAgentId, 'delivered')
      .catch((err) => console.error('[CashCollectionService] capacity release failed:', err));

    return true;
  }

  /**
   * Split this collection into held earnings (vendor net, platform commission,
   * agency delivery + COD handling fee), all gated on cash settlement.
   * Idempotent and best-effort — a failure never breaks the collection; the
   * daily earnings sweep re-splits collections left without allocations.
   */
  protected async splitEarnings(order: IOrder, collection: ICashCollection): Promise<void> {
    try {
      await earningsSplitService.splitCodCollection(order, collection);
    } catch (error) {
      console.error('[CashCollectionService] Failed to split COD earnings (sweep will retry):', error);
    }
  }

  /**
   * Raise both cash liabilities for a collection, INSIDE the collect
   * transaction: the agent now physically holds the cash (owes the agency),
   * and the agency chain is accountable to the platform for it.
   *
   * Runs identically for a coded and an auto (uncoded) collection. That is
   * deliberate — the agent is accountable for the cash either way, and the
   * deposit-deadline worker can only chase what has been credited here.
   */
  protected async creditCashLiabilitiesInSession(
    collection: ICashCollection,
    session: ClientSession
  ): Promise<void> {
    const refId = collection._id.toString();
    await this.cashAccounts.creditInSession(
      'agent',
      collection.agent_id.toString(),
      collection.expected_amount,
      collection.currency,
      'collection',
      'cash_collection',
      refId,
      session
    );
    await this.cashAccounts.creditInSession(
      'agency',
      collection.agency_id.toString(),
      collection.expected_amount,
      collection.currency,
      'collection',
      'cash_collection',
      refId,
      session
    );
    await this.attributeToContractInSession(collection, session);
  }

  /**
   * Attribute collected cash to the contract it was earned under.
   *
   * The agent's CodCashAccount is ONE pot across every agency; this is the
   * per-agency share of it. The split is what lets §4 ask "may this contract
   * end?" without the answer being polluted by cash the agent owes someone
   * else, and it is the counter a settlement later draws down.
   *
   * `findLive`, not `findActive`: suspending or pausing a contract deliberately
   * leaves the agent's existing shipments alone, so cash can legitimately land
   * under a contract that is no longer taking new work. Refusing to attribute it
   * would lose the very balance that blocks that contract from being terminated
   * with the agency's money still in the agent's pocket.
   *
   * A missing contract does NOT fail the collection. This runs inside the
   * transaction by which a COD shipment reaches `delivered`, and a bookkeeping
   * gap must never strand a physical handover that already happened — the cash
   * is still recorded against the agent and the agency above. It is logged
   * because it means a contract was terminated with a shipment still in flight,
   * which is a lifecycle bug worth chasing, not a routine event.
   */
  private async attributeToContractInSession(
    collection: ICashCollection,
    session: ClientSession
  ): Promise<void> {
    const agentId = collection.agent_id.toString();
    const agencyId = collection.agency_id.toString();

    const contract = await this.contracts.findLive(agentId, agencyId, session);
    if (!contract) {
      console.error(
        `[CashCollectionService] No live contract for agent ${agentId} at agency ${agencyId}; ` +
          `collection ${collection._id.toString()} (${collection.expected_amount}) is unattributed. ` +
          `The cash is recorded against the agent and the agency, but this contract's ` +
          `outstanding balance will understate what the agent holds.`
      );
      return;
    }

    await this.contracts.adjustOutstandingBalance(
      contract._id.toString(),
      collection.expected_amount,
      session
    );
  }

  // ─── Code resend ─────────────────────────────────────────────────────────────

  /** Agent asks for a fresh code to be sent to the customer (locked/lost code). */
  async resendCodeAsAgent(agentId: string, shipmentId: string) {
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.agent_id?.toString() !== agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    const { order, collection, code } = await this.regenerateCode(shipmentId);
    await this.notifyCodeIssued(order, collection, code);
    return { shipmentId, resentAt: new Date() };
  }

  /**
   * Customer re-requests their delivery code. Returns the code — it is the
   * customer's own secret.
   */
  async resendCodeAsCustomer(customerId: string, orderId: string, shipmentId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order || order.customer_id.toString() !== customerId) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.order_id.toString() !== orderId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    const { collection, code } = await this.regenerateCode(shipmentId, order);
    await this.notifyCodeIssued(order, collection, code);
    return { shipmentId, deliveryCode: code, expectedAmount: collection.expected_amount, currency: collection.currency };
  }

  private async regenerateCode(
    shipmentId: string,
    preloadedOrder?: IOrder
  ): Promise<{ order: IOrder; collection: ICashCollection; code: string }> {
    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection || collection.status !== 'pending') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404);
    }

    const secondsSinceIssue = (Date.now() - collection.code_generated_at.getTime()) / 1000;
    if (secondsSinceIssue < COD_CONFIG.OTP_RESEND_MIN_SECONDS) {
      throw createAppError(ERROR_CODES.COD_CODE_RESEND_TOO_SOON, 429, undefined, {
        retryInSeconds: Math.ceil(COD_CONFIG.OTP_RESEND_MIN_SECONDS - secondsSinceIssue),
      });
    }

    const order = preloadedOrder ?? (await OrderModel.findById(collection.order_id)) ?? null;
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }

    const code = this.codes.generateCode();
    const updated = await this.collectionRepo.replaceCode(
      collection._id as Types.ObjectId,
      this.codes.hashCode(code),
      code
    );

    return { order, collection: updated ?? collection, code };
  }

  // ─── Shipment-return handling ───────────────────────────────────────────────

  /**
   * A COD shipment ended `returned`: void its pending collection and recompute
   * the order's COD payment status. Runs inside the caller's transaction.
   */
  async handleShipmentReturnedInSession(
    shipmentId: string,
    orderId: string,
    session: ClientSession
  ): Promise<void> {
    await this.collectionRepo.cancelPendingByShipment(shipmentId, session);
    await this.recomputeCodPaymentStatusInSession(orderId, session);
  }

  // ─── Order payment-status recompute ─────────────────────────────────────────

  /**
   * Derive a COD order's payment status from its shipments + collections.
   * For COD, delivered ⟺ cash collected (the code path is the only way to
   * 'delivered'), so:
   *  - every shipment delivered                         → paid
   *  - some cash collected, anything else outstanding   → partially_paid
   *  - nothing collected, every shipment returned       → failed
   */
  async recomputeCodPaymentStatusInSession(orderId: string, session: ClientSession): Promise<void> {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.payment_method !== 'cash_on_delivery') return;
    // Terminal financial states never regress.
    if (order.payment_status === 'paid' || order.payment_status === 'refunded' || order.payment_status === 'failed') return;

    const shipments = await ShipmentModel.find({ order_id: orderId }).session(session);
    if (shipments.length === 0) return;

    const collections = await this.collectionRepo.findByOrderId(orderId, session);
    const collectedCount = collections.filter((c) => c.status === 'collected').length;

    const allDelivered = shipments.every((s) => s.status === 'delivered');
    const allSettledOrReturned = shipments.every(
      (s) => s.status === 'delivered' || s.status === 'returned'
    );

    let next: PaymentStatus = order.payment_status;
    if (allDelivered) {
      next = 'paid';
    } else if (collectedCount > 0) {
      next = 'partially_paid';
    } else if (allSettledOrReturned) {
      // No cash ever collected and every shipment came back.
      next = 'failed';
    }

    if (next !== order.payment_status) {
      await OrderModel.updateOne({ _id: orderId }, { $set: { payment_status: next } }, { session });
    }
  }

  // ─── Read views ─────────────────────────────────────────────────────────────

  /**
   * COD blocks for customer order views, keyed by orderId. Includes the
   * plaintext delivery code for still-pending collections when
   * `includeCode` — customer-scoped callers only.
   */
  async getCodBlocksForOrders(orderIds: string[], includeCode: boolean) {
    const collections = includeCode
      ? await this.collectionRepo.findByOrderIdsWithCode(orderIds)
      : await CashCollectionModel.find({ order_id: { $in: orderIds } });

    const byOrder = new Map<string, any[]>();
    for (const c of collections) {
      const key = c.order_id.toString();
      const list = byOrder.get(key) ?? [];
      list.push({
        shipmentId: c.shipment_id.toString(),
        expectedAmount: c.expected_amount,
        currency: c.currency,
        status: c.status,
        collectedAt: c.collected_at,
        ...(includeCode && c.status === 'pending' ? { deliveryCode: c.code_plain ?? null } : {}),
      });
      byOrder.set(key, list);
    }
    return byOrder;
  }

  /** Public COD summary of one shipment (agency/agent views — never the code). */
  async getCodSummaryForShipment(shipmentId: string) {
    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection) return null;
    return {
      expectedAmount: collection.expected_amount,
      currency: collection.currency,
      status: collection.status,
      collectedAt: collection.collected_at,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Expected cash for a shipment: Σ (order item price × shipment item qty).
   * Public: also used by the exposure gate at agent-assignment time, before
   * any collection exists.
   */
  computeExpectedAmount(order: IOrder, shipment: IShipment): number {
    const itemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    let total = 0;
    for (const si of shipment.items) {
      const orderItem = itemsById.get(si.order_item_id.toString());
      if (!orderItem) {
        throw createAppError(ERROR_CODES.ORDER_ITEM_NOT_FOUND, 500, 'Shipment references an unknown order item', {
          shipmentId: (shipment._id as any).toString(),
          orderItemId: si.order_item_id.toString(),
        });
      }
      total += orderItem.price * si.quantity;
    }
    // NOTE: order-level tax/discount are 0 today (see buildVendorOrder TODOs).
    // Once they exist they must be apportioned per shipment here.
    return total;
  }

  /**
   * `uncoded` marks an auto-collection recorded without a delivery code. It is
   * the audit trail for a collection nobody verified — deliberately carried here
   * rather than as a CodDiscrepancy, which would have blocked the agency's
   * reserve releases over a customer who simply would not read out their code.
   */
  private async emitPostCollectionEvents(
    order: IOrder,
    collection: ICashCollection,
    agentId: string,
    uncoded = false
  ) {
    // Timeline (audit trail on the order).
    try {
      await this.timelineRepo.appendEvent({
        orderId: order._id.toString(),
        eventType: 'payment.updated',
        description: uncoded
          ? `Cash recorded as collected without a delivery code after the confirmation window elapsed (${collection.expected_amount} ${collection.currency})`
          : `Cash collected on delivery (${collection.expected_amount} ${collection.currency})`,
        metadata: {
          codCollectionId: collection._id.toString(),
          shipmentId: collection.shipment_id.toString(),
          agentId,
          amount: collection.expected_amount,
          paymentStatus: order.payment_status,
          verificationMethod: uncoded ? 'auto_no_code' : 'code',
        },
        actorType: 'system',
        actorId: null,
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to append timeline event:', error);
    }

    // payment.received.* — same contract the gateway path emits, so vendor
    // notifications work unchanged for COD.
    try {
      const isFull = order.payment_status === 'paid';
      const eventType = isFull ? 'payment.received.full' : 'payment.received.partial';
      await eventBus.publish(eventType, {
        eventType,
        aggregateId: order._id.toString(),
        occurredAt: new Date(),
        payload: {
          vendorId: order.vendor_id.toString(),
          paymentId: collection._id.toString(),
          orderId: order._id.toString(),
          amount: collection.expected_amount,
          currency: collection.currency,
          totalAmount: order.total_amount,
          aggregateType: 'order',
        },
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to emit payment.received event:', error);
    }

    // COD domain event (no subscribers yet — future consumers/analytics).
    try {
      await eventBus.publish('cod.collection.recorded', {
        eventType: 'cod.collection.recorded',
        aggregateId: collection._id.toString(),
        occurredAt: new Date(),
        payload: {
          collectionId: collection._id.toString(),
          orderId: order._id.toString(),
          shipmentId: collection.shipment_id.toString(),
          agencyId: collection.agency_id.toString(),
          agentId,
          amount: collection.expected_amount,
          currency: collection.currency,
          verificationMethod: uncoded ? 'auto_no_code' : 'code',
        },
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to emit cod.collection.recorded:', error);
    }
  }

  private toDto(collection: ICashCollection, orderPaymentStatus: string | null) {
    return {
      collectionId: collection._id.toString(),
      shipmentId: collection.shipment_id.toString(),
      orderId: collection.order_id.toString(),
      amount: collection.expected_amount,
      currency: collection.currency,
      status: collection.status,
      collectedAt: collection.collected_at,
      orderPaymentStatus,
    };
  }
}

export const cashCollectionService = new CashCollectionService();
