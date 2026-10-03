import { Types } from 'mongoose';
import { EarningsAllocationModel } from '../models/earnings-allocation.model';
import { PayoutRequestModel } from '../models/payout-request.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { AgentDepositModel } from '../../cod/models/agent-deposit.model';
import { AgencyRemittanceModel } from '../../cod/models/agency-remittance.model';
import { CodCashAccountModel } from '../../cod/models/cod-cash-account.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import { AnalyticsPeriod } from '../../vendors/analytics/net-revenue';

/**
 * Agency and agent analytics — `GET /api/agency/analytics` and `GET /api/agent/analytics`
 * (net-new 2026-09-27; neither role had any analytics endpoint before).
 *
 * Same rules as the rebuilt vendor analytics, so the three dashboards agree with each other and
 * with the account statements wi-admin emails:
 *  - **earnings are READ from the allocations** jovi-mall wrote, never re-quoted from a live
 *    `fee_split` or `policies.pricing`;
 *  - **dated when credited** — the allocation's `created_at` (delivery for prepaid, cash
 *    collection for COD);
 *  - **local calendar days, end exclusive** (`toAnalyticsPeriod`).
 *
 * COD cash is reported SEPARATELY from earnings, on purpose: it is a liability the holder owes
 * the platform, not income, and adding the two would be the single easiest way to misread these
 * numbers.
 */

type Id = Types.ObjectId;
type AllocStatus = 'held' | 'released' | 'reversed';

interface Row {
    _id: Id;
    source_type: string;
    source_id: Id;
    beneficiary_type: string;
    beneficiary_id: Id | null;
    amount: number;
    status: AllocStatus;
    currency: string;
    created_at: Date;
}

const sum = <T>(rows: T[], pick: (r: T) => number | null | undefined) => rows.reduce((s, r) => s + (pick(r) ?? 0), 0);

export interface DeliveryEarning {
    sourceType: 'shipment' | 'cod_collection';
    shipmentId: string | null;
    agentId: string | null;
    agencyNet: number;
    agentCut: number;
    /** `null` when a COD run has no `delivery_fee_snapshot` to split the handling fee against. */
    codFee: number | null;
    status: AllocStatus;
    /** Which row this earning belongs to for the ASKING owner. */
    ownAmount: number;
}

/** Pure: the agency's COD handling fee as the residual of what was allocated. Exported for tests. */
export function codFeeOf(sourceType: string, agencyNet: number, agentCut: number, deliveryFeeSnapshot: number | null): number | null {
    if (sourceType !== 'cod_collection') return 0;
    if (deliveryFeeSnapshot === null || deliveryFeeSnapshot > agencyNet + agentCut) return null;
    return agencyNet + agentCut - deliveryFeeSnapshot;
}

