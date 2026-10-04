import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { escapeRegex } from '../../../core/utils/regex.util';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { deliveryPayerOf } from '../../orders/domain/delivery-payer';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import {
    DeliveryFeeProposalModel,
    IDeliveryFeeProposal,
} from '../../delivery-fee-proposals/models/delivery-fee-proposal.model';
import { toCustomerDeliveryFeeProposalDto } from '../../delivery-fee-proposals/dto/delivery-fee-proposal.dto';
import { deliveryFeeProposalRepository } from '../../delivery-fee-proposals/repositories/delivery-fee-proposal.repository';
import { customerFeeApplicationService } from '../../delivery-fee-proposals/services/customer-fee-application.service';
import {
    checkCombinedRequest,
    COMBINED_REQUEST_MIN_SHIPMENTS,
    planCustomerApprovedIncrease,
} from '../../delivery-fee-proposals/domain/customer-fee-change.rules';
import { MAX_NON_WITHDRAWN_PROPOSALS } from '../../delivery-fee-proposals/domain/delivery-fee-proposal.rules';
import {
    CombinedDeliveryRequestModel,
    ICombinedDeliveryRequest,
} from '../../delivery-fee-proposals/models/combined-delivery-request.model';
import { toCombinedDeliveryRequestDto } from '../../delivery-fee-proposals/services/combined-delivery-request.service';
import { maskedPayerNumber } from '../miniapp/surfaces/checkout-payer';
import { formatBotPrice } from '../domain/product-card';
import type { BotFeeChangeView, FeeChangeAction } from '../domain/fee-change-chat-reply';

/**
 * The READ side of the chat's delivery-fee tools (ADR-A11 § Fee changes after checkout, W-H).
 *
 * ── IT DECIDES NOTHING ──────────────────────────────────────────────────────
 * Every write goes through `DeliveryFeeProposalService` / `CombinedDeliveryRequestService` (W-E),
 * exactly as the customer API calls them. What lives here is what the customer API never needed:
 *   - "which of my orders have a change waiting" — the API is per order, a chat is per person;
 *   - "what would I pay more" — the API leaves that to the screen; the chat must SAY it, so it is
 *     read from W-E's own plan (`planCustomerApprovedIncrease` over `stateOf`), never subtracted;
 *   - "which of my parcels could get a combined price" — the API makes the caller name an agency
 *     and parcels; a model that has to name them invents ids, so the eligible groups are resolved
 *     here, with W-E's own predicate (`checkCombinedRequest`), and handed over as data.
 *
 * ⚠ **The owner is checked on every read** — `customer_id` on the proposal, the order and the
 * request. Another customer's id reads exactly like one that does not exist (404).
 */

/** Orders whose parcels cannot move any more — nothing on them can carry a pending change. */
const CLOSED_FULFILMENT = ['delivered', 'fulfilled', 'cancelled', 'returned'];
/** How many open orders a "my delivery-fee changes" read looks at. A backstop, not a page. */
const OPEN_ORDERS_SCANNED = 100;

export interface BotCombinedGroup {
    cartId: string;
    agencyId: string;
    agencyName: string;
    currency: string;
    parcelCount: number;
    totalFee: number;
    totalFeeText: string;
    shipments: Array<{ shipmentId: string; orderId: string; orderNumber: string; fee: number; feeText: string }>;
    /** An open request already exists for this checkout and company — creating another is refused. */
    openRequestId: string | null;
}

export interface BotCombinedRequestProjection {
    id: string;
    cartId: string;
    agencyId: string;
    agencyName: string;
    status: string;
    currency: string;
    note: string | null;
    parcelCount: number;
    shipments: Array<{ shipmentId: string; orderId: string; orderNumber: string; feeAtRequest: number; feeAtRequestText: string }>;
    answer: {
        saving: number;
        savingText: string;
        note: string | null;
        answeredAt: Date;
        fees: Array<{ shipmentId: string; feeBefore: number; feeAfter: number; feeBeforeText: string; feeAfterText: string }>;
    } | null;
    declineNote: string | null;
    createdAt: Date;
    closedAt: Date | null;
}

export class BotDeliveryFeeService {
    constructor(
        private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
        private readonly magazins: MagazinRepository = new MagazinRepository(),
    ) {}

    // ── Pending changes ─────────────────────────────────────────────────────

