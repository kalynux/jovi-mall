import { ClientSession, Types } from 'mongoose';
import { UserModel } from '../users/user.model';
import { AccountClosureRepository } from '../users/account-closure.repository';
import { VendorModel } from '../vendors/vendor.model';
import { StoreModel } from '../store/models/store.model';
import { DeliveryAgencyModel } from '../delivery/delivery-agency.model';
import { AgencyMagazinModel } from '../magazin/models/magazin.model';
import { DeliveryAgentModel } from '../agents/models/agent.model';
import { AgentAgencyContractModel, LIVE_CONTRACT_STATUSES } from '../agents/models/agent-agency-membership.model';
import { ContractStatusRequestModel } from '../agents/models/contract-status-request.model';
import { ContractTermsProposalModel } from '../agents/models/contract-terms-proposal.model';
import { agentContractRepository } from '../agents/repositories/agent-contract.repository';
import { agentMembershipEventRepository } from '../agents/repositories/agent-membership-event.repository';
import { VendorAgencyConnectionModel, ConnectionParty } from '../agency-connections/connection.model';
import { UserPaymentMethodModel } from '../payment-methods/models/user-payment-method.model';
import { VendorNotificationModel } from '../notifications/models/vendor-notification.model';
import { VendorNotificationPreferenceModel } from '../notifications/models/vendor-notification-preference.model';
import { AgencyNotificationModel } from '../notifications/models/agency-notification.model';
import { AgencyNotificationPreferenceModel } from '../notifications/models/agency-notification-preference.model';
import { AgentNotificationModel } from '../notifications/models/agent-notification.model';
import { AgentNotificationPreferenceModel } from '../notifications/models/agent-notification-preference.model';
import { CustomerNotificationPreferenceModel } from '../notifications/models/customer-notification-preference.model';
import { ConnectedCalendarAccount } from '../integrations/calendar/google/connected-account.model';
import { FileReferenceRepositoryMongo } from '../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceEntityType } from '../catalog/models/file-reference.model';
import { ProductPlatformSuspensionService } from '../catalog/domain/services/ProductPlatformSuspensionService';
import { AdminAgencyService } from '../delivery/services/admin-agency.service';
import { agentRepository } from '../agents/repositories/agent.repository';
import { trackingOutboxEmitter } from '../tracking-integration/services/tracking-outbox.emitter';
import { ClosableRole } from './role-closure.types';

/**
 * Role closure — the write half. ONE FILE, on purpose (ADR-A10, extending ADR-A02).
 *
 * The rule `AccountClosureRepository` states for the customer applies per role: the property
 * that matters is **every collection holding one role's identifiers is named in one place**,
 * so a collection added next year that stores a name or a phone number is visibly missing
 * from this file rather than silently left behind.
 *
 * ── The three verbs, per role ─────────────────────────────────────────────────
 *   ANONYMISE  the role entity (and its storefront — Store or Magazin) keeps its `_id`, which
 *              orders, shipments, earnings and payouts point at, and loses every identifier.
 *              It lands on `status: 'inactive'` — the value every business gate already treats
 *              as "off" — plus `closed_at`, which `requireAuth` and every reinstate verb refuse.
 *   DELETE     rows that ARE an identifier or an address to reach the person on: role-scoped
 *              notifications and their preferences, saved payment instruments, calendar OAuth
 *              tokens; and file references, which start each file's orphan clock.
 *   END        relationships with other parties (owner decision O-5): agent↔agency contracts
 *              and vendor↔agency connections. Blockers have already proved nothing live rides
 *              on them, so ending them strands nothing — it stops a counterparty seeing an
 *              "active" partner who no longer exists.
 *   UNTOUCHED  money and transactions, exactly as ADR-A02 D-1.
 *
 * ── User-scoped rows survive a ROLE closure ───────────────────────────────────
 * Messaging connections and device tokens belong to the person, and their remaining roles
 * still use them. They go only in `closeAccountIfLastRole`, i.e. when nothing is left.
 *
 * ── Every method takes the session ────────────────────────────────────────────
 * The whole role closes in ONE transaction with the request's compare-and-set, so a failure
 * anywhere leaves the role exactly as it was and the request still pending.
 */

