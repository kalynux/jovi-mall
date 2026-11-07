/**
 * verify:referrals — the referral program end to end against REAL Mongo. **NEEDS a REPLICA SET**
 * (every step runs a transaction).
 *
 * `test:referrals` proves the rules. This proves the CHAIN, through the real services and the real
 * nightly sweep, so a hop that was never wired fails here:
 *
 *   1. Off by default: nobody applies, and a code does nothing.
 *   2. Apply → approve → a code; a pending or suspended partner's code is ignored.
 *   3. One referrer per person, enforced by the database.
 *   4. A commission released by the sweep pays each referred participant, once.
 *   5. The wait, then available.
 *   6. A partial refund, then a full one, bring the rewards down with the commission.
 *   7. Withdrawal: the minimum, the destination, the frozen balance.
 *   8. A refund after withdrawal leaves debt, which the next reward pays first.
 *   9. Expiry, suspension, COD, two agencies, bookings, and what is not a commission.
 *  10. The three doors a code arrives through: the web form, WhatsApp and Telegram. Telegram's needs
 *      Redis, because the code waits there for the contact share; without Redis that part says so
 *      and is skipped.
 *
 * ⚠ Refuses anything but a local Mongo, and works in its own database, which it drops: it writes
 * real money rows, and CI's later suites count rows in the shared one.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/x?replicaSet=rs0 npm run verify:referrals
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { OrderModel } from '../../src/modules/orders/order.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { Booking } from '../../src/modules/booking/models/booking.model';
import { EarningsAllocationModel, EarningsSourceType } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsAccountModel, EarningsOwnerType } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { EarningsAdjustmentModel } from '../../src/modules/earnings/models/earnings-adjustment.model';
import { PayoutRequestModel } from '../../src/modules/earnings/models/payout-request.model';
import { earningsAccountService } from '../../src/modules/earnings/services/earnings-account.service';
import { earningsClawbackService } from '../../src/modules/earnings/services/earnings-clawback.service';
import { payoutRequestService } from '../../src/modules/earnings/services/payout-request.service';
import { earningsReleaseWorker } from '../../src/modules/earnings/workers/earnings-release.worker';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ReferralPartnerModel } from '../../src/modules/referrals/models/referral-partner.model';
import { ReferralRelationshipModel } from '../../src/modules/referrals/models/referral-relationship.model';
import { ReferralRewardModel } from '../../src/modules/referrals/models/referral-reward.model';
import { ReferralSettingsModel } from '../../src/modules/referrals/models/referral-settings.model';
import { referralAttributionService } from '../../src/modules/referrals/services/referral-attribution.service';
import { referralPartnerService } from '../../src/modules/referrals/services/referral-partner.service';
import { referralPayoutService } from '../../src/modules/referrals/services/referral-payout.service';
import { referralRewardService } from '../../src/modules/referrals/services/referral-reward.service';
import { referralSettingsService } from '../../src/modules/referrals/services/referral-settings.service';
import { parseReferralCodeFromMessage, referralTelegramStart, referralWhatsappText } from '../../src/modules/referrals/domain/referral-rules';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RegisterSchema } from '../../src/modules/auth/auth.schemas';
import { BotRegistrationService } from '../../src/modules/bot-surface/services/bot-registration.service';
import { peekRedisClient, getRedisClient, BOT_SURFACE_DB } from '../../src/infra/redis/redis.factory';

const out = console.log.bind(console);
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    out(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, detail ?? '');
    failed++;
  }
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `THROW: ${(error as Error).message}`;
  }
}

const ADMIN = { userId: new Types.ObjectId().toString(), source: 'admin' as const, name: 'Ada Admin' };
const DAY = 86_400_000;

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+23767${String(1000000 + phoneSeq)}`;
}

async function makeUser(role: string): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  await UserModel.collection.insertOne({
    _id,
    login_phone: nextPhone(),
    password_hash: 'x',
    roles: [role],
    status: 'active',
    created_at: new Date(),
  });
  return _id;
}

async function makeCustomer(name = 'Carine Customer'): Promise<{ userId: Types.ObjectId; id: Types.ObjectId }> {
  const userId = await makeUser('customer');
  const id = new Types.ObjectId();
  await CustomerModel.collection.insertOne({ _id: id, user_id: userId, name, created_at: new Date() });
  return { userId, id };
}

async function makeVendor(name = 'Vera Vendor'): Promise<{ userId: Types.ObjectId; id: Types.ObjectId }> {
  const userId = await makeUser('vendor');
  const id = new Types.ObjectId();
  await VendorModel.collection.insertOne({ _id: id, user_id: userId, display_name: name, created_at: new Date() });
  return { userId, id };
}

async function makeAgency(name = 'Alpha Agency'): Promise<{ userId: Types.ObjectId; id: Types.ObjectId }> {
  const userId = await makeUser('agency');
  const id = new Types.ObjectId();
  await DeliveryAgencyModel.collection.insertOne({ _id: id, user_id: userId, display_name: name, created_at: new Date() });
  return { userId, id };
}

async function makePartner(name: string): Promise<string> {
  const { userId } = await makeCustomer(name);
  const partner = await referralPartnerService.apply(userId.toString(), 'customer', {});
  const approved = await referralPartnerService.transition(partner._id.toString(), 'approve', ADMIN, null);
  return approved._id.toString();
}

async function codeOf(partnerId: string): Promise<string> {
  return (await ReferralPartnerModel.findById(partnerId).lean())!.code as string;
}

async function refer(partnerId: string, userId: Types.ObjectId, category: 'vendor' | 'customer' | 'agency' | 'agent', registeredAt?: Date): Promise<void> {
  await referralAttributionService.attach({
    userId: userId.toString(),
    category,
    code: await codeOf(partnerId),
    channel: 'web',
    registeredAt,
  });
}

/** A vendor row and a platform row, held the real way, due for release on the next sweep. */
async function splitDue(
  sourceType: EarningsSourceType,
  sourceId: Types.ObjectId,
  vendorId: Types.ObjectId,
  gross: number,
  commission: number,
  dueAt: Date,
  options: { cashSettledAt?: Date; extra?: Array<{ type: EarningsOwnerType; amount: number }> } = {}
): Promise<void> {
  const rows: Array<{ beneficiary_type: EarningsOwnerType; beneficiary_id: Types.ObjectId | null; amount: number }> = [
    { beneficiary_type: 'vendor', beneficiary_id: vendorId, amount: gross - commission },
    { beneficiary_type: 'platform', beneficiary_id: null, amount: commission },
    ...(options.extra ?? []).map((row) => ({ beneficiary_type: row.type, beneficiary_id: null, amount: row.amount })),
  ];
  await transactionManager.runInTransaction(async (session) => {
    for (const row of rows) {
      const [doc] = await EarningsAllocationModel.create(
        [
          {
            source_type: sourceType,
            source_id: sourceId,
            ...row,
            gross_snapshot: gross,
            commission_percent_snapshot: 7,
            currency: 'XAF',
            status: 'held',
            completed_at: new Date(dueAt.getTime() - 3 * DAY),
            hold_release_at: dueAt,
            requires_cash_settlement: !!options.cashSettledAt,
            cash_settled_at: options.cashSettledAt ?? null,
          },
        ],
        { session }
      );
      await earningsAccountService.holdInSession(doc, session);
    }
  });
}

