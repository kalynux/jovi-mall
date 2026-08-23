import { ClientSession } from 'mongoose';
import { UserModel, IUser } from './user.model';
import { CustomerModel } from '../customers/customer.model';
import { ChannelConnectionModel } from '../channel-connections/channel-connection.model';
import { UserPaymentMethodModel } from '../payment-methods/models/user-payment-method.model';
import { CustomerNotificationModel } from '../notifications/models/customer-notification.model';
import { DeviceTokenModel } from '../notifications/models/device-token.model';
import { VendorCustomerModel } from '../vendors/models/vendor-customer.model';
import { OrderModel, FulfillmentStatus } from '../orders/order.model';

/**
 * Account closure — the write half. ONE FILE, on purpose.
 *
 * ── Why the manifest is not spread across seven repositories ──────────────────
 * Every other cross-collection write in this service goes through the owning module's
 * repository, and that is the right default. Closure is the exception, because the property
 * that matters here is not "each collection is written by its owner" but **"every collection
 * that holds a customer identifier is named in one place"**. A manifest split across seven
 * files is a manifest nobody can audit, and the failure mode is silent: a collection added
 * next year that stores a name or a phone number is simply not anonymised, and nothing says
 * so. `test:account-closure` scans THIS file for that reason.
 *
 * The house already does this where the same argument applies — `cash-collection.service.ts`
 * reaches `CustomerModel` and `OrderModel` directly.
 *
 * ── The three verbs, and why they differ ──────────────────────────────────────
 * Rows fall into exactly three groups, and which group a collection is in is a decision
 * about what the row IS, not about how much data it holds:
 *
 *   ANONYMISE  the row is a record something else points at — it keeps its `_id` and loses
 *              its identifiers. `users` and `customers`.
 *   DELETE     the row IS an identifier, or an address to reach the person on. Keeping it
 *              anonymised would keep exactly the part that identifies them, and in two cases
 *              would go on delivering to them: `channel_connections`, `device_tokens`,
 *              `user_payment_methods`, `customer_notifications`.
 *   UNTOUCHED  money and transactions. Orders, shipments, cash collections, earnings,
 *              payouts, refunds, bookings, entitlements and tickets keep their reference to
 *              the retained `_id` and become pseudonymous by construction — none of them
 *              snapshots a name, an email or a phone number (verified, 2026-08-21). ADR-A02
 *              D-1: money records "are not the customer's personal data to remove, and
 *              removing them would corrupt somebody else's balance".
 *
 * `vendor_customers` is the one row that is in two groups at once, and it gets a partial
 * write — see `clearVendorAnnotations`.
 */

/** Replaces `Customer.name`, which the schema requires and so cannot be unset. */
export const ANONYMISED_CUSTOMER_NAME = 'Closed account';

/**
 * Orders that are still moving. A customer with one of these cannot close yet.
 *
 * Derived by exclusion from `FulfillmentStatus` rather than listed positively, so a status
 * added later is treated as "in flight" until somebody deliberately says otherwise — the
 * safe direction, since the cost of the wrong answer here is an undeliverable parcel.
 */
const SETTLED_FULFILMENT: readonly FulfillmentStatus[] = ['fulfilled', 'cancelled', 'returned'];

export interface ClosureCounts {
  channelConnections: number;
  deviceTokens: number;
  paymentMethods: number;
  notifications: number;
  vendorRelationships: number;
}

export class AccountClosureRepository {
  /**
   * How many of this customer's orders are still moving.
   *
   * Two clauses, because "in flight" has two meanings that do not imply each other: an order
   * still being fulfilled needs the customer reachable, and an order under a dispute hold
   * needs them answerable. `$or` rather than two queries so the count is one round trip and
   * cannot disagree with itself.
   */
  async countActiveOrders(customerId: string, session?: ClientSession): Promise<number> {
    return await OrderModel.countDocuments({
      customer_id: customerId,
      $or: [
        { fulfillment_status: { $nin: SETTLED_FULFILMENT } },
        { 'dispute_hold.active': true },
      ],
    })
      .session(session ?? null)
      .exec();
  }

