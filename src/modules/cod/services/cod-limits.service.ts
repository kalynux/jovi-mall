import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';
import { RoleActorRef, actorStamp } from '../../../core/types/actor-source.types';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionModel } from '../models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';
import { DeliveryAgencyModel, IAgencyCodLimitOverride } from '../../delivery/delivery-agency.model';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { eventBus } from '../../../core/events/event-bus';
import { VendorAgencyConnectionModel } from '../../agency-connections/connection.model';
import { StoreRepository } from '../../store/repositories/store.repository';
import { EARNINGS_CONFIG } from '../../earnings/config/earnings.config';
import {
  AgencyCodLimit,
  COD_EXPOSURE_SHIPMENT_STATUSES,
  CodExposureTotals,
  CodLimitBreach,
  ExposureCollectionRow,
  ExposureShipmentRow,
  VendorCodTerms,
  evaluateCodLimits,
  expectedCodAmount,
  resolveAgencyCodLimit,
  sumCodExposure,
  vendorCodTermsOf,
} from '../domain/cod-limits';

/** Every row behind one agency's exposure — gathered once, summed as often as needed. */
export interface AgencyExposureRows {
  shipments: ExposureShipmentRow[];
  collections: ExposureCollectionRow[];
}

/** The read surface: the agency's limit, where it came from, and what it holds now. */
export interface AgencyCodLimitReport {
  agencyId: string;
  limit: number;
  source: AgencyCodLimit['source'];
  defaultLimit: number;
  exposure: CodExposureTotals;
  /** `limit - exposure.total`, floored at 0. */
  headroom: number;
  /** `exposure.total > limit` — reachable through a forced dispatch or a lowered pin. */
  overLimit: boolean;
}

/** The admin read adds the pin itself (reason and author) — never shown to the agency. */
export interface AdminAgencyCodLimitReport extends AgencyCodLimitReport {
  override: {
    amount: number;
    reason: string;
    setAt: Date;
    setByUserId: string | null;
    setBySource: string;
    setByName: string | null;
  } | null;
}

/** One shipment about to be handed to an agency, as the gate needs it. */
export interface CodHandoffCandidate {
  shipmentId: string;
  agencyId: string;
  vendorId: string;
  /** Its COD amount; 0 for a prepaid order (never refused). */
  amount: number;
}

export interface CodHandoffVerdict extends CodHandoffCandidate {
  breach: CodLimitBreach | null;
}

/**
 * CodLimitsService — the agency's cash limit and the vendor's COD terms, enforced at the
 * moment a COD shipment changes hands to an agency (owner decisions 2026-10-02). The
 * rules are pure in `cod/domain/cod-limits.ts`; this file gathers the numbers and owns
 * the one write (the administrator's pin).
 *
 * ── Where it runs ──────────────────────────────────────────────────────────
 *   - the vendor's AUTO-REDIRECT (`OrderService.maybeDispatchToAgencies`): a breach does
 *     NOT dispatch that shipment and records `cod_limit_hold` on it — the order itself
 *     still goes through;
 *   - the vendor's MANUAL dispatch (single + bulk) and change-agency-per-item: a breach
 *     is `422 COD_AGENCY_LIMIT_EXCEEDED` unless the request carries `force: true`, which
 *     is recorded on the shipment (`cod_limit_force`).
 *
 * It is NOT on the agency → agent path: that has its own, separate gate
 * (`CodExposureService`, the agent's pool and contract slice).
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * Check-then-act, deliberately without a lock: two dispatches racing for the last of an
 * agency's headroom can both pass. The cap bounds a risk; it is not a ledger. The
 * over-limit state that results is visible (`overLimit` on every read) and stops the
 * NEXT dispatch, which is the same posture the agent pool takes after a downgrade.
 */
export class CodLimitsService {
  constructor(private readonly vendorSettings: VendorSettingsRepository = new VendorSettingsRepository()) {}

  // ─── Reads ──────────────────────────────────────────────────────────────

