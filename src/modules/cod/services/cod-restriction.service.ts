import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';
import { eventBus } from '../../../core/events/event-bus';
import { ActorRef, actorStamp } from '../../../core/types/actor-source.types';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import {
  CodRestrictionSubject,
  CodRestrictionView,
  codRestrictionViewOf,
  isCodRestricted,
} from '../domain/cod-restriction';

/** The administrator's read (and the answer to a write): the state, the reason, the author. */
export interface CodRestrictionReport {
  subject: CodRestrictionSubject;
  /** The role entity: `customers._id` or `delivery_agencies._id`. */
  subjectId: string;
  /** The owning `users._id`. */
  userId: string | null;
  restricted: boolean;
  restriction: CodRestrictionView | null;
}

/** One stored row, as the service needs it. */
interface SubjectRow {
  id: string;
  userId: string | null;
  codRestriction: unknown;
}

/**
 * Everything the service touches, as a seam — so `test:cod-restrictions` drives the
 * compare-and-set and its refusals with no database.
 *
 * `write` is ONE conditional update: it sets (or clears) the restriction only when the
 * account is currently in the opposite state, and answers the updated row or `null`. The
 * state check lives in the filter rather than in a read-then-write because two
 * administrators on one screen must not each believe their reason is the one on record —
 * and restricting an already-restricted account (or lifting an unrestricted one) is a 409,
 * not a silent success: an audit row for a write that changed nothing is noise.
 */
export interface CodRestrictionPorts {
  findCustomerByUser(userId: string): Promise<SubjectRow | null>;
  findCustomerById(customerId: string): Promise<SubjectRow | null>;
  findAgency(agencyId: string): Promise<SubjectRow | null>;
  writeCustomerByUser(userId: string, next: Record<string, unknown> | null): Promise<SubjectRow | null>;
  writeAgency(agencyId: string, next: Record<string, unknown> | null): Promise<SubjectRow | null>;
}

const toRow = (doc: any): SubjectRow | null =>
  doc ? { id: String(doc._id), userId: doc.user_id ? String(doc.user_id) : null, codRestriction: doc.cod_restriction ?? null } : null;

/**
 * `cod_restriction: null` matches BOTH an explicit null and an absent field (every document
 * written before 2026-10-10), which is exactly "currently unrestricted".
 */
const stateFilter = (next: Record<string, unknown> | null) =>
  next === null ? { cod_restriction: { $ne: null } } : { cod_restriction: null };

const PROJECTION = { user_id: 1, cod_restriction: 1 };

const MONGO_PORTS: CodRestrictionPorts = {
  async findCustomerByUser(userId) {
    return toRow(await CustomerModel.findOne({ user_id: userId }, PROJECTION).lean().exec());
  },
  async findCustomerById(customerId) {
    return toRow(await CustomerModel.findById(customerId, PROJECTION).lean().exec());
  },
  async findAgency(agencyId) {
    return toRow(await DeliveryAgencyModel.findById(agencyId, PROJECTION).lean().exec());
  },
  async writeCustomerByUser(userId, next) {
    return toRow(
      await CustomerModel.findOneAndUpdate(
        { user_id: userId, ...stateFilter(next) },
        { $set: { cod_restriction: next } },
        { new: true, projection: PROJECTION, runValidators: true }
      ).lean().exec()
    );
  },
  async writeAgency(agencyId, next) {
    return toRow(
      await DeliveryAgencyModel.findOneAndUpdate(
        { _id: agencyId, ...stateFilter(next) },
        { $set: { cod_restriction: next } },
        { new: true, projection: PROJECTION, runValidators: true }
      ).lean().exec()
    );
  },
};

/**
 * CodRestrictionService — the administrator's cash-on-delivery switch for one customer or
 * one delivery agency (owner decision 2026-10-10). The rule and what it deliberately does
 * not touch are in `cod/domain/cod-restriction.ts`; this file owns the reads and the ONE
 * write. Nothing else may write `cod_restriction`.
 *
 * ── Where the restriction is enforced (it is read at decision time, never copied) ──
 *   customer   `CodEligibilityService.assertCustomerAllowed` — checkout, and the cart
 *              quote's `cashOnDelivery` verdict (which the bot's pay-on-delivery reads too);
 *   agency     `CodEligibilityService.assertVendorOrderEligible` — checkout and the quote;
 *              `CodLimitsService.evaluateHandoffs` — every hand-off of a COD shipment to an
 *              agency (auto-redirect holds, manual dispatch / change-agency refuse).
 *
 * ── A lift leaves no trace HERE ──────────────────────────────────────────────
 * Lifting clears the field, so afterwards this database holds neither the restriction nor
 * its reason. wi-admin's audit rows (`users.cod.restrict` / `.unrestrict`,
 * `agencies.cod.restrict` / `.unrestrict`) are the record, and they are fail-closed — the
 * same arrangement as the agency's cash-limit pin and its release.
 */