    /**
     * Every change waiting on the customer — on one order (`orderRef`: id or order number) or on
     * every open one — newest first. Only changes with something to DO (`availableActions`).
     */
    async pendingViews(customerId: string, orderRef?: string | null): Promise<BotFeeChangeView[]> {
        const orders = orderRef
            ? [await this.ownedOrder(customerId, orderRef)]
            : await OrderModel.find({
                customer_id: new Types.ObjectId(customerId),
                fulfillment_status: { $nin: CLOSED_FULFILMENT },
            })
                .sort({ created_at: -1 })
                .limit(OPEN_ORDERS_SCANNED);
        if (orders.length === 0) return [];

        const proposals = await DeliveryFeeProposalModel.find({
            order_id: { $in: orders.map((o) => o._id) },
            customer_id: new Types.ObjectId(customerId),
            status: 'pending',
        }).sort({ created_at: -1 });

        const byId = new Map(orders.map((o) => [o._id.toString(), o]));
        const views: BotFeeChangeView[] = [];
        for (const proposal of proposals) {
            const order = byId.get(proposal.order_id.toString());
            if (!order) continue;
            const view = await this.buildView(proposal, order);
            if (view) views.push(view);
        }
        return views;
    }

    /**
     * One change, owned by this customer, as it stands NOW — or null when it no longer waits on
     * them (answered, withdrawn, applied). Throws 404 for an id that is not theirs.
     */
    async viewOf(customerId: string, proposalId: string): Promise<{ proposal: IDeliveryFeeProposal; order: IOrder; view: BotFeeChangeView | null }> {
        const proposal = await this.ownedProposal(customerId, proposalId);
        const order = await OrderModel.findOne({ _id: proposal.order_id, customer_id: new Types.ObjectId(customerId) });
        if (!order) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
        return { proposal, order, view: await this.buildView(proposal, order) };
    }

    /** The proposal, if it is this customer's; 404 otherwise (never 403 — see the header). */
    async ownedProposal(customerId: string, proposalId: string): Promise<IDeliveryFeeProposal> {
        const proposal = Types.ObjectId.isValid(proposalId) ? await deliveryFeeProposalRepository.findById(proposalId) : null;
        if (!proposal || !proposal.customer_id || proposal.customer_id.toString() !== customerId) {
            throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
        }
        return proposal;
    }

    /** The masked wallet a top-up would be charged to, or null when the account holds none. */
    async payerMasked(customerId: string): Promise<string | null> {
        const customer = await this.customer(customerId);
        return customer ? maskedPayerNumber(customer) : null;
    }

    async customer(customerId: string): Promise<ICustomer | null> {
        return CustomerModel.findById(customerId).select('name phone').lean<ICustomer>().exec();
    }

    /**
     * The renderer's view of one pending proposal. What the customer pays MORE comes from W-E:
     * the frozen top-up once approved, otherwise the plan an approval would run — never a
     * subtraction here (`proposedFee − feeBefore` is wrong whenever the shop bore part of the fee).
     */
    private async buildView(proposal: IDeliveryFeeProposal, order: IOrder): Promise<BotFeeChangeView | null> {
        if (proposal.status !== 'pending') return null;
        const dto = toCustomerDeliveryFeeProposalDto(proposal);
        const actions = dto.availableActions.filter((a): a is FeeChangeAction => a === 'approve' || a === 'reject' || a === 'pay');
        if (actions.length === 0) return null;

        const awaitingPayment = !!proposal.customer_approval && proposal.topup?.status === 'awaiting_payment';
        let customerPays: number;
        if (awaitingPayment) {
            customerPays = proposal.topup!.amount;
        } else {
            const shipment = await ShipmentModel.findById(proposal.shipment_id);
            if (!shipment) return null;
            const plan = planCustomerApprovedIncrease(await customerFeeApplicationService.stateOf(shipment, order), proposal.proposed_fee);
            // COD and cash for delivery (W-F): more cash at the door; online: a top-up to pay.
            customerPays = customerFeeApplicationService.modeOf(order) === 'online' ? plan.topupDue : plan.collectDelta;
        }

        return {
            proposalId: dto.id,
            orderId: order._id.toString(),
            orderNumber: order.order_number ?? order._id.toString(),
            shipmentId: dto.shipmentId,
            version: dto.version,
            origin: dto.origin,
            // Cash for delivery (W-F) reads as `cod` here: the difference is paid in cash at the door.
            paymentMode: customerFeeApplicationService.modeOf(order) === 'online' ? 'online' : 'cod',
            state: awaitingPayment ? 'awaiting_payment' : 'awaiting_answer',
            currency: dto.currency,
            feeBefore: dto.feeBefore,
            proposedFee: dto.proposedFee,
            customerPays,
            reason: dto.reason?.trim() ? dto.reason.trim() : null,
            availableActions: actions,
        };
    }