export class DeliveryAnalyticsService {
    private async earnings(ownerType: 'agency' | 'agent', ownerId: Id, period: AnalyticsPeriod) {
        const window = { $gte: period.start, $lt: period.end };
        const [own, reversed] = await Promise.all([
            EarningsAllocationModel.find({
                beneficiary_type: ownerType,
                beneficiary_id: ownerId,
                source_type: { $in: ['shipment', 'cod_collection'] },
                created_at: window,
            })
                .select('source_type source_id beneficiary_type beneficiary_id amount status currency created_at')
                .lean<Row[]>(),
            EarningsAllocationModel.find({ beneficiary_type: ownerType, beneficiary_id: ownerId, reversed_at: window })
                .select('amount')
                .lean<{ amount: number }[]>(),
        ]);

        const byType = (t: string) => own.filter((r) => r.source_type === t).map((r) => r.source_id);
        const [siblings, collections] = await Promise.all([
            own.length
                ? EarningsAllocationModel.find({
                      beneficiary_type: { $in: ['agency', 'agent'] },
                      $or: ['shipment', 'cod_collection']
                          .map((t) => ({ source_type: t, source_id: { $in: byType(t) } }))
                          .filter((c) => c.source_id.$in.length > 0),
                  })
                      .select('source_type source_id beneficiary_type beneficiary_id amount')
                      .lean<Row[]>()
                : Promise.resolve([] as Row[]),
            CashCollectionModel.find({ _id: { $in: byType('cod_collection') } })
                .select('shipment_id')
                .lean<{ _id: Id; shipment_id: Id }[]>(),
        ]);
        const shipmentOfCollection = new Map(collections.map((c) => [c._id.toString(), c.shipment_id]));
        // Every shipment behind these rows, not only the COD ones: `agent_id` is the
        // attribution fallback for a delivery that wrote NO agent row — a
        // `monthly_salary` contract (cut 0 by design; the agency pays off-platform)
        // or an unconfigured 0% split. Without it those runs vanish from `perAgent`.
        const snapshots = await ShipmentModel.find({
            _id: { $in: [...collections.map((c) => c.shipment_id), ...byType('shipment')] },
        })
            .select('delivery_fee_snapshot agent_id')
            .lean<{ _id: Id; delivery_fee_snapshot?: number | null; agent_id?: Id | null }[]>();
        const snapshotOf = new Map(snapshots.map((s) => [s._id.toString(), s.delivery_fee_snapshot ?? null]));
        const agentOfShipment = new Map(snapshots.map((s) => [s._id.toString(), s.agent_id ? s.agent_id.toString() : null]));

        const items: DeliveryEarning[] = own.map((r) => {
            const sib = siblings.filter((s) => s.source_type === r.source_type && s.source_id.equals(r.source_id));
            const agencyRow = sib.find((s) => s.beneficiary_type === 'agency');
            const agentRow = sib.find((s) => s.beneficiary_type === 'agent');
            const shipmentId =
                r.source_type === 'shipment' ? r.source_id : shipmentOfCollection.get(r.source_id.toString()) ?? null;
            const agencyNet = agencyRow?.amount ?? 0;
            const agentCut = agentRow?.amount ?? 0;
            return {
                sourceType: r.source_type as DeliveryEarning['sourceType'],
                shipmentId: shipmentId ? shipmentId.toString() : null,
                agentId: agentRow?.beneficiary_id
                    ? agentRow.beneficiary_id.toString()
                    : shipmentId
                      ? agentOfShipment.get(shipmentId.toString()) ?? null
                      : null,
                agencyNet,
                agentCut,
                codFee: codFeeOf(r.source_type, agencyNet, agentCut, shipmentId ? snapshotOf.get(shipmentId.toString()) ?? null : null),
                status: r.status,
                ownAmount: r.amount,
            };
        });

        return { items, reversed: sum(reversed, (r) => r.amount), currency: own[0]?.currency ?? null };
    }

    /** Shipments of this owner that REACHED an outcome in the period, counted once each. */
    private async outcomes(field: 'agency_id' | 'agent_id', ownerId: Id, period: AnalyticsPeriod) {
        const window = { $gte: period.start, $lt: period.end };
        const count = (statuses: string[]) =>
            ShipmentModel.countDocuments({
                [field]: ownerId,
                status_history: { $elemMatch: { status: { $in: statuses }, changed_at: window } },
            });
        const [delivered, returned, failed] = await Promise.all([
            count(['agent_delivered', 'delivered']),
            count(['returned']),
            count(['failed']),
        ]);
        return { delivered, returned, failed };
    }

    private async payouts(ownerType: 'agency' | 'agent', ownerId: Id, period: AnalyticsPeriod) {
        const [inPeriod, lifetime] = await Promise.all([
            PayoutRequestModel.find({
                owner_type: ownerType,
                owner_id: ownerId,
                status: 'paid',
                resolved_at: { $gte: period.start, $lt: period.end },
            })
                .select('amount')
                .lean<{ amount: number }[]>(),
            PayoutRequestModel.aggregate<{ total: number }>([
                { $match: { owner_type: ownerType, owner_id: ownerId, status: 'paid' } },
                { $group: { _id: null, total: { $sum: '$amount' } } },
            ]),
        ]);
        return { paidInPeriod: sum(inPeriod, (p) => p.amount), lifetimePaidOut: lifetime[0]?.total ?? 0 };
    }

    private meta(period: AnalyticsPeriod, currency: string | null) {
        return {
            from: period.from,
            to: period.to,
            timezone: period.timezone,
            computedAt: new Date().toISOString(),
            currency: currency ?? 'XAF',
        };
    }