  /**
   * Strip the account row's identifiers and close it — guarded on `active`.
   *
   * A compare-and-set for the same reason `applyStatusChangeIfCurrent` is one, with a sharper
   * consequence: two closure requests racing would otherwise both run the whole cascade, and
   * the second would emit a second audit trail for an account that was already anonymous.
   * A miss returns null and the caller raises `USER_STATUS_CONFLICT`.
   *
   * ── `$unset` rather than `$set: null` ────────────────────────────────────────
   * `login_email` and `login_phone` carry SPARSE unique indexes, so a null is a value as far
   * as the index is concerned and two closed accounts would collide on it. Removing the
   * fields keeps them out of the index entirely — the same rule `UserRepository.updateContact`
   * follows, and here it also frees the email and the phone number for a future account.
   *
   * ── The password hash is REPLACED, not kept ──────────────────────────────────
   * ADR-A02 D-1 closes the credential path with `status` and `password_changed_at`, and both
   * are written here. The hash goes too because it is a credential derived from the person:
   * it is offline-crackable at leisure and no longer has any use. The caller passes an
   * unguessable replacement rather than an empty string — `password_hash` is `required`, and
   * a value that is not a bcrypt digest makes every later `bcrypt.compare` return false
   * rather than throw.
   */
  async anonymiseUser(
    userId: string,
    replacementPasswordHash: string,
    closedAt: Date,
    session: ClientSession,
  ): Promise<IUser | null> {
    return await UserModel.findOneAndUpdate(
      { _id: userId, status: 'active' },
      {
        $set: {
          status: 'closed',
          closed_at: closedAt,
          password_hash: replacementPasswordHash,
          // The revocation. Every access token and refresh cookie minted before this instant
          // is refused on sight — see `core/auth/password-epoch.ts`.
          password_changed_at: closedAt,
        },
        $unset: { login_email: '', login_phone: '' },
      },
      { new: true, session },
    );
  }

  /**
   * Strip the customer profile.
   *
   * `name` is replaced rather than unset because the schema requires it and every reader —
   * the vendor's order list, the ticket thread, the admin screen — renders it. A placeholder
   * that says what happened is better than a crash or an empty string somewhere downstream.
   *
   * `preferences` survives except for `marketing_opt_in`: a language and a currency identify
   * nobody, and consent to be marketed at does not survive the account it was given on.
   * `timezone` likewise stays — it is a rendering default, not a location.
   */
  async anonymiseCustomer(customerId: string, session: ClientSession): Promise<void> {
    await CustomerModel.updateOne(
      { _id: customerId },
      {
        $set: {
          name: ANONYMISED_CUSTOMER_NAME,
          email_verified: false,
          phone_verified: false,
          avatar_file_id: null,
          avatar_url: null,
          bio: null,
          saved_addresses: [],
          date_of_birth: null,
          // The deprecated embedded array. Emptied beside the live store below, or a closed
          // account keeps a masked instrument on a field the profile no longer reads.
          saved_payment_methods: [],
          recent_product_code: null,
          status: 'inactive',
          'preferences.marketing_opt_in': false,
        },
        $unset: { email: '', phone: '' },
      },
      { session },
    ).exec();
  }

  /**
   * Delete every messaging identity bound to the account.
   *
   * These rows ARE the identifier — `external_id` is a WhatsApp phone id or a Telegram chat
   * id — so anonymising one would leave exactly the part that identifies the person.
   * Deleting also releases the `{channel, external_id}` unique index, so the same person may
   * connect the same number to a new account later.
   */
  async deleteChannelConnections(userId: string, session: ClientSession): Promise<number> {
    const result = await ChannelConnectionModel.deleteMany({ user_id: userId }, { session }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Delete the push registrations. A device token is a live address for the person's phone;
   * keeping it means a closed account can still be pushed to.
   */
  async deleteDeviceTokens(userId: string, session: ClientSession): Promise<number> {
    const result = await DeviceTokenModel.deleteMany({ userId }, { session }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Delete the saved instruments.
   *
   * NOT a money record: these are gateway-side references plus a `holder_name` and a masked
   * label, and nothing is settled against them. Deleting is also what stops a closed account
   * being chargeable.
   */
  async deletePaymentMethods(customerId: string, session: ClientSession): Promise<number> {
    const result = await UserPaymentMethodModel.deleteMany(
      { owner_role: 'customer', owner_id: customerId },
      { session },
    ).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Delete the in-app notification history.
   *
   * `title` and `message` are rendered prose that routinely carries the person's name and
   * their order details, and the only reader is an account that can no longer sign in. There
   * is nothing here to keep and no one left to keep it for.
   */
  async deleteNotifications(customerId: string, session: ClientSession): Promise<number> {
    const result = await CustomerNotificationModel.deleteMany(
      { customerId },
      { session },
    ).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Clear the vendor's private name for this customer, and keep everything else.
   *
   * The one partial write in the manifest, and the split is deliberate. `display_name_override`
   * is a NAME — the most visible place the person survives, since it is what the vendor's
   * customer list literally prints — so leaving it would make the anonymisation promise false
   * in the place a vendor would notice first. The rest of the row (`order_count`,
   * `total_spent`, `last_order_at`, `flag_ids`) is the vendor's own business record of a
   * trading relationship, which ADR-A02 D-1 keeps for exactly the reason it keeps the orders.
   */
  async clearVendorAnnotations(customerId: string, session: ClientSession): Promise<number> {
    const result = await VendorCustomerModel.updateMany(
      { customer_id: customerId, display_name_override: { $ne: null } },
      { $set: { display_name_override: null } },
      { session },
    ).exec();
    return result.modifiedCount ?? 0;
  }
}
