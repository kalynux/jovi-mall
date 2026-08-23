import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { UserRepository } from './user.repository';
import { AccountClosureRepository } from './account-closure.repository';
import { CustomerRepository } from '../customers/customer.repository';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../catalog/domain/services/media/FileReferenceService';
import { transactionManager } from '../../core/database/transaction.manager';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { eventBus } from '../../core/events/event-bus';
import { auditLogger } from '../../core/audit/audit-logger';

/**
 * Account closure — ADR-A02 D-1, "anonymise-and-retain".
 *
 * ── The word matters, and it is a product promise ─────────────────────────────
 * Everything this service surfaces says **close** and **anonymise**, never *delete*. ADR-A02
 * D-2 is explicit that no legal erasure obligation has been established in this market and
 * that nothing here may be described to a customer, or in a privacy policy, as satisfying
 * one. It satisfies a reasonable expectation. The two are not the same promise and the
 * second is the one that is true.
 *
 * ── What it does, in one paragraph ────────────────────────────────────────────
 * The `users` row keeps its `_id` and loses its identifiers; the customer profile keeps its
 * `_id` and loses its name, contacts, avatar, addresses and date of birth; the rows that ARE
 * identifiers are deleted; money and transactions are untouched and become pseudonymous by
 * keeping their reference to a retained id. The manifest — which collection is in which
 * group and why — lives in `AccountClosureRepository`, in one place on purpose.
 *
 * ── Three refusals, and why each is a refusal rather than a cascade ───────────
 * 1. **A dual-role account** is refused outright (ADR-A02 D-1). Anonymising the person
 *    behind a live storefront leaves a shop trading under a name nobody can resolve.
 * 2. **Orders in flight** are refused. This one is NOT in the ADR and is the one judgement
 *    call added here: closure clears `Customer.phone`, which is where
 *    `CashCollectionService.notifyCodeIssued` sends the COD delivery code, and deletes the
 *    messaging connections that carry every other delivery notification — so closing
 *    mid-delivery does not merely lose contact, it strands a parcel an agent is holding.
 * 3. **An account that is not `active`** is refused by the compare-and-set, so a second
 *    closure request cannot re-run the cascade over an already-anonymous account.
 *
 * ── Irreversible, and nothing here pretends otherwise ─────────────────────────
 * There is no un-close verb and there cannot be one: the identifiers are gone, not archived.
 * `AdminUserService.restore` compare-and-sets from `suspended`, so it misses a closed row and
 * answers 409 — which is why `closed` is a third status rather than a reuse of `suspended`.
 */
export class AccountClosureService {
  private userRepo: UserRepository;
  private closureRepo: AccountClosureRepository;
  private customerRepo: CustomerRepository;
  private fileReferenceService: FileReferenceService;

  constructor() {
    this.userRepo = new UserRepository();
    this.closureRepo = new AccountClosureRepository();
    this.customerRepo = new CustomerRepository();
    this.fileReferenceService = new FileReferenceService(
      new FileRepositoryMongo(),
      new FileReferenceRepositoryMongo(),
    );
  }