  /** The agency's limit — the pin when one is set, else the platform default. */
  async limitFor(agencyId: string): Promise<{ limit: AgencyCodLimit; override: IAgencyCodLimitOverride | null }> {
    const agency = await DeliveryAgencyModel.findById(agencyId, { cod_limit_override: 1 }).lean().exec();
    if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, undefined, { agencyId });
    const override = (agency.cod_limit_override as IAgencyCodLimitOverride | null | undefined) ?? null;
    return { limit: resolveAgencyCodLimit(override), override };
  }

  /** The vendor's COD terms with defaults applied. Never writes. */
  async vendorTerms(vendorId: string): Promise<VendorCodTerms> {
    return vendorCodTermsOf(await this.vendorSettings.findCodTerms(vendorId));
  }

  /**
   * Every row behind the agency's exposure, across every vendor.
   *
   * Three reads: the agency's in-custody shipments, their orders (to keep only COD and
   * to price shipments that have no collection row yet), and the collections — both the
   * in-custody shipments' and every collected-but-unsettled one.
   */
  async exposureRows(agencyId: string): Promise<AgencyExposureRows> {
    const agencyOid = new Types.ObjectId(agencyId);

    const [shipments, collected] = await Promise.all([
      ShipmentModel.find(
        { agency_id: agencyOid, status: { $in: COD_EXPOSURE_SHIPMENT_STATUSES as unknown as string[] } },
        { order_id: 1, items: 1 }
      ).lean().exec(),
      CashCollectionModel.find(
        { agency_id: agencyOid, status: 'collected', $expr: { $lt: ['$settled_amount', '$expected_amount'] } },
        { vendor_id: 1, expected_amount: 1, settled_amount: 1 }
      ).lean().exec(),
    ]);

    const collections: ExposureCollectionRow[] = collected.map((c: any) => ({
      collectionId: String(c._id),
      vendorId: String(c.vendor_id),
      expectedAmount: c.expected_amount ?? 0,
      settledAmount: c.settled_amount ?? 0,
    }));

    if (shipments.length === 0) return { shipments: [], collections };

    const orderIds = [...new Set(shipments.map((s: any) => String(s.order_id)))];
    const [orders, shipmentCollections] = await Promise.all([
      OrderModel.find(
        { _id: { $in: orderIds.map((id) => new Types.ObjectId(id)) }, payment_method: 'cash_on_delivery' },
        { vendor_id: 1, items: 1 }
      ).lean().exec(),
      CashCollectionModel.find(
        { shipment_id: { $in: shipments.map((s: any) => s._id) } },
        { shipment_id: 1, status: 1, expected_amount: 1 }
      ).lean().exec(),
    ]);
    const orderById = new Map(orders.map((o: any) => [String(o._id), o]));
    const collectionByShipment = new Map(shipmentCollections.map((c: any) => [String(c.shipment_id), c]));

    const rows: ExposureShipmentRow[] = [];
    for (const s of shipments as any[]) {
      const order = orderById.get(String(s.order_id));
      if (!order) continue; // prepaid — no cash
      const collection = collectionByShipment.get(String(s._id));
      rows.push({
        shipmentId: String(s._id),
        vendorId: String(order.vendor_id),
        amount:
          collection && collection.status === 'pending'
            ? collection.expected_amount ?? 0
            : expectedCodAmount(order.items ?? [], s.items ?? []),
        collectionStatus: collection?.status ?? null,
      });
    }
    return { shipments: rows, collections };
  }

  /** The agency's limit and what it holds right now — the agency's and wi-admin's read. */
  async report(agencyId: string): Promise<AdminAgencyCodLimitReport> {
    const [{ limit, override }, rows] = await Promise.all([this.limitFor(agencyId), this.exposureRows(agencyId)]);
    const exposure = sumCodExposure(rows.shipments, rows.collections);
    return {
      agencyId,
      limit: limit.amount,
      source: limit.source,
      defaultLimit: COD_CONFIG.AGENCY_COD_LIMIT_DEFAULT,
      exposure,
      headroom: Math.max(0, limit.amount - exposure.total),
      overLimit: exposure.total > limit.amount,
      override: override
        ? {
            amount: override.amount,
            reason: override.reason,
            setAt: override.set_at,
            setByUserId: override.set_by_user_id ?? null,
            setBySource: override.set_by_source,
            setByName: override.set_by_name ?? null,
          }
        : null,
    };
  }

  /** The agency-facing read — the same report without the pin's reason and author. */
  async reportForAgency(agencyId: string): Promise<AgencyCodLimitReport> {
    const { override: _omitted, ...rest } = await this.report(agencyId);
    return rest;
  }

  // ─── The gate ───────────────────────────────────────────────────────────

  /**
   * Evaluate a batch of hand-offs IN ORDER, each one counting the ones before it that
   * passed (or were forced) — so a single dispatch of several shipments to one agency
   * cannot slip past the limit by being judged one at a time against the same snapshot.
   *
   * `force` affects only the running totals: a forced shipment still reports its breach
   * (the caller records it) and its amount is counted for the shipments after it. A
   * refused-and-not-forced shipment is NOT counted — it is not going to the agency.
   */
  async evaluateHandoffs(candidates: CodHandoffCandidate[], opts: { force?: boolean } = {}): Promise<CodHandoffVerdict[]> {
    const cod = candidates.filter((c) => c.amount > 0);
    if (cod.length === 0) return candidates.map((c) => ({ ...c, breach: null }));

    const agencyIds = [...new Set(cod.map((c) => c.agencyId))];
    const vendorIds = [...new Set(cod.map((c) => c.vendorId))];
    const [limits, rowsByAgency, terms] = await Promise.all([
      Promise.all(agencyIds.map(async (id) => [id, (await this.limitFor(id)).limit] as const)),
      Promise.all(agencyIds.map(async (id) => [id, await this.exposureRows(id)] as const)),
      Promise.all(vendorIds.map(async (id) => [id, await this.vendorTerms(id)] as const)),
    ]);
    const limitByAgency = new Map(limits);
    const rows = new Map(rowsByAgency);
    const termsByVendor = new Map(terms);

    // Running additions within this batch, per agency and per (agency, vendor).
    const addedAgency = new Map<string, number>();
    const addedVendor = new Map<string, number>();

    const out: CodHandoffVerdict[] = [];
    for (const c of candidates) {
      if (c.amount <= 0) {
        out.push({ ...c, breach: null });
        continue;
      }
      const agencyRows = rows.get(c.agencyId)!;
      // A shipment already counted as in-custody (re-dispatch of an assigned shipment)
      // must not be counted twice.
      const others = agencyRows.shipments.filter((s) => s.shipmentId !== c.shipmentId);
      const agencyExposure = sumCodExposure(others, agencyRows.collections).total + (addedAgency.get(c.agencyId) ?? 0);
      const vendorKey = `${c.agencyId}:${c.vendorId}`;
      const vendorExposure =
        sumCodExposure(others, agencyRows.collections, c.vendorId).total + (addedVendor.get(vendorKey) ?? 0);

      const breach = evaluateCodLimits({
        additionalAmount: c.amount,
        agency: { exposure: agencyExposure, limit: limitByAgency.get(c.agencyId)!.amount },
        vendor: { exposure: vendorExposure, cap: termsByVendor.get(c.vendorId)!.maxCashPerAgency },
      });

      out.push({ ...c, breach });
      if (!breach || opts.force) {
        addedAgency.set(c.agencyId, (addedAgency.get(c.agencyId) ?? 0) + c.amount);
        addedVendor.set(vendorKey, (addedVendor.get(vendorKey) ?? 0) + c.amount);
      }
    }
    return out;
  }

  /** The 422 for the first breach of a batch. */
  limitExceededError(verdict: CodHandoffVerdict): Error {
    const b = verdict.breach!;
    return createAppError(ERROR_CODES.COD_AGENCY_LIMIT_EXCEEDED, 422, undefined, {
      kind: b.kind,
      currentExposure: b.currentExposure,
      additionalAmount: b.additionalAmount,
      limit: b.limit,
      agencyId: verdict.agencyId,
      shipmentId: verdict.shipmentId,
      hint:
        b.kind === 'agency_limit'
          ? 'The delivery agency already holds as much cash on delivery as it may. Wait for it to remit cash to the platform, choose another agency, or retry with force: true.'
          : 'Your own COD terms cap how much of your cash one agency may hold. Wait for it to remit, raise maxCashPerAgency, or retry with force: true.',
    });
  }

  // ─── Hold / force stamps on the shipment ────────────────────────────────

  /** Record why auto-redirect left this shipment pending. */
  async markHeld(shipmentId: string, breach: CodLimitBreach): Promise<void> {
    await ShipmentModel.updateOne(
      { _id: new Types.ObjectId(shipmentId) },
      {
        $set: {
          cod_limit_hold: {
            kind: breach.kind,
            current: breach.currentExposure,
            additional: breach.additionalAmount,
            limit: breach.limit,
            evaluated_at: new Date(),
          },
        },
      }
    ).exec();
  }

  /** Record a forced hand-off (and clear any hold). */
  async markForced(shipmentId: string, breach: CodLimitBreach, actor: { userId: string | null; role: string }): Promise<void> {
    await ShipmentModel.updateOne(
      { _id: new Types.ObjectId(shipmentId) },
      {
        $set: {
          cod_limit_hold: null,
          cod_limit_force: {
            kind: breach.kind,
            forced_by_user_id: actor.userId,
            forced_by_role: actor.role,
            forced_at: new Date(),
            current: breach.currentExposure,
            additional: breach.additionalAmount,
            limit: breach.limit,
          },
        },
      }
    ).exec();
  }

  /** A dispatch went through within the limits — drop any stale hold. */
  async clearHolds(shipmentIds: string[]): Promise<void> {
    if (shipmentIds.length === 0) return;
    await ShipmentModel.updateMany(
      { _id: { $in: shipmentIds.map((id) => new Types.ObjectId(id)) }, cod_limit_hold: { $ne: null } },
      { $set: { cod_limit_hold: null } }
    ).exec();
  }

  // ─── The administrator's pin ────────────────────────────────────────────

  /**
   * Pin the agency's limit (`amount`) or release the pin (`null`). Reason required
   * either way. Mirrors the agent pool pin, minus the "below allocated" refusal: a
   * lower pin than the agency currently holds is ALLOWED — it is a fact about what the
   * platform will hand over next, and the over-limit state it creates is reported
   * (`overLimit`) and blocks further dispatch until cash comes back.
   */
  async setOverride(params: {
    agencyId: string;
    amount: number | null;
    reason: string;
    actor: RoleActorRef;
  }): Promise<AdminAgencyCodLimitReport> {
    const { agencyId, amount, reason, actor } = params;
    if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > COD_CONFIG.AGENCY_COD_LIMIT_MAX)) {
      throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'maxAmount is out of bounds', {
        requested: amount,
        min: 0,
        max: COD_CONFIG.AGENCY_COD_LIMIT_MAX,
      });
    }

    const override =
      amount === null
        ? null
        : {
            amount,
            reason,
            set_at: new Date(),
            ...actorStamp('set_by', actor),
          };

    const updated = await DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      { $set: { cod_limit_override: override } },
      { new: true, runValidators: true }
    ).exec();
    if (!updated) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, undefined, { agencyId });

    logger().info(
      { agencyId, amount, actorSource: actor.source },
      amount === null ? 'agency COD limit: pin released' : 'agency COD limit: pin set'
    );

    // The agency is told (`cod.limit.pinned` / `cod.limit.released`). Post-write,
    // fire-and-forget. The REASON and the author stay out of the payload on purpose — they
    // are the administrator's, and the agency read (`reportForAgency`) omits them too.
    const resolved = resolveAgencyCodLimit(override);
    void eventBus
      .publish('agency.cod_limit_changed', {
        eventType: 'agency.cod_limit_changed',
        aggregateId: agencyId,
        occurredAt: new Date(),
        payload: {
          agencyId,
          pinned: amount !== null,
          limit: resolved.amount,
          source: resolved.source,
          defaultLimit: COD_CONFIG.AGENCY_COD_LIMIT_DEFAULT,
          currency: EARNINGS_CONFIG.DEFAULT_CURRENCY,
        },
      })
      .catch((err) => logger().error({ err, agencyId }, 'agency COD limit: change emit failed'));

    return this.report(agencyId);
  }

  // ─── The vendor's terms changed ─────────────────────────────────────────

  /**
   * Fan `vendor.cod_terms_changed` out to every agency with an ACTIVE connection to this
   * vendor (`connection.cod_terms_changed` on the agency stack). Called by the vendor's
   * `PUT /profile/cod-terms` AFTER the write, only when a value actually changed — a PUT
   * that re-sends the same terms notifies nobody. `paused_reapproval` connections are
   * skipped: those agencies already have a re-approval in front of them, and the terms are on
   * the connection screen they will open.
   *
   * Best-effort and never throws: telling agencies is not worth failing the vendor's save.
   */
  async publishVendorTermsChanged(
    vendorId: string,
    before: VendorCodTerms,
    after: VendorCodTerms
  ): Promise<void> {
    try {
      if (before.codEnabled === after.codEnabled && before.maxCashPerAgency === after.maxCashPerAgency) return;
      const connections = await VendorAgencyConnectionModel.find(
        { vendor_id: new Types.ObjectId(vendorId), status: 'active' },
        { agency_id: 1 }
      ).lean().exec();
      if (connections.length === 0) return;
      const vendorName = (await new StoreRepository().findNameByVendorId(vendorId)) ?? '';
      const occurredAt = new Date();
      for (const c of connections as any[]) {
        await eventBus.publish('vendor.cod_terms_changed', {
          eventType: 'vendor.cod_terms_changed',
          aggregateId: String(c._id),
          occurredAt,
          payload: {
            connectionId: String(c._id),
            agencyId: String(c.agency_id),
            vendorId,
            vendorName,
            codEnabled: after.codEnabled,
            maxCashPerAgency: after.maxCashPerAgency,
            currency: EARNINGS_CONFIG.DEFAULT_CURRENCY,
          },
        });
      }
    } catch (err) {
      logger().error({ err, vendorId }, 'vendor COD terms: change emit failed');
    }
  }
}

export const codLimitsService = new CodLimitsService();