export class CodRestrictionService {
  constructor(private readonly ports: CodRestrictionPorts = MONGO_PORTS) {}

  // ─── Reads ──────────────────────────────────────────────────────────────

  /** The customer profile of `userId`. `404 AUTH_PROFILE_NOT_FOUND` when the account has none. */
  async reportForCustomerUser(userId: string): Promise<CodRestrictionReport> {
    const row = await this.ports.findCustomerByUser(userId);
    if (!row) throw this.noCustomerProfile();
    return this.toReport('customer', row);
  }

  async reportForAgency(agencyId: string): Promise<CodRestrictionReport> {
    const row = await this.ports.findAgency(agencyId);
    if (!row) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, undefined, { agencyId });
    return this.toReport('agency', row);
  }

  /**
   * Is this customer (a `customers._id`, the id checkout carries) restricted? An unknown
   * customer reads as NOT restricted: this is a narrowing rule, not an authorisation, and
   * checkout has its own refusal for a customer that does not exist.
   */
  async isCustomerRestricted(customerId: string): Promise<boolean> {
    const row = await this.ports.findCustomerById(customerId);
    return isCodRestricted(row?.codRestriction);
  }

  // ─── The write ──────────────────────────────────────────────────────────

  /** Restrict (`restricted: true`) or lift (`false`) COD for the customer profile of `userId`. */
  async setForCustomerUser(params: {
    userId: string;
    restricted: boolean;
    reason: string;
    actor: ActorRef;
  }): Promise<CodRestrictionReport> {
    const { userId, restricted, reason, actor } = params;
    const updated = await this.ports.writeCustomerByUser(userId, this.nextValue(restricted, reason, actor));
    if (!updated) {
      const current = await this.ports.findCustomerByUser(userId);
      if (!current) throw this.noCustomerProfile();
      throw this.unchanged('customer', current, restricted);
    }
    return this.afterWrite('customer', updated, restricted, actor);
  }

  /** Restrict or lift COD for one delivery agency. */
  async setForAgency(params: {
    agencyId: string;
    restricted: boolean;
    reason: string;
    actor: ActorRef;
  }): Promise<CodRestrictionReport> {
    const { agencyId, restricted, reason, actor } = params;
    const updated = await this.ports.writeAgency(agencyId, this.nextValue(restricted, reason, actor));
    if (!updated) {
      const current = await this.ports.findAgency(agencyId);
      if (!current) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, undefined, { agencyId });
      throw this.unchanged('agency', current, restricted);
    }
    return this.afterWrite('agency', updated, restricted, actor);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private nextValue(restricted: boolean, reason: string, actor: ActorRef): Record<string, unknown> | null {
    if (!restricted) return null;
    return { reason, restricted_at: new Date(), ...actorStamp('restricted_by', actor) };
  }

  private toReport(subject: CodRestrictionSubject, row: SubjectRow): CodRestrictionReport {
    const restriction = codRestrictionViewOf(row.codRestriction);
    return { subject, subjectId: row.id, userId: row.userId, restricted: restriction !== null, restriction };
  }

  private noCustomerProfile(): Error {
    return createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, 'This account has no customer profile', {
      role: 'customer',
    });
  }

  /** The conditional write matched nothing although the account exists: it is already there. */
  private unchanged(subject: CodRestrictionSubject, current: SubjectRow, wanted: boolean): Error {
    // `restricted` is the state as re-read. A concurrent write may have flipped it between
    // the two reads; that is still a conflict — the caller re-reads and decides again.
    const restricted = isCodRestricted(current.codRestriction);
    return createAppError(
      ERROR_CODES.COD_RESTRICTION_UNCHANGED,
      409,
      wanted
        ? 'Cash on delivery is already restricted for this account'
        : 'Cash on delivery is not restricted for this account',
      { subject, restricted }
    );
  }

  private afterWrite(
    subject: CodRestrictionSubject,
    row: SubjectRow,
    restricted: boolean,
    actor: ActorRef
  ): CodRestrictionReport {
    logger().info(
      { subject, subjectId: row.id, restricted, actorSource: actor.source },
      restricted ? 'COD restriction: set' : 'COD restriction: lifted'
    );

    // A hook for a later consumer (a notification to the restricted party is not built —
    // see the changelog). Post-write, fire-and-forget. The REASON and the author stay out
    // of the payload on purpose: they are the administrator's.
    const eventType = `${subject}.cod_restriction_changed`;
    void eventBus
      .publish(eventType, {
        eventType,
        aggregateId: row.id,
        occurredAt: new Date(),
        payload: { subject, subjectId: row.id, userId: row.userId, restricted },
      })
      .catch((err) => logger().error({ err, subject, subjectId: row.id }, 'COD restriction: change emit failed'));

    return this.toReport(subject, row);
  }
}

export const codRestrictionService = new CodRestrictionService();