    async forAgency(agencyId: string, period: AnalyticsPeriod) {
        const id = new Types.ObjectId(agencyId);
        const window = { $gte: period.start, $lt: period.end };
        const [earned, outcomes, payouts, collected, deposits, remitted, liability] = await Promise.all([
            this.earnings('agency', id, period),
            this.outcomes('agency_id', id, period),
            this.payouts('agency', id, period),
            CashCollectionModel.find({ agency_id: id, collected_at: window })
                .select('agent_id expected_amount')
                .lean<{ agent_id: Id; expected_amount: number }[]>(),
            AgentDepositModel.find({ agency_id: id, status: 'confirmed', resolved_at: window })
                .select('amount')
                .lean<{ amount: number }[]>(),
            AgencyRemittanceModel.find({ agency_id: id, status: 'confirmed', resolved_at: window })
                .select('amount')
                .lean<{ amount: number }[]>(),
            CodCashAccountModel.findOne({ owner_type: 'agency', owner_id: id }).select('balance').lean<{ balance: number } | null>(),
        ]);

        const unsplit = earned.items.some((e) => e.codFee === null);
        const agentIds = [...new Set([...earned.items.map((e) => e.agentId), ...collected.map((c) => c.agent_id.toString())].filter((x): x is string => !!x))];
        const agents = await DeliveryAgentModel.find({ _id: { $in: agentIds } })
            .select('name')
            .lean<{ _id: Id; name: string }[]>();
        const nameOf = new Map(agents.map((a) => [a._id.toString(), a.name]));

        const perAgent = agentIds.map((agentId) => {
            const mine = earned.items.filter((e) => e.agentId === agentId);
            return {
                agentId,
                name: nameOf.get(agentId) ?? null,
                deliveriesCredited: mine.length,
                agentShare: sum(mine, (e) => e.agentCut),
                codCollected: sum(collected.filter((c) => c.agent_id.toString() === agentId), (c) => c.expected_amount),
            };
        });

        return {
            data: {
                earnings: {
                    deliveriesCredited: earned.items.length,
                    deliveryFeesEarned: unsplit ? null : sum(earned.items, (e) => e.agencyNet + e.agentCut - (e.codFee ?? 0)),
                    codFees: unsplit ? null : sum(earned.items, (e) => e.codFee),
                    agentShares: sum(earned.items, (e) => e.agentCut),
                    agencyNet: sum(earned.items, (e) => e.ownAmount),
                    byStatus: {
                        held: sum(earned.items.filter((e) => e.status === 'held'), (e) => e.ownAmount),
                        released: sum(earned.items.filter((e) => e.status === 'released'), (e) => e.ownAmount),
                        reversed: sum(earned.items.filter((e) => e.status === 'reversed'), (e) => e.ownAmount),
                    },
                    reversedInPeriod: earned.reversed,
                    netEarnings: sum(earned.items, (e) => e.ownAmount) - earned.reversed,
                },
                deliveries: outcomes,
                cod: {
                    collectedByAgents: sum(collected, (c) => c.expected_amount),
                    depositsConfirmed: sum(deposits, (d) => d.amount),
                    remittedToPlatform: sum(remitted, (r) => r.amount),
                    liabilityNow: liability?.balance ?? 0,
                },
                perAgent,
                payouts,
            },
            meta: this.meta(period, earned.currency),
        };
    }

    async forAgent(agentId: string, period: AnalyticsPeriod) {
        const id = new Types.ObjectId(agentId);
        const window = { $gte: period.start, $lt: period.end };
        const [earned, outcomes, payouts, collected, deposits, cash] = await Promise.all([
            this.earnings('agent', id, period),
            this.outcomes('agent_id', id, period),
            this.payouts('agent', id, period),
            CashCollectionModel.find({ agent_id: id, collected_at: window })
                .select('expected_amount')
                .lean<{ expected_amount: number }[]>(),
            AgentDepositModel.find({ agent_id: id, status: 'confirmed', resolved_at: window })
                .select('amount')
                .lean<{ amount: number }[]>(),
            CodCashAccountModel.findOne({ owner_type: 'agent', owner_id: id }).select('balance').lean<{ balance: number } | null>(),
        ]);
        const own = sum(earned.items, (e) => e.ownAmount);
        return {
            data: {
                earnings: {
                    deliveriesCredited: earned.items.length,
                    yourShare: own,
                    byStatus: {
                        held: sum(earned.items.filter((e) => e.status === 'held'), (e) => e.ownAmount),
                        released: sum(earned.items.filter((e) => e.status === 'released'), (e) => e.ownAmount),
                        reversed: sum(earned.items.filter((e) => e.status === 'reversed'), (e) => e.ownAmount),
                    },
                    reversedInPeriod: earned.reversed,
                    netEarnings: own - earned.reversed,
                },
                deliveries: outcomes,
                cod: {
                    collected: sum(collected, (c) => c.expected_amount),
                    handedOverConfirmed: sum(deposits, (d) => d.amount),
                    cashHeldNow: cash?.balance ?? 0,
                },
                payouts,
            },
            meta: this.meta(period, earned.currency),
        };
    }
}

export const deliveryAnalyticsService = new DeliveryAnalyticsService();