/** Placeholder for a REQUIRED name column. Says what happened, as `ANONYMISED_CUSTOMER_NAME` does. */
export const ANONYMISED_ROLE_NAME = 'Closed account';
export const ANONYMISED_STORE_NAME = 'Closed store';
export const ANONYMISED_MAGAZIN_NAME = 'Closed agency';
/**
 * `Vendor.phone` and a depot's `support_contact.phone` are `required` and cannot be unset. Deliberately NOT E.164-shaped, so no
 * sender, validator or lookup can ever mistake it for a reachable number.
 */
export const ANONYMISED_PHONE = 'closed';

const CLOSURE_REASON = 'role_closed';

/** What a closure ended, so the counterparties can be told (O-5). */
export interface EndedRelationships {
  contracts: { contractId: string; agentId: string; agencyId: string }[];
  connections: { connectionId: string; vendorId: string; agencyId: string }[];
}

export function countEnded(ended: EndedRelationships): number {
  return ended.contracts.length + ended.connections.length;
}

const NOTHING_ENDED = (): EndedRelationships => ({ contracts: [], connections: [] });

export interface ManifestActor {
  /** The account whose role is closing — they confirmed it. */
  userId: string;
  role: ClosableRole;
}

export class RoleClosureManifest {
  private readonly accountClosure = new AccountClosureRepository();
  private readonly fileReferences = new FileReferenceRepositoryMongo();
  private readonly productSuspension = new ProductPlatformSuspensionService();
  private readonly agencyCascade = new AdminAgencyService();

  // ─── customer ──────────────────────────────────────────────────────────────

  /** The ADR-A02 customer manifest, minus the user-scoped rows (see the header). */
  async closeCustomer(customerId: string, closedAt: Date, session: ClientSession): Promise<EndedRelationships> {
    await this.releaseFiles('customer', customerId, session);
    await this.accountClosure.anonymiseCustomer(customerId, closedAt, session);
    await this.accountClosure.deletePaymentMethods(customerId, session);
    await this.accountClosure.deleteNotifications(customerId, session);
    await this.accountClosure.clearVendorAnnotations(customerId, session);
    await CustomerNotificationPreferenceModel.deleteMany({ customerId }, { session }).exec();
    return NOTHING_ENDED();
  }

  // ─── vendor ────────────────────────────────────────────────────────────────

  async closeVendor(vendorId: string, actor: ManifestActor, closedAt: Date, session: ClientSession): Promise<EndedRelationships> {
    const store = await StoreModel.findOne({ vendor_id: vendorId }).session(session).exec();

    await this.releaseFiles('vendor', vendorId, session);
    if (store) await this.releaseFiles('store', store._id.toString(), session);

    await VendorModel.updateOne(
      { _id: vendorId },
      {
        $set: {
          status: 'inactive',
          closed_at: closedAt,
          display_name: ANONYMISED_ROLE_NAME,
          phone: ANONYMISED_PHONE,
          email_verified: false,
          phone_verified: false,
          avatar_file_id: null,
          // Emptied, never nulled: `business_addresses.location` is 2dsphere-indexed, and a
          // null inside an indexed array makes the whole document unwritable.
          business_addresses: [],
          operating_hours: [],
          payout_details: [],
          default_delivery_agency_id: null,
          'notification_preferences.email': false,
          'notification_preferences.whatsapp': false,
          'notification_preferences.phone': false,
        },
        // `$unset`, not null: `email` carries a PARTIAL unique index on `$type: 'string'`.
        // The three sub-documents fall back to their schema defaults on read.
        $unset: { email: '', kyc_details: '', social_links: '', policies: '' },
      },
      { session },
    ).exec();

    if (store) {
      await StoreModel.updateOne(
        { _id: store._id },
        {
          // `slug` is kept: it is globally unique and immutable, and freeing it would let a
          // new shop answer an old URL a customer bookmarked.
          $set: {
            name: ANONYMISED_STORE_NAME,
            description: null,
            logo_file_id: null,
            banner_file_id: null,
            support_email: null,
            support_phone: null,
            support_whatsapp: null,
            is_open: false,
          },
          $inc: { version: 1 },
        },
        { session },
      ).exec();
    }

    // Every ACTIVE product off sale, reason `vendor_suspended`. Nothing republishes them: the
    // activation gate refuses an `inactive` vendor, and the vendor restore refuses `closed_at`.
    await this.productSuspension.suspendForVendor(vendorId, { session });

    await UserPaymentMethodModel.deleteMany({ owner_role: 'vendor', owner_id: vendorId }, { session }).exec();
    await VendorNotificationModel.deleteMany({ vendorId }, { session }).exec();
    await VendorNotificationPreferenceModel.deleteMany({ vendorId }, { session }).exec();
    // OAuth tokens to the vendor's Google calendar — a live credential to their account.
    await ConnectedCalendarAccount.deleteMany({ vendorId }, { session }).exec();

    return { contracts: [], connections: await this.endConnections('vendor', vendorId, actor, closedAt, session) };
  }