    // ── Combined-price requests ─────────────────────────────────────────────

    /**
     * The groups a combined price may be asked for: per checkout and delivery company, the parcels
     * W-E's own predicate says are eligible, kept when there are at least two.
     */
    async eligibleCombinedGroups(customerId: string): Promise<BotCombinedGroup[]> {
        const orders = await OrderModel.find({
            customer_id: new Types.ObjectId(customerId),
            fulfillment_status: { $nin: CLOSED_FULFILMENT },
        })
            .sort({ created_at: -1 })
            .limit(OPEN_ORDERS_SCANNED);
        const withCart = orders.filter((o) => !!o.cart_id);
        if (withCart.length === 0) return [];

        const orderById = new Map(withCart.map((o) => [o._id.toString(), o]));
        const shipments = await ShipmentModel.find({ order_id: { $in: withCart.map((o) => o._id) } });

        const groups = new Map<string, { cartId: string; agencyId: string; rows: Array<{ shipment: IShipment; order: IOrder }> }>();
        for (const shipment of shipments) {
            const order = orderById.get(shipment.order_id.toString());
            if (!order || !shipment.agency_id) continue;
            const payer = deliveryPayerOf(order, shipment);
            const pendingProposal = !!shipment.pending_delivery_fee_proposal_id;
            // Cheap refusals first, so the per-shipment count runs only for real candidates.
            if (payer !== 'customer' || pendingProposal) continue;
            const candidate = {
                shipmentId: (shipment._id as Types.ObjectId).toString(),
                agencyId: shipment.agency_id.toString(),
                cartId: order.cart_id.toString(),
                status: shipment.status,
                payer,
                pendingProposal,
                countedProposals: await deliveryFeeProposalRepository.countCountedForShipment((shipment._id as Types.ObjectId).toString()),
            };
            // The same single-candidate judgement `CombinedDeliveryRequestService.create` applies.
            const refusal = checkCombinedRequest({
                agencyId: candidate.agencyId,
                cartId: candidate.cartId,
                candidates: [candidate, candidate],
                maxProposals: MAX_NON_WITHDRAWN_PROPOSALS,
            });
            if (refusal) continue;
            const key = `${candidate.cartId}:${candidate.agencyId}`;
            const group = groups.get(key) ?? { cartId: candidate.cartId, agencyId: candidate.agencyId, rows: [] };
            group.rows.push({ shipment, order });
            groups.set(key, group);
        }

        const eligible = [...groups.values()].filter((g) => g.rows.length >= COMBINED_REQUEST_MIN_SHIPMENTS);
        if (eligible.length === 0) return [];

        const agencyIds = [...new Set(eligible.map((g) => g.agencyId))];
        const [names, agencies, open] = await Promise.all([
            this.magazins.findNamesByAgencyIds(agencyIds),
            this.agencies.findByIds(agencyIds),
            CombinedDeliveryRequestModel.find({
                customer_id: new Types.ObjectId(customerId),
                cart_id: { $in: eligible.map((g) => new Types.ObjectId(g.cartId)) },
                status: 'open',
            }).select('_id cart_id agency_id'),
        ]);
        const policiesById = new Map(agencies.map((a) => [(a._id as Types.ObjectId).toString(), a.policies ?? null]));

        return eligible.map((group) => {
            const currency = group.rows[0].order.currency;
            const policies = policiesById.get(group.agencyId) ?? null;
            const rows = group.rows.map(({ shipment, order }) => {
                const fee = customerFeeApplicationService.effectiveFee(shipment, order, policies);
                return {
                    shipmentId: (shipment._id as Types.ObjectId).toString(),
                    orderId: order._id.toString(),
                    orderNumber: order.order_number ?? order._id.toString(),
                    fee,
                    feeText: formatBotPrice(fee, currency),
                };
            });
            // A display total over figures the backend resolved — never a fee rule.
            const totalFee = rows.reduce((sum, row) => sum + row.fee, 0);
            const openRow = open.find((r) => r.cart_id.toString() === group.cartId && r.agency_id.toString() === group.agencyId);
            return {
                cartId: group.cartId,
                agencyId: group.agencyId,
                agencyName: names.get(group.agencyId)?.name ?? '—',
                currency,
                parcelCount: rows.length,
                totalFee,
                totalFeeText: formatBotPrice(totalFee, currency),
                shipments: rows,
                openRequestId: openRow ? (openRow._id as Types.ObjectId).toString() : null,
            };
        });
    }