async function makeOrder(
  vendorId: Types.ObjectId,
  customerId: Types.ObjectId,
  gross: number,
  shipments: Array<{ agencyId: Types.ObjectId; status: string; value: number }>
): Promise<Types.ObjectId> {
  const orderId = new Types.ObjectId();
  const items = shipments.map((s) => ({ _id: new Types.ObjectId(), price: s.value, quantity: 1 }));
  await OrderModel.collection.insertOne({
    _id: orderId,
    vendor_id: vendorId,
    customer_id: customerId,
    order_number: `VR-${orderId.toString().slice(-6)}`,
    order_type: 'physical',
    payment_method: 'online',
    currency: 'XAF',
    total_amount: gross,
    price_breakdown: { subtotal: gross, delivery: 0 },
    items,
    created_at: new Date(),
  });
  for (let i = 0; i < shipments.length; i++) {
    await ShipmentModel.collection.insertOne({
      _id: new Types.ObjectId(),
      order_id: orderId,
      agency_id: shipments[i].agencyId,
      status: shipments[i].status,
      items: [{ order_item_id: items[i]._id, quantity: 1 }],
      created_at: new Date(),
    });
  }
  return orderId;
}

async function wallet(partnerId: string): Promise<{ pending: number; available: number; requested: number; clawback: number }> {
  const account = await EarningsAccountModel.findOne({ owner_type: 'referral_partner', owner_id: partnerId }).lean();
  return {
    pending: account?.pending_balance ?? 0,
    available: account?.available_balance ?? 0,
    requested: account?.requested_balance ?? 0,
    clawback: account?.clawback_balance ?? 0,
  };
}