  // ─── agency ────────────────────────────────────────────────────────────────

  async closeAgency(agencyId: string, actor: ManifestActor, closedAt: Date, session: ClientSession): Promise<EndedRelationships> {
    const magazin = await AgencyMagazinModel.findOne({ agency_id: agencyId }).session(session).exec();

    await this.releaseFiles('agency', agencyId, session);
    if (magazin) await this.releaseFiles('agency_magazin', magazin._id.toString(), session);

    // The admin-deactivate cascade: products whose delivery depends on this agency come off
    // sale, order items it was to carry are held for re-homing.
    await this.agencyCascade.applyDeactivationCascade(agencyId, session);

    await DeliveryAgencyModel.updateOne(
      { _id: agencyId },
      {
        $set: {
          status: 'inactive',
          closed_at: closedAt,
          display_name: ANONYMISED_ROLE_NAME,
          email_verified: false,
          phone_verified: false,
          avatar_file_id: null,
          payout_details: [],
          cod_limit_override: null,
        },
        $unset: { email: '', phone: '', kyc_details: '', policies: '' },
      },
      { session },
    ).exec();

    if (magazin) {
      await AgencyMagazinModel.updateOne(
        { _id: magazin._id },
        {
          // ⚠ `headquarters_addresses` is NOT emptied. Its subdocument `_id`s are durable
          // references (product pickup `agency_address_id`, `agency_stock_levels.location_id`,
          // historical shipments' live pickup resolution), and a depot is a business address,
          // not a personal one. Only the per-depot CONTACT is personal, and that is cleared.
          $set: {
            name: ANONYMISED_MAGAZIN_NAME,
            logo_file_id: null,
            description: null,
            support_email: null,
            support_phone: null,
            support_whatsapp: null,
            coverage_areas: [],
            // `support_contact.phone` is required on the subdocument, hence the placeholder.
            'headquarters_addresses.$[].support_contact': { phone: ANONYMISED_PHONE, email: null },
          },
          $inc: { version: 1 },
        },
        { session },
      ).exec();
    }

    await UserPaymentMethodModel.deleteMany({ owner_role: 'agency', owner_id: agencyId }, { session }).exec();
    await AgencyNotificationModel.deleteMany({ agencyId }, { session }).exec();
    await AgencyNotificationPreferenceModel.deleteMany({ agencyId }, { session }).exec();

    const contracts = await this.endContracts('agency', agencyId, actor, closedAt, session);
    const connections = await this.endConnections('agency', agencyId, actor, closedAt, session);
    return { contracts, connections };
  }

  // ─── agent ─────────────────────────────────────────────────────────────────

  async closeAgent(agentId: string, actor: ManifestActor, closedAt: Date, session: ClientSession): Promise<EndedRelationships> {
    const agent = await DeliveryAgentModel.findById(agentId).session(session).exec();
    const wasTrackingAllowed = agent?.tracking?.allowed === true;

    await this.releaseFiles('agent', agentId, session);

    // Tracking Allow OFF, and geo-tracker told in the SAME transaction (Phase 9's rule: this
    // is the one event with no reconciliation path on that side). Emitted only on a real
    // change, as `AgentTrackingPolicyService` does.
    await agentRepository.setTrackingAllowed(
      agentId,
      false,
      CLOSURE_REASON,
      { userId: actor.userId, source: 'platform', name: null, role: actor.role },
      session,
    );
    if (wasTrackingAllowed) {
      await trackingOutboxEmitter.emitTrackingAllowChanged(
        { agentId, allowed: false, reason: CLOSURE_REASON, actorRole: actor.role, occurredAt: closedAt },
        session,
      );
    }

    await DeliveryAgentModel.updateOne(
      { _id: agentId },
      {
        $set: {
          status: 'inactive',
          status_reason: CLOSURE_REASON,
          closed_at: closedAt,
          name: ANONYMISED_ROLE_NAME,
          email_verified: false,
          phone_verified: false,
          avatar_file_id: null,
          avatar_url: null,
          vehicle_info: null,
          emergency_contact: null,
          payout_details: [],
          'availability.state': 'offline',
          'availability.changed_at': closedAt,
          'availability.reason': CLOSURE_REASON,
        },
        // Sub-documents fall back to their schema defaults on read. `home_base.location` and
        // `last_known_tracking_state.last_position` are 2dsphere-indexed — removing the parent
        // keeps them out of the index rather than writing a null into it.
        $unset: {
          email: '',
          phone: '',
          legal_identity: '',
          kyc: '',
          home_base: '',
          device: '',
          last_known_tracking_state: '',
        },
      },
      { session },
    ).exec();

    await UserPaymentMethodModel.deleteMany({ owner_role: 'agent', owner_id: agentId }, { session }).exec();
    await AgentNotificationModel.deleteMany({ agentId }, { session }).exec();
    await AgentNotificationPreferenceModel.deleteMany({ agentId }, { session }).exec();

    return { contracts: await this.endContracts('agent', agentId, actor, closedAt, session), connections: [] };
  }