  /**
   * Close the caller's own account.
   *
   * @param userId      the account, from `req.auth` — never from the body
   * @param customerId  the caller's customer profile id, from `req.auth.role_entity`
   */
  async close(userId: string, customerId: string): Promise<{ closedAt: Date }> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);

    /**
     * Refusal 1 — every role beyond `customer`.
     *
     * Phrased as "anything that is not customer" rather than "vendor", so an account holding
     * `agency` or `agent` is refused too. Those are not what ADR-A02 had in mind, and that is
     * the point: an agent carries a COD liability balance and a contract with an agency, and
     * neither has a self-service close. `details.blockingRoles` names them so a client can
     * say which one.
     */
    const blockingRoles = (user.roles ?? []).filter((role) => role !== 'customer');
    if (blockingRoles.length > 0) {
      throw createAppError(ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE, 422, undefined, {
        blockingRoles,
      });
    }

    const customer = await this.customerRepo.findById(customerId);
    if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

    // Refusal 2 — anything still moving. Counted BEFORE the transaction opens: it is a read
    // that decides whether to start at all, and holding it inside would keep a transaction
    // open across a count over the platform's largest collection for no gain.
    const activeOrderCount = await this.closureRepo.countActiveOrders(customerId);
    if (activeOrderCount > 0) {
      throw createAppError(ERROR_CODES.ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT, 422, undefined, {
        activeOrderCount,
      });
    }

    /**
     * The avatar's `file_references` row, detached BEFORE the transaction.
     *
     * `FileReferenceService.reconcile` takes no session — it is the same primitive the
     * profile update uses — so it cannot join the write below. Doing it first is the
     * survivable order: a failure here aborts before anything is anonymised, whereas
     * detaching after a committed closure would leave a reference to an avatar the profile
     * no longer names, protecting a file from cleanup forever. The reverse ordering fails
     * the other way and would be silent.
     */
    if (customer.avatar_file_id) {
      await this.fileReferenceService.reconcile({
        previousFileIds: [customer.avatar_file_id.toString()],
        nextFileIds: [],
        actor: { type: 'customer', id: customerId },
        entityType: 'customer',
        entityId: customerId,
        field: 'avatar',
      });
    }

    /**
     * An unguessable replacement for the stored hash.
     *
     * Hashed outside the transaction — bcrypt at cost 12 takes a couple of hundred
     * milliseconds, and that is not time to hold a transaction open. The plaintext is
     * discarded the moment the digest exists; nobody, including this process, ever holds it
     * again.
     */
    const replacementHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const closedAt = new Date();

    const counts = await transactionManager.runInTransaction(async (session) => {
      // Refusal 3, and the ordering guard for concurrent requests: this is the compare-and-set
      // on `active`. Everything after it runs exactly once per account.
      const closed = await this.closureRepo.anonymiseUser(
        userId,
        replacementHash,
        closedAt,
        session,
      );
      if (!closed) {
        throw createAppError(
          ERROR_CODES.USER_STATUS_CONFLICT,
          409,
          'This account is not active — it may already have been closed',
          { expected: 'active' },
        );
      }

      await this.closureRepo.anonymiseCustomer(customerId, session);

      const channelConnections = await this.closureRepo.deleteChannelConnections(userId, session);
      const deviceTokens = await this.closureRepo.deleteDeviceTokens(userId, session);
      const paymentMethods = await this.closureRepo.deletePaymentMethods(customerId, session);
      const notifications = await this.closureRepo.deleteNotifications(customerId, session);
      const vendorRelationships = await this.closureRepo.clearVendorAnnotations(customerId, session);

      return {
        channelConnections,
        deviceTokens,
        paymentMethods,
        notifications,
        vendorRelationships,
      };
    });

    /**
     * Post-commit, and deliberately after: an event announcing a closure that rolled back is
     * worse than a late one. Both of these are best-effort by construction — the audit
     * adapter persists only `role: 'admin'` rows today, so this one is a console line, the
     * same as every other self-service write in the service.
     */
    await eventBus.publish('user.account.closed', {
      eventType: 'user.account.closed',
      aggregateId: userId,
      payload: { userId, customerId, closedAt: closedAt.toISOString(), ...counts },
      occurredAt: closedAt,
    });

    await auditLogger.log({
      actor: { userId, role: 'customer' },
      action: 'ACCOUNT_CLOSED',
      resource: { type: 'User', id: userId },
      // No `before`. The whole point is that the identifiers are gone; writing them into an
      // audit row would re-create the record the closure just removed, in a place with no
      // retention owner.
      metadata: { customerId, closedAt, ...counts },
      timestamp: closedAt,
    });

    return { closedAt };
  }
}