/** The real nightly sweep, as the worker runs it. */
async function sweep(): Promise<void> {
  await earningsReleaseWorker.runSweep(new Date(Date.now() + 60_000));
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI ?? '';
  if (!/127\.0\.0\.1|localhost/.test(uri)) {
    console.error('Refusing to run against anything but a local Mongo: this suite writes real money rows.');
    process.exit(1);
  }
  await mongoose.connect(uri, { dbName: 'verify_referrals' });
  await mongoose.connection.dropDatabase();
  for (const model of [
    UserModel, CustomerModel, VendorModel, DeliveryAgencyModel, OrderModel, ShipmentModel, CashCollectionModel, Booking,
    EarningsAllocationModel, EarningsAccountModel, EarningsLedgerModel, EarningsAdjustmentModel, PayoutRequestModel,
    ReferralPartnerModel, ReferralRelationshipModel, ReferralRewardModel, ReferralSettingsModel,
  ]) {
    await (model as typeof UserModel).createCollection();
    await (model as typeof UserModel).syncIndexes();
  }

  const now = Date.now();

  // ── 1 ──────────────────────────────────────────────────────────────────────────────
  out('\n1. Off by default');
  const applicant = await makeCustomer('Ulrich Mbarga');
  check('nobody may apply', (await refusalOf(() => referralPartnerService.apply(applicant.userId.toString(), 'customer', {}))) === ERROR_CODES.REFERRAL_PROGRAM_DISABLED);
  await referralSettingsService.update({ enabled: true }, ADMIN);
  const settings = await referralSettingsService.get();
  check('the defaults are 3%, 6 months, 1,000 FCFA and a 14-day wait',
    settings.terms.vendor.rate_percent === 3 && settings.terms.customer.duration_months === 6 && settings.minPayoutAmount === 1_000 && settings.rewardWaitDays === 14);

  // ── 2 ──────────────────────────────────────────────────────────────────────────────
  out('\n2. Apply and approve');
  const applied = await referralPartnerService.apply(applicant.userId.toString(), 'customer', { motivation: 'I know many shops' });
  const ulrich = applied._id.toString();
  check('an application is pending, with no code', applied.status === 'pending' && applied.code === null);
  check('applying twice is refused', (await refusalOf(() => referralPartnerService.apply(applicant.userId.toString(), 'customer', {}))) === ERROR_CODES.REFERRAL_ALREADY_APPLIED);
  check('a pending partner cannot be suspended', (await refusalOf(() => referralPartnerService.transition(ulrich, 'suspend', ADMIN, 'x'))) === ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT);
  const approved = await referralPartnerService.transition(ulrich, 'approve', ADMIN, null);
  check('approval gives a code built from the name', approved.status === 'active' && /^ULRICH\d{3}$/.test(approved.code ?? ''), approved.code);
  check('the history records who approved', approved.status_history.at(-1)?.actor_name === 'Ada Admin' && approved.status_history.at(-1)?.to === 'active');
  check('approving twice is refused', (await refusalOf(() => referralPartnerService.transition(ulrich, 'approve', ADMIN, null))) === ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT);

  // ── 3 ──────────────────────────────────────────────────────────────────────────────
  out('\n3. One referrer per person');
  const vendor = await makeVendor();
  const customer = await makeCustomer();
  const agency = await makeAgency();
  const david = await makePartner('David Partner');
  await refer(ulrich, vendor.userId, 'vendor');
  await refer(ulrich, customer.userId, 'customer');
  await refer(ulrich, agency.userId, 'agency');
  check('three relationships are recorded', (await ReferralRelationshipModel.countDocuments({ partner_id: ulrich })) === 3);
  await refer(david, vendor.userId, 'vendor');
  const vendorRel = await ReferralRelationshipModel.findOne({ referred_user_id: vendor.userId }).lean();
  check('a second link cannot change the referrer', vendorRel?.partner_id.toString() === ulrich && (await ReferralRelationshipModel.countDocuments({ referred_user_id: vendor.userId })) === 1);
  check('the database itself refuses a second row', await (async () => {
    try {
      await ReferralRelationshipModel.create({ partner_id: david, partner_user_id: new Types.ObjectId(), referred_user_id: vendor.userId, category: 'vendor', code_used: 'DAVID123', channel: 'web', registered_at: new Date() });
      return false;
    } catch (error) {
      return (error as { code?: number }).code === 11000;
    }
  })());
  const garbage = await makeCustomer();
  await referralAttributionService.attach({ userId: garbage.userId.toString(), category: 'customer', code: 'NOPE9999', channel: 'web' });
  check('an unknown code simply records nothing', (await ReferralRelationshipModel.countDocuments({ referred_user_id: garbage.userId })) === 0);
  check('the expiry was fixed at registration', !!vendorRel?.expires_at && vendorRel.expires_at.getTime() > now);

  // ── 4 ──────────────────────────────────────────────────────────────────────────────
  out('\n4. A commission pays each referred participant, once');
  const order1 = await makeOrder(vendor.id, customer.id, 100_000, [{ agencyId: agency.id, status: 'delivered', value: 100_000 }]);
  await splitDue('order', order1, vendor.id, 100_000, 7_000, new Date(), { extra: [{ type: 'platform_ai', amount: 500 }] });
  await sweep();
  const rewards1 = await ReferralRewardModel.find({ order_id: order1 }).lean();
  check('example 2: three rewards of 210', rewards1.length === 3 && rewards1.every((r) => r.amount === 210 && r.status === 'held'), rewards1.map((r) => r.amount));
  check('all three categories are present', new Set(rewards1.map((r) => r.category)).size === 3);
  check('the rewards wait in pending', (await wallet(ulrich)).pending === 630);
  const commissionRow = await EarningsAllocationModel.findOne({ source_id: order1, beneficiary_type: 'platform' }).lean();
  check('the commission itself is untouched: 7,000', commissionRow?.amount === 7_000 && commissionRow?.status === 'released');
  check('and it is marked as judged', !!commissionRow?.referral_evaluated_at);
  const bargainRow = await EarningsAllocationModel.findOne({ source_id: order1, beneficiary_type: 'platform_ai' }).lean();
  check('the bargain fee paid nothing and is never marked', bargainRow?.status === 'released' && !bargainRow?.referral_evaluated_at);
  check('the ledger explains the money', (await EarningsLedgerModel.countDocuments({ owner_type: 'referral_partner', reason_code: 'referral_reward' })) === 3);
  await sweep();
  check('a second sweep pays nothing more', (await ReferralRewardModel.countDocuments({ order_id: order1 })) === 3 && (await wallet(ulrich)).pending === 630);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────
  out('\n5. The wait');
  await referralRewardService.releaseMaturedRewards(new Date(now), 50);
  check('not available before the wait ends', (await wallet(ulrich)).available === 0);
  await referralRewardService.releaseMaturedRewards(new Date(now + 15 * DAY), 50);
  check('available once it ends', (await wallet(ulrich)).available === 630 && (await wallet(ulrich)).pending === 0);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────
  out('\n6. Refunds');
  await earningsClawbackService.applyRefund({ refundKey: 'verify-refund-1', target: { kind: 'order', id: order1.toString() }, attribution: { goods: 50_000, delivery: 0 } });
  const afterPartial = await EarningsAllocationModel.findOne({ source_id: order1, beneficiary_type: 'platform' }).lean();
  const retained = afterPartial!.amount - afterPartial!.clawed_amount;
  const partialRewards = await ReferralRewardModel.find({ order_id: order1 }).lean();
  const expected = Math.floor((retained * 3) / 100);
  check('a partial refund reduces the commission', retained > 0 && retained < 7_000, retained);
  check('each reward follows it, at the saved rate', partialRewards.every((r) => r.amount - r.clawed_amount === expected), { retained, expected, got: partialRewards.map((r) => r.amount - r.clawed_amount) });
  check('the original amount and the adjustment are on the record', partialRewards.every((r) => r.amount === 210 && r.adjustments.length === 1 && r.adjustments[0].refund_key === 'verify-refund-1'));
  check('the money left the wallet', (await wallet(ulrich)).available === expected * 3);
  check('the mark was cleared after the commit', !afterPartial?.referral_resync);
  check('syncing again changes nothing', (await referralRewardService.syncCommission(afterPartial!._id as Types.ObjectId)) === 0);

  // Every share gives back what it still has, the way a lost dispute does.
  await earningsClawbackService.reverseRemaining({ kind: 'order', id: order1.toString() }, 'dispute:verify-1');
  const reversed = await ReferralRewardModel.find({ order_id: order1 }).lean();
  check('a full reversal reverses the rewards', reversed.every((r) => r.status === 'reversed' && r.amount - r.clawed_amount === 0), reversed.map((r) => [r.status, r.clawed_amount]));
  check('and they stay on the record', reversed.length === 3 && (await wallet(ulrich)).available === 0);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────
  out('\n7. Withdrawal');
  const partnerDoc = async () => (await ReferralPartnerModel.findById(ulrich))!;
  const order2 = await makeOrder(vendor.id, customer.id, 100_000, [{ agencyId: agency.id, status: 'delivered', value: 100_000 }]);
  await splitDue('order', order2, vendor.id, 100_000, 7_000, new Date());
  await referralSettingsService.update({ terms: { vendor: { ratePercent: 25 } } }, ADMIN);
  await referralRewardService.evaluateReleasedCommissions(new Date(now), 50);
  await sweep();
  await referralRewardService.releaseMaturedRewards(new Date(now + 15 * DAY), 50);
  const order2Rewards = await ReferralRewardModel.find({ order_id: order2 }).lean();
  const vendorReward = order2Rewards.find((r) => r.category === 'vendor');
  check('a global rate change reaches active referrals: 25% of 7,000', vendorReward?.amount === 1_750 && vendorReward?.rate_source === 'global', vendorReward?.amount);
  check('a later change does not touch earned rewards', (await ReferralRewardModel.findById(rewards1[0]._id).lean())?.rate_percent === 3);
  await referralSettingsService.update({ terms: { vendor: { ratePercent: 3 } } }, ADMIN);
  const balance = (await wallet(ulrich)).available;
  check('the balance is available', balance === 1_750 + 420, balance);

  check('no destination, no payout', (await refusalOf(async () => referralPayoutService.request(await partnerDoc(), applicant.userId.toString()))) === ERROR_CODES.EARNINGS_PAYOUT_METHOD_MISSING);
  const method = { method: 'mobile_money', mobile_money: { provider: 'mtn', phone_number: '+237672745831', account_name: 'Ulrich Mbarga' } } as any;
  const withMethod = await referralPayoutService.setOwnDestination(await partnerDoc(), method);
  check('a customer sets their own destination', withMethod.payout_details[0].mobile_money?.phone_number === '+237672745831');

  const payout = await referralPayoutService.request(await partnerDoc(), applicant.userId.toString());
  check('a withdrawal moves the whole balance', payout.amount === balance && (await wallet(ulrich)).requested === balance && (await wallet(ulrich)).available === 0);
  check('it uses the existing pipeline, with a ticket', !!payout.ticket_id && payout.owner_type === 'referral_partner');
  check('a second one is refused while it waits', (await refusalOf(async () => referralPayoutService.request(await partnerDoc(), applicant.userId.toString()))) === ERROR_CODES.EARNINGS_PAYOUT_ALREADY_PENDING);
  await payoutRequestService.markPaid(payout.id, ADMIN, 'verify');
  check('paying it empties the earmark', (await wallet(ulrich)).requested === 0);

  const vendorOwner = await makeVendor('Paul Owner');
  await VendorModel.collection.updateOne({ _id: vendorOwner.id }, { $set: { payout_details: [method] } });
  const paul = await referralPartnerService.apply(vendorOwner.userId.toString(), 'vendor', {});
  check("a vendor's existing destination cannot be replaced from the page", (await refusalOf(() => referralPayoutService.setOwnDestination(paul, method))) === ERROR_CODES.REFERRAL_PAYOUT_METHOD_MANAGED_ELSEWHERE);

  // ── 8 ──────────────────────────────────────────────────────────────────────────────
  out('\n8. A refund after withdrawal');
  await earningsClawbackService.reverseRemaining({ kind: 'order', id: order2.toString() }, 'dispute:verify-2');
  const owed = await wallet(ulrich);
  check('what was already paid out becomes debt', owed.clawback === balance && owed.available === 0, owed);
  const order3 = await makeOrder(vendor.id, customer.id, 1_000_000, [{ agencyId: agency.id, status: 'delivered', value: 1_000_000 }]);
  await splitDue('order', order3, vendor.id, 1_000_000, 70_000, new Date());
  await sweep();
  await referralRewardService.releaseMaturedRewards(new Date(now + 15 * DAY), 50);
  const netted = await wallet(ulrich);
  check('the next rewards pay the debt first', netted.clawback === 0 && netted.available === 3 * 2_100 - balance, netted);
  check('the recovery is in the ledger', (await EarningsLedgerModel.countDocuments({ owner_type: 'referral_partner', entry_type: 'clawback_recovery' })) > 0);

  // ── 9 ──────────────────────────────────────────────────────────────────────────────
  out('\n9. Who does not earn, and the other sources');
  const lateCustomer = await makeCustomer('Late Customer');
  await refer(ulrich, lateCustomer.userId, 'customer', new Date(now - 200 * DAY));
  const order4 = await makeOrder(vendor.id, lateCustomer.id, 100_000, [{ agencyId: agency.id, status: 'delivered', value: 100_000 }]);
  await splitDue('order', order4, vendor.id, 100_000, 7_000, new Date());
  await sweep();
  const order4Rewards = await ReferralRewardModel.find({ order_id: order4 }).lean();
  check('an expired customer earns nothing; the vendor and agency still do', order4Rewards.length === 2 && !order4Rewards.some((r) => r.category === 'customer'));

  const secondAgency = await makeAgency('Beta Agency');
  await refer(david, secondAgency.userId, 'agency');
  const order5 = await makeOrder(vendor.id, customer.id, 100_000, [
    { agencyId: agency.id, status: 'delivered', value: 60_000 },
    { agencyId: secondAgency.id, status: 'delivered', value: 40_000 },
  ]);
  await splitDue('order', order5, vendor.id, 100_000, 7_000, new Date());
  await sweep();
  const order5Rewards = await ReferralRewardModel.find({ order_id: order5, category: 'agency' }).lean();
  check('two agencies share by parcel value: 126 and 84', order5Rewards.map((r) => r.amount).sort((a, b) => b - a).join() === '126,84', order5Rewards.map((r) => r.amount));
  check('each agency pays its own partner', new Set(order5Rewards.map((r) => r.partner_id.toString())).size === 2);

  const codOrder = await makeOrder(vendor.id, customer.id, 50_000, []);
  const collection = new Types.ObjectId();
  await CashCollectionModel.collection.insertOne({ _id: collection, order_id: codOrder, agency_id: agency.id, status: 'collected', created_at: new Date() });
  await splitDue('cod_collection', collection, vendor.id, 50_000, 3_500, new Date(), { cashSettledAt: new Date() });
  await sweep();
  const codRewards = await ReferralRewardModel.find({ source_id: collection }).lean();
  check('a COD parcel pays all three on that parcel\'s commission', codRewards.length === 3 && codRewards.every((r) => r.amount === 105) && codRewards.every((r) => r.order_id?.equals(codOrder)), codRewards.map((r) => r.amount));

  const bookingId = new Types.ObjectId();
  await Booking.collection.insertOne({ _id: bookingId, vendorId: vendor.id, userId: customer.userId, created_at: new Date() });
  await splitDue('booking', bookingId, vendor.id, 20_000, 1_400, new Date());
  await sweep();
  const bookingRewards = await ReferralRewardModel.find({ booking_id: bookingId }).lean();
  check('a booking pays the vendor and customer, with no agency', bookingRewards.length === 2 && bookingRewards.every((r) => r.amount === 42) && !bookingRewards.some((r) => r.category === 'agency'), bookingRewards.map((r) => [r.category, r.amount]));

  const claimId = new Types.ObjectId();
  await splitDue('agency_claim', claimId, vendor.id, 10_000, 1_000, new Date());
  await sweep();
  check('a damage-claim fee is judged, and pays nothing', (await ReferralRewardModel.countDocuments({ source_id: claimId })) === 0
    && !!(await EarningsAllocationModel.findOne({ source_id: claimId, beneficiary_type: 'platform' }).lean())?.referral_evaluated_at);

  // ── 10 ─────────────────────────────────────────────────────────────────────────────
  out('\n10. Where a code arrives');
  const davidCode = await codeOf(david);
  const relationshipOf = async (userId: unknown) => ReferralRelationshipModel.findOne({ referred_user_id: userId, partner_id: david }).lean();

  const auth = new AuthService();
  const web = await auth.register(RegisterSchema.parse({
    phone: nextPhone(), name: 'Web Vendor', password: 'a-real-password', role: 'vendor', business_name: 'Web Shop',
    terms_accepted: true, referral_code: davidCode.toLowerCase(),
  }));
  const webRel = await relationshipOf(web.user._id);
  check('the web form records it, whatever the case of the code', webRel?.category === 'vendor' && webRel?.channel === 'web');
  const noCode = await auth.register(RegisterSchema.parse({
    phone: nextPhone(), name: 'Plain Vendor', password: 'a-real-password', role: 'vendor', business_name: 'Plain Shop', terms_accepted: true,
  }));
  check('no code records nothing', (await ReferralRelationshipModel.countDocuments({ referred_user_id: noCode.user._id })) === 0);
  const badCode = await auth.register(RegisterSchema.parse({
    phone: nextPhone(), name: 'Other Vendor', password: 'a-real-password', role: 'vendor', business_name: 'Other Shop', terms_accepted: true, referral_code: 'NOPE9999',
  }));
  check('a bad code never refuses a registration', !!badCode.user._id && (await ReferralRelationshipModel.countDocuments({ referred_user_id: badCode.user._id })) === 0);

  const bot = new BotRegistrationService();
  const waDigits = nextPhone().replace('+', '');
  const waCode = parseReferralCodeFromMessage(referralWhatsappText(davidCode));
  const wa = await bot.sync({ channel: 'whatsapp', externalId: waDigits, displayName: 'Wa Customer' }, waCode);
  const waRel = await relationshipOf(wa?.account.userId);
  check('a WhatsApp first message creates the customer and records it', !!wa?.createdAccount && waRel?.category === 'customer' && waRel?.channel === 'whatsapp');
  const secondMessage = await bot.sync({ channel: 'whatsapp', externalId: waDigits, displayName: 'Wa Customer' }, null);
  check('later messages change nothing', secondMessage?.createdAccount === false && (await ReferralRelationshipModel.countDocuments({ referred_user_id: wa?.account.userId })) === 1);

  const businessPhone = nextPhone();
  const business = await auth.register(RegisterSchema.parse({
    phone: businessPhone, name: 'Late Vendor', password: 'a-real-password', role: 'vendor', business_name: 'Late Shop', terms_accepted: true,
  }));
  await bot.sync({ channel: 'whatsapp', externalId: businessPhone.replace('+', ''), displayName: 'Late Vendor' }, waCode);
  check('an existing account gaining a customer role in the chat is not referred', (await ReferralRelationshipModel.countDocuments({ referred_user_id: business.user._id })) === 0);

  const redisUp = await Promise.race([
    getRedisClient(BOT_SURFACE_DB).then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (redisUp && peekRedisClient(BOT_SURFACE_DB)) {
    const chatId = String(Date.now());
    const tgPhone = nextPhone();
    const first = await bot.sync({ channel: 'telegram', externalId: chatId, displayName: 'Tg Customer' }, parseReferralCodeFromMessage(`/start ${referralTelegramStart(davidCode)}`));
    check('a Telegram first contact creates nothing yet', first === null);
    const shared = await bot.registerFromContact({ channel: 'telegram', externalId: chatId, displayName: 'Tg Customer' }, tgPhone);
    const tgRel = await relationshipOf(shared.account.userId);
    check('the contact share creates the customer, and the code had waited for it', shared.createdAccount && tgRel?.category === 'customer' && tgRel?.channel === 'telegram');
  } else {
    out('  ⏭ Redis is down: the Telegram door was NOT exercised');
  }

  // Suspension.
  await referralPartnerService.transition(ulrich, 'suspend', ADMIN, 'Under review');
  const newcomer = await makeCustomer('New Comer');
  await refer(ulrich, newcomer.userId, 'customer');
  check("a suspended partner's code registers an ordinary user", (await ReferralRelationshipModel.countDocuments({ referred_user_id: newcomer.userId })) === 0);
  const order6 = await makeOrder(vendor.id, customer.id, 100_000, [{ agencyId: agency.id, status: 'delivered', value: 100_000 }]);
  await splitDue('order', order6, vendor.id, 100_000, 7_000, new Date());
  await sweep();
  check('a commission earned during suspension pays nothing', (await ReferralRewardModel.countDocuments({ order_id: order6 })) === 0);
  check('earned rewards stay recorded', (await ReferralRewardModel.countDocuments({ partner_id: ulrich })) > 0);
  check('the balance is frozen', (await refusalOf(async () => referralPayoutService.request(await partnerDoc(), applicant.userId.toString()))) === ERROR_CODES.REFERRAL_BALANCE_FROZEN);
  await referralPartnerService.releaseBalance(ulrich, ADMIN, 'Reviewed and fine');
  check('an administrator can release it', !(await partnerDoc()).balance_released === false);

  const backOn = await referralPartnerService.transition(ulrich, 'reinstate', ADMIN, null);
  check('reinstating clears the release', backOn.status === 'active' && !backOn.balance_released);
  await sweep();
  check('the suspended period is not paid afterwards', (await ReferralRewardModel.countDocuments({ order_id: order6 })) === 0);

  // Termination and coming back.
  await referralPartnerService.transition(ulrich, 'terminate', ADMIN, 'Ended');
  check('a terminated partner cannot apply again by themselves', (await refusalOf(() => referralPartnerService.apply(applicant.userId.toString(), 'customer', {}))) === ERROR_CODES.REFERRAL_REAPPLY_NOT_ALLOWED);
  await referralPartnerService.allowReapply(ulrich);
  const again = await referralPartnerService.apply(applicant.userId.toString(), 'customer', {});
  check('once allowed, they keep their code and start pending', again.status === 'pending' && again.code === approved.code);

  // Per-partner terms.
  const withTerms = await referralPartnerService.updateTerms(david, { terms: { vendor: { ratePercent: 5 } } });
  check('a custom rate is saved on its own', withTerms.custom_terms.vendor?.rate_percent === 5 && withTerms.custom_terms.vendor?.duration_months == null);
  const reset = await referralPartnerService.updateTerms(david, { terms: { vendor: { ratePercent: null } } });
  check('null resets it', reset.custom_terms.vendor?.rate_percent == null);

  // The program switched off.
  await referralSettingsService.update({ enabled: false }, ADMIN);
  const order7 = await makeOrder(vendor.id, customer.id, 100_000, [{ agencyId: agency.id, status: 'delivered', value: 100_000 }]);
  await splitDue('order', order7, vendor.id, 100_000, 7_000, new Date());
  await sweep();
  check('while off, a commission is judged and pays nothing', (await ReferralRewardModel.countDocuments({ order_id: order7 })) === 0
    && !!(await EarningsAllocationModel.findOne({ source_id: order7, beneficiary_type: 'platform' }).lean())?.referral_evaluated_at);

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  out(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.dropDatabase();
  } catch {
    // Nothing more can be done from here.
  }
  process.exit(1);
});