  // ─── the account ───────────────────────────────────────────────────────────

  /**
   * Take the role off the account, and close the account if it was the last one.
   *
   * The `$pull` is what the refresh rotation reads (`AUTH_ROLE_CLOSED`); `closed_at` on the
   * entity is what `requireAuth` reads. Both land in this transaction.
   *
   * The last-role branch is ADR-A02's account half verbatim: identifiers unset, the hash
   * replaced, `password_changed_at` stamped (revoking every token), user-scoped rows deleted.
   */
  async closeAccountIfLastRole(
    userId: string,
    role: ClosableRole,
    replacementPasswordHash: string,
    closedAt: Date,
    session: ClientSession,
  ): Promise<{ accountClosed: boolean }> {
    const user = await UserModel.findOneAndUpdate(
      { _id: userId },
      { $pull: { roles: role } },
      { new: true, session },
    ).exec();
    const remaining = (user?.roles ?? []).filter((r) => r !== 'admin');
    if (remaining.length > 0) return { accountClosed: false };

    const closed = await this.accountClosure.anonymiseUser(userId, replacementPasswordHash, closedAt, session);
    if (!closed) return { accountClosed: false };
    await this.accountClosure.deleteChannelConnections(userId, session);
    await this.accountClosure.deleteDeviceTokens(userId, session);
    return { accountClosed: true };
  }

  // ─── relationships (O-5) ───────────────────────────────────────────────────

  /**
   * End every live agent↔agency contract the closing party holds.
   *
   * `pending` → `withdrawn` (it was never agreed); `active|paused|suspended` → `deactivated`.
   * Each a compare-and-set on the status it was read in, with its event, and the open
   * status-requests and terms-proposals on it closed so no inbox keeps a dead item.
   */
  private async endContracts(
    party: 'agent' | 'agency',
    entityId: string,
    actor: ManifestActor,
    closedAt: Date,
    session: ClientSession,
  ): Promise<EndedRelationships['contracts']> {
    const field = party === 'agent' ? 'agent_id' : 'agency_id';
    const contracts = await AgentAgencyContractModel.find({
      [field]: entityId,
      status: { $in: LIVE_CONTRACT_STATUSES },
    }).session(session).exec();

    const ended: EndedRelationships['contracts'] = [];
    for (const contract of contracts) {
      const contractId = contract._id.toString();
      const agentId = contract.agent_id.toString();
      const agencyId = contract.agency_id.toString();
      const wasPrimary = contract.is_primary === true;

      const updated = contract.status === 'pending'
        ? await agentContractRepository.transition(contractId, 'pending', 'withdrawn', { withdrawn_at: closedAt }, session)
        : await agentContractRepository.transition(
          contractId,
          contract.status,
          'deactivated',
          {
            deactivated_at: closedAt,
            deactivated_by_user_id: new Types.ObjectId(actor.userId),
            deactivation_reason: CLOSURE_REASON,
            is_primary: false,
          },
          session,
        );
      if (!updated) continue;
      ended.push({ contractId, agentId, agencyId });

      await agentMembershipEventRepository.append(
        {
          membershipId: contractId,
          agentId,
          agencyId,
          type: contract.status === 'pending' ? 'withdrawn' : 'removed',
          fromStatus: contract.status,
          toStatus: updated.status,
          actorUserId: actor.userId,
          actorRole: 'system',
          reason: `${party}_${CLOSURE_REASON}`,
        },
        session,
      );

      await ContractStatusRequestModel.updateMany(
        { contract_id: contract._id, state: 'pending' },
        { $set: { state: 'cancelled', resolved_by_role: 'system', resolved_at: closedAt } },
        { session },
      ).exec();
      await ContractTermsProposalModel.updateMany(
        { contract_id: contract._id, state: 'pending' },
        { $set: { state: 'withdrawn', resolved_at: closedAt } },
        { session },
      ).exec();

      // An agent losing its primary contract because the AGENCY closed keeps working for its
      // other agencies — promote the next, as the contract service does on any deactivation.
      if (party === 'agency' && wasPrimary) {
        const next = (await agentContractRepository.listAllocating(agentId, session))
          .find((c) => c._id.toString() !== contractId && c.status === 'active');
        if (next) {
          await agentContractRepository.setPrimary(next._id.toString(), session);
          await agentMembershipEventRepository.append(
            {
              membershipId: next._id.toString(),
              agentId,
              agencyId: next.agency_id.toString(),
              type: 'primary_changed',
              actorUserId: null,
              actorRole: 'system',
              reason: 'previous primary contract ended: agency role closed',
            },
            session,
          );
        }
      }
    }
    return ended;
  }