    /** The customer's combined requests — one checkout's, or the newest across all of them (the chat window caps the answer). */
    async listCombined(customerId: string, cartId?: string | null): Promise<BotCombinedRequestProjection[]> {
        const filter: Record<string, unknown> = { customer_id: new Types.ObjectId(customerId) };
        if (cartId) filter.cart_id = new Types.ObjectId(cartId);
        const rows = await CombinedDeliveryRequestModel.find(filter).sort({ created_at: -1 }).limit(50);
        return this.projectCombined(rows);
    }

    /** The request, if it is this customer's (404 otherwise). */
    async ownedCombinedRequest(customerId: string, requestId: string): Promise<ICombinedDeliveryRequest> {
        const row = Types.ObjectId.isValid(requestId)
            ? await CombinedDeliveryRequestModel.findOne({ _id: requestId, customer_id: new Types.ObjectId(customerId) })
            : null;
        if (!row) throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_FOUND, 404);
        return row;
    }

    async agencyName(agencyId: string): Promise<string> {
        return (await this.magazins.findNameByAgencyId(agencyId).catch(() => null)) ?? '—';
    }

    async projectCombined(rows: ICombinedDeliveryRequest[]): Promise<BotCombinedRequestProjection[]> {
        if (rows.length === 0) return [];
        const agencyIds = [...new Set(rows.map((r) => r.agency_id.toString()))];
        const orderIds = [...new Set(rows.flatMap((r) => r.shipments.map((s) => s.order_id.toString())))];
        const [names, orders] = await Promise.all([
            this.magazins.findNamesByAgencyIds(agencyIds),
            OrderModel.find({ _id: { $in: orderIds } }).select('_id order_number').lean(),
        ]);
        const numberOf = new Map(orders.map((o) => [String(o._id), (o as { order_number?: string }).order_number ?? String(o._id)]));

        return rows.map((row) => {
            const dto = toCombinedDeliveryRequestDto(row);
            const money = (n: number) => formatBotPrice(n, dto.currency);
            return {
                id: dto.id,
                cartId: dto.cartId,
                agencyId: dto.agencyId,
                agencyName: names.get(dto.agencyId)?.name ?? '—',
                status: dto.status,
                currency: dto.currency,
                note: dto.note,
                parcelCount: dto.shipments.length,
                shipments: dto.shipments.map((s) => ({
                    shipmentId: s.shipmentId,
                    orderId: s.orderId,
                    orderNumber: numberOf.get(s.orderId) ?? s.orderId,
                    feeAtRequest: s.feeAtRequest,
                    feeAtRequestText: money(s.feeAtRequest),
                })),
                answer: dto.answer
                    ? {
                        saving: dto.answer.saving,
                        savingText: money(dto.answer.saving),
                        note: dto.answer.note,
                        answeredAt: dto.answer.answeredAt,
                        fees: dto.answer.fees.map((f) => ({
                            shipmentId: f.shipmentId,
                            feeBefore: f.feeBefore,
                            feeAfter: f.feeAfter,
                            feeBeforeText: money(f.feeBefore),
                            feeAfterText: money(f.feeAfter),
                        })),
                    }
                    : null,
                declineNote: dto.declineNote,
                createdAt: dto.createdAt,
                closedAt: dto.closedAt,
            };
        });
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /** An order of this customer's, by id or by the number they read out — 404 otherwise. */
    private async ownedOrder(customerId: string, reference: string): Promise<IOrder> {
        const customer = new Types.ObjectId(customerId);
        if (Types.ObjectId.isValid(reference)) {
            const byId = await OrderModel.findOne({ _id: reference, customer_id: customer });
            if (byId) return byId;
        }
        const byNumber = await OrderModel.findOne({
            customer_id: customer,
            order_number: { $regex: `^${escapeRegex(reference)}$`, $options: 'i' },
        });
        if (byNumber) return byNumber;
        throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId: reference });
    }
}

export const botDeliveryFeeService = new BotDeliveryFeeService();