  /**
   * End every live vendor↔agency connection the closing party holds.
   *
   * `pending` → `withdrawn`; `active|paused_reapproval` → `terminated` with reason
   * `role_closed`. The counterparty's dependent products are already off sale: a closing
   * vendor's own products were suspended above, and a closing agency's cascade suspended
   * every product delivered through it.
   */
  private async endConnections(
    party: ConnectionParty,
    entityId: string,
    actor: ManifestActor,
    closedAt: Date,
    session: ClientSession,
  ): Promise<EndedRelationships['connections']> {
    const field = party === 'vendor' ? 'vendor_id' : 'agency_id';
    const actorUserId = new Types.ObjectId(actor.userId);
    const historyEntry = (status: string) => ({
      status,
      changed_at: closedAt,
      changed_by_role: 'system',
      changed_by_user_id: actorUserId,
      note: `${party}_${CLOSURE_REASON}`,
    });

    const live = await VendorAgencyConnectionModel.find(
      { [field]: entityId, status: { $in: ['pending', 'active', 'paused_reapproval'] } },
      { _id: 1, vendor_id: 1, agency_id: 1 },
    ).session(session).lean().exec();

    await VendorAgencyConnectionModel.updateMany(
      { [field]: entityId, status: 'pending' },
      {
        $set: {
          status: 'withdrawn',
          withdrawal: { withdrawn_by_role: party, withdrawn_by_user_id: actorUserId, withdrawn_at: closedAt },
        },
        $push: { status_history: historyEntry('withdrawn') },
      },
      { session },
    ).exec();

    await VendorAgencyConnectionModel.updateMany(
      { [field]: entityId, status: { $in: ['active', 'paused_reapproval'] } },
      {
        $set: {
          status: 'terminated',
          termination: {
            terminated_by_role: party,
            terminated_by_user_id: actorUserId,
            terminated_at: closedAt,
            reason: CLOSURE_REASON,
            note: null,
          },
        },
        $unset: { reapproval_required_from: '', paused_at: '', paused_reason: '' },
        $push: { status_history: historyEntry('terminated') },
      },
      { session },
    ).exec();

    // Both writes are filtered on the statuses `live` was read in, inside this transaction,
    // so the rows read are the rows ended.
    return live.map((c) => ({
      connectionId: c._id.toString(),
      vendorId: c.vendor_id.toString(),
      agencyId: c.agency_id.toString(),
    }));
  }

  // ─── files ─────────────────────────────────────────────────────────────────

  /**
   * Detach every file reference the entity holds — avatar, logo, banner, KYC documents,
   * policy PDFs — in the transaction. Each detached file starts its orphan clock, so the
   * bytes are swept by `file-cleanup` rather than deleted here.
   */
  private async releaseFiles(entityType: FileReferenceEntityType, entityId: string, session: ClientSession): Promise<void> {
    await this.fileReferences.removeAllForEntity(entityType, entityId, { session });
  }
}

export const roleClosureManifest = new RoleClosureManifest();
