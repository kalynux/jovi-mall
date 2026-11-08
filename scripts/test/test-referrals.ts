/**
 * Test: the referral program (REFERRAL-PROGRAM-PLAN). DB-free.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework). The rules
 * are pure, so every worked example of the owner's document runs here with its own numbers.
 *
 *   1. Rewards: examples 1, 2 and 3, the rate cap and the rounding.
 *   2. Settings: per-field overrides, reset, and what a change reaches.
 *   3. The earning period: the document's dates, and expired referrals staying expired.
 *   4. The earning moment: the Monday-Tuesday-Wednesday example, and one participant at a time.
 *   5. Agencies: only the one that delivered, by parcel value.
 *   6. Who cannot earn: an agent, a later role, a suspended partner, a duplicate.
 *   7. Refunds: the 7,000 → 4,000 example, and a full reversal.
 *   8. Partner status and the frozen balance.
 *   9. Codes and masks.
 *  10. What a partner may see: the DTO keys.
 *  11. SOURCE SCANS: the wiring no behavioural test can see.
 *  12. What a partner is told: the copy, the templates, and WhatsApp before email.
 *  13. Provider payments (2026-11-08): the second reward source, RS-3 … RS-7.
 *
 * Run: npm run test:referrals
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  commissionEarnedAt,
  EARNING_CATEGORIES,
  isBalanceFrozen,
  isValidDurationMonths,
  isValidRatePercent,
  isWithinEarningPeriod,
  maskDisplayName,
  normalizeReferralCode,
  GlobalTerms,
  PARTNER_TRANSITIONS,
  parseReferralCodeFromMessage,
  paymentKindOf,
  REFERRED_CATEGORIES,
  referredCategoryOf,
  RATE_MAX_PERCENT,
  REFERRAL_DEFAULTS,
  referralCodeStem,
  referralExpiresAt,
  referralTelegramStart,
  referralWhatsappText,
  resolveDuration,
  resolveRate,
  rewardAmount,
  WHOLE_SHARE,
  wasPartnerActiveAt,
} from '../../src/modules/referrals/domain/referral-rules';
import {
  agencySharesByParcelValue,
  CommissionParticipant,
  planCommissionRewards,
  PlanPartner,
  planProviderPaymentReward,
  PlanRelationship,
} from '../../src/modules/referrals/domain/referral-reward-plan';
import {
  assertReferralCatalogComplete,
  REFERRAL_NOTIFICATION_CATALOG,
  REFERRAL_SITUATIONS,
  referralReasonLine,
  renderReferralChannelText,
  renderReferralWhatsAppTemplateParams,
} from '../../src/modules/notifications/catalog/referral-notification-catalog';
import { TemplateRegistry } from '../../src/modules/whatsapp/handlers/template/template-registry';
import { WEBSITE_GUIDE_KEYS } from '../../src/modules/bot-surface/domain/website-guide';
import { HELD_REFERRAL_GUIDE_TOPICS, REFERRAL_GUIDE_TOPICS } from '../../src/modules/referrals/domain/referral-guide-topics';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const THREE_PERCENT: GlobalTerms = {
  vendor: { rate_percent: 3, duration_months: 6 },
  customer: { rate_percent: 3, duration_months: 6 },
  agency: { rate_percent: 3, duration_months: 6 },
  provider: { rate_percent: 3, duration_months: 6 },
};

const EARNED = new Date('2026-06-01T10:00:00.000Z');
const LATER = new Date('2026-12-31T00:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const activePartner = (id: string, customTerms: PlanPartner['customTerms'] = null): PlanPartner => ({
  id,
  statusHistory: [{ to: 'active', at: LONG_AGO }],
  customTerms,
});

const relationship = (
  id: string,
  partnerId: string,
  userId: string,
  category: PlanRelationship['category'],
  expiresAt: Date | null = LATER
): PlanRelationship => ({
  id,
  partnerId,
  partnerUserId: `${partnerId}-user`,
  referredUserId: userId,
  category,
  expiresAt,
});

const VENDOR: CommissionParticipant = { userId: 'vendor-user', category: 'vendor', share: WHOLE_SHARE };
const CUSTOMER: CommissionParticipant = { userId: 'customer-user', category: 'customer', share: WHOLE_SHARE };
const AGENCY: CommissionParticipant = { userId: 'agency-user', category: 'agency', share: WHOLE_SHARE };

function plan(
  participants: CommissionParticipant[],
  relationships: PlanRelationship[],
  partners: PlanPartner[],
  retainedCommission = 7_000,
  earnedAt = EARNED,
  globalTerms = THREE_PERCENT
) {
  return planCommissionRewards({ participants, relationships, partners, globalTerms, retainedCommission, earnedAt });
}

console.log('\n1. Rewards');
{
  const one = plan([VENDOR], [relationship('r1', 'ulrich', 'vendor-user', 'vendor')], [activePartner('ulrich')]);
  assert('example 1: 7,000 commission at 3% pays 210', one.length === 1 && one[0].amount === 210);

  const all = plan(
    [VENDOR, CUSTOMER, AGENCY],
    [
      relationship('r1', 'ulrich', 'vendor-user', 'vendor'),
      relationship('r2', 'ulrich', 'customer-user', 'customer'),
      relationship('r3', 'ulrich', 'agency-user', 'agency'),
    ],
    [activePartner('ulrich')]
  );
  assert('example 2: one partner who referred all three earns three times', all.length === 3);
  assert('example 2: 630 in total', all.reduce((s, r) => s + r.amount, 0) === 630);
  assert('example 2: Wi-Mall retains 6,370', 7_000 - all.reduce((s, r) => s + r.amount, 0) === 6_370);

  const three = plan(
    [VENDOR, CUSTOMER, AGENCY],
    [
      relationship('r1', 'ulrich', 'vendor-user', 'vendor'),
      relationship('r2', 'david', 'customer-user', 'customer'),
      relationship('r3', 'sarah', 'agency-user', 'agency'),
    ],
    [activePartner('ulrich'), activePartner('david'), activePartner('sarah')]
  );
  assert(
    'example 3: three partners each earn 210 on the same commission',
    three.length === 3 && three.every((r) => r.amount === 210) && new Set(three.map((r) => r.partnerId)).size === 3
  );

  assert('the amount is rounded down to a whole franc', rewardAmount(1_000, 3.5) === 35 && rewardAmount(99, 3) === 2);
  assert('5.25% multiplies exactly', rewardAmount(10_000, 5.25) === 525);
  assert('a large commission stays exact', rewardAmount(9_000_000_000_000, 3) === 270_000_000_000);
  assert(
    'a commission too small to pay a franc writes no reward',
    plan([VENDOR], [relationship('r1', 'ulrich', 'vendor-user', 'vendor')], [activePartner('ulrich')], 20).length === 0
  );
  assert('the default rate is 3%, and the program starts off', REFERRAL_DEFAULTS.ratePercent === 3 && REFERRAL_DEFAULTS.enabled === false);
  assert('the rate may be 0–25, no more', isValidRatePercent(0) && isValidRatePercent(25) && !isValidRatePercent(25.01) && !isValidRatePercent(-1));
  assert('the maximum is 25', RATE_MAX_PERCENT === 25);
  assert('a rate has at most two decimals', isValidRatePercent(3.25) && !isValidRatePercent(3.255));
  assert('a duration is whole months from 1 to 120', isValidDurationMonths(1) && isValidDurationMonths(120) && !isValidDurationMonths(0) && !isValidDurationMonths(1.5));
}

console.log('\n2. Settings');
{
  const ulrich = {
    vendor: { rate_percent: 5, duration_months: 12 },
    agency: { rate_percent: 4, duration_months: null },
    customer: null,
  };
  assert('Ulrich: vendor rate is custom', resolveRate('vendor', THREE_PERCENT, ulrich).ratePercent === 5);
  assert('Ulrich: vendor duration is custom', resolveDuration('vendor', THREE_PERCENT, ulrich).durationMonths === 12);
  assert('Ulrich: agency rate is custom', resolveRate('agency', THREE_PERCENT, ulrich).ratePercent === 4);
  assert('Ulrich: agency duration inherits on its own', resolveDuration('agency', THREE_PERCENT, ulrich).durationMonths === 6);
  assert('Ulrich: customer inherits both', resolveRate('customer', THREE_PERCENT, ulrich).source === 'global' && resolveDuration('customer', THREE_PERCENT, ulrich).source === 'global');
  assert('a custom rate of 0 is a custom rate, not "unset"', resolveRate('vendor', THREE_PERCENT, { vendor: { rate_percent: 0, duration_months: null } }).ratePercent === 0);
  assert('null is a reset: it returns the global value', resolveRate('vendor', THREE_PERCENT, { vendor: { rate_percent: null, duration_months: null } }).source === 'global');

  // The document's December example: a global change reaches active referrals, but not overrides.
  const november: GlobalTerms = { ...THREE_PERCENT, customer: { rate_percent: 5, duration_months: 6 } };
  const december: GlobalTerms = { ...THREE_PERCENT, customer: { rate_percent: 3, duration_months: 6 } };
  const rel = [relationship('r1', 'ulrich', 'customer-user', 'customer')];
  const earnedNov = plan([CUSTOMER], rel, [activePartner('ulrich')], 7_000, EARNED, november);
  const earnedDec = plan([CUSTOMER], rel, [activePartner('ulrich')], 7_000, EARNED, december);
  assert('a customer referred at 5% earns at 3% after the change', earnedNov[0].amount === 350 && earnedDec[0].amount === 210);
  assert('the rate used is saved on the reward', earnedNov[0].ratePercent === 5 && earnedDec[0].ratePercent === 3);
  const custom = plan([CUSTOMER], rel, [activePartner('ulrich', { customer: { rate_percent: 5, duration_months: null } })], 7_000, EARNED, december);
  assert('an individual setting is unaffected by a global change', custom[0].amount === 350 && custom[0].rateSource === 'custom');
}

console.log('\n3. The earning period');
{
  const jan1 = new Date('2026-01-01T09:00:00.000Z');
  const expires = referralExpiresAt(jan1, 6);
  assert('January 1 + 6 months: the end of June 30 in Douala', expires.toISOString() === '2026-06-30T23:00:00.000Z');
  assert('the last minute of June 30 is still eligible', isWithinEarningPeriod(expires, new Date('2026-06-30T22:59:00.000Z')));
  assert('July 1 is not', !isWithinEarningPeriod(expires, new Date('2026-06-30T23:00:00.000Z')));
  assert(
    'a registration at 23:30 UTC on Dec 31 is already January 1 in Douala',
    referralExpiresAt(new Date('2025-12-31T23:30:00.000Z'), 1).toISOString() === '2026-01-31T23:00:00.000Z'
  );
  assert(
    'January 31 + 1 month earns through the last day of February',
    referralExpiresAt(new Date('2026-01-31T12:00:00.000Z'), 1).toISOString() === '2026-02-28T23:00:00.000Z'
  );
  assert('months carry across a year', referralExpiresAt(new Date('2026-09-15T12:00:00.000Z'), 6).toISOString() === '2027-03-14T23:00:00.000Z');
  assert(
    'the duration comes from the settings at registration only: 12 later does not move a 6',
    referralExpiresAt(jan1, 6).getTime() !== referralExpiresAt(jan1, 12).getTime() && expires.toISOString() === '2026-06-30T23:00:00.000Z'
  );
  assert('no expiry means never eligible', !isWithinEarningPeriod(null, EARNED));

  const expired = relationship('r1', 'ulrich', 'vendor-user', 'vendor', new Date('2026-05-01T00:00:00.000Z'));
  const longer: GlobalTerms = { ...THREE_PERCENT, vendor: { rate_percent: 3, duration_months: 60 } };
  assert(
    'an expired referral stays expired, however long the global duration becomes',
    plan([VENDOR], [expired], [activePartner('ulrich')], 7_000, EARNED, longer).length === 0
  );
}

console.log('\n4. The earning moment');
{
  // Customer A's period ends on Tuesday. Ordered Monday, delivered Wednesday.
  const tuesdayEnd = new Date('2026-06-02T23:00:00.000Z');
  const wednesday = new Date('2026-06-03T09:00:00.000Z');
  const customerA = relationship('r1', 'ulrich', 'customer-user', 'customer', tuesdayEnd);
  assert(
    'the Monday order earned on Wednesday pays nothing',
    plan([CUSTOMER], [customerA], [activePartner('ulrich')], 7_000, wednesday).length === 0
  );
  assert(
    'the same order earned on Tuesday would pay',
    plan([CUSTOMER], [customerA], [activePartner('ulrich')], 7_000, new Date('2026-06-02T10:00:00.000Z')).length === 1
  );

  const mixed = plan(
    [VENDOR, CUSTOMER, AGENCY],
    [
      relationship('r1', 'ulrich', 'vendor-user', 'vendor'),
      relationship('r2', 'david', 'customer-user', 'customer', new Date('2026-01-01T00:00:00.000Z')),
      relationship('r3', 'sarah', 'agency-user', 'agency'),
    ],
    [activePartner('ulrich'), activePartner('david'), activePartner('sarah')]
  );
  assert(
    'an expired customer does not affect the vendor or the agency',
    mixed.length === 2 && mixed.every((r) => r.partnerId !== 'david')
  );

  const hold = new Date('2026-06-03T00:00:00.000Z');
  const cash = new Date('2026-06-05T00:00:00.000Z');
  const sweep = new Date('2026-06-05T01:00:00.000Z');
  assert('earned when the hold ended, not when the sweep ran', commissionEarnedAt({ hold_release_at: hold, released_at: sweep }).getTime() === hold.getTime());
  assert('COD: earned when the cash arrived, if that was later', commissionEarnedAt({ hold_release_at: hold, cash_settled_at: cash, released_at: sweep }).getTime() === cash.getTime());
  assert('COD: the hold still counts if the cash came first', commissionEarnedAt({ hold_release_at: cash, cash_settled_at: hold, released_at: sweep }).getTime() === cash.getTime());
}

console.log('\n5. Agencies');
{
  const prices = new Map([['item-a', 6_000], ['item-b', 4_000]]);
  const shares = agencySharesByParcelValue(
    [
      { agencyId: 'one', status: 'delivered', items: [{ orderItemId: 'item-a', quantity: 1 }] },
      { agencyId: 'two', status: 'agent_delivered', items: [{ orderItemId: 'item-b', quantity: 1 }] },
    ],
    prices,
    10_000
  );
  const one = shares.get('one')!;
  const two = shares.get('two')!;
  assert('each agency takes its share by parcel value', rewardAmount(7_000, 3, one) === 126 && rewardAmount(7_000, 3, two) === 84);
  assert('together they equal one 3% of the commission', rewardAmount(7_000, 3, one) + rewardAmount(7_000, 3, two) === 210);

  const returned = agencySharesByParcelValue(
    [
      { agencyId: 'one', status: 'delivered', items: [{ orderItemId: 'item-a', quantity: 1 }] },
      { agencyId: 'two', status: 'returned', items: [{ orderItemId: 'item-b', quantity: 1 }] },
    ],
    prices,
    10_000
  );
  assert('a returned parcel earns its agency nothing', !returned.has('two') && returned.has('one'));
  for (const status of ['pending', 'assigned', 'picked_up', 'in_transit', 'failed', 'handing_over', 'rejected']) {
    assert(`a parcel still ${status} earns nothing`, agencySharesByParcelValue(
      [{ agencyId: 'one', status, items: [{ orderItemId: 'item-a', quantity: 1 }] }], prices, 10_000
    ).size === 0);
  }
  const twoParcels = agencySharesByParcelValue(
    [
      { agencyId: 'one', status: 'delivered', items: [{ orderItemId: 'item-a', quantity: 1 }] },
      { agencyId: 'one', status: 'delivered', items: [{ orderItemId: 'item-b', quantity: 1 }] },
    ],
    prices,
    10_000
  );
  assert('one agency with two parcels counts once, summed', twoParcels.size === 1 && twoParcels.get('one')!.numerator === 10_000);
  assert('an order with no goods value gives no share', agencySharesByParcelValue(
    [{ agencyId: 'one', status: 'delivered', items: [{ orderItemId: 'item-a', quantity: 1 }] }], prices, 0
  ).size === 0);
}

console.log('\n6. Who cannot earn');
{
  assert(
    "an agent's own activity never earns",
    plan([{ userId: 'agent-user', category: 'vendor', share: WHOLE_SHARE }], [relationship('r1', 'ulrich', 'agent-user', 'agent', LATER)], [activePartner('ulrich')]).length === 0
  );
  assert(
    'a person referred as a customer earns nothing as a vendor (the role signed up with only)',
    plan([{ userId: 'same-user', category: 'vendor', share: WHOLE_SHARE }], [relationship('r1', 'ulrich', 'same-user', 'customer')], [activePartner('ulrich')]).length === 0
  );
  assert(
    'one account appearing twice on a commission earns once',
    plan(
      [CUSTOMER, { ...CUSTOMER }],
      [relationship('r1', 'ulrich', 'customer-user', 'customer')],
      [activePartner('ulrich')]
    ).length === 1
  );
  const self = { ...relationship('r1', 'ulrich', 'ulrich-user', 'vendor'), partnerUserId: 'ulrich-user' };
  assert(
    'a partner cannot earn from their own account',
    plan([{ userId: 'ulrich-user', category: 'vendor', share: WHOLE_SHARE }], [self], [activePartner('ulrich')]).length === 0
  );
  const suspended: PlanPartner = {
    id: 'ulrich',
    customTerms: null,
    statusHistory: [
      { to: 'active', at: LONG_AGO },
      { to: 'suspended', at: new Date('2026-05-01T00:00:00.000Z') },
    ],
  };
  assert('a suspended partner earns nothing', plan([VENDOR], [relationship('r1', 'ulrich', 'vendor-user', 'vendor')], [suspended]).length === 0);
  assert('a partner suspended after the commission was earned still earns it', plan(
    [VENDOR],
    [relationship('r1', 'ulrich', 'vendor-user', 'vendor')],
    [{ ...suspended, statusHistory: [{ to: 'active', at: LONG_AGO }, { to: 'suspended', at: new Date('2026-06-02T00:00:00.000Z') }] }]
  ).length === 1);
  assert('no relationship, no reward', plan([VENDOR], [], [activePartner('ulrich')]).length === 0);
}

console.log('\n7. Refunds');
{
  assert('7,000 at 3% is 210', rewardAmount(7_000, 3) === 210);
  assert('after a refund Wi-Mall retains 4,000: the reward is 120', rewardAmount(4_000, 3) === 120);
  assert('the difference to take back is 90', rewardAmount(7_000, 3) - rewardAmount(4_000, 3) === 90);
  assert('a full refund leaves nothing', rewardAmount(0, 3) === 0);
  assert('it uses the saved rate: a reward earned at 5% stays at 5%', rewardAmount(4_000, 5) === 200);
  const share = { numerator: 6_000, denominator: 10_000 };
  assert('an agency share is applied again to what is retained', rewardAmount(4_000, 3, share) === 72);
  for (const retained of [7_000, 6_001, 4_000, 1, 0]) {
    assert(`the reward never exceeds the rate on ${retained} retained`, rewardAmount(retained, 3) <= (retained * 3) / 100);
  }
}

console.log('\n8. Partner status');
{
  const t = PARTNER_TRANSITIONS;
  assert('approval makes a pending partner active', t.approve.from.includes('pending') && t.approve.to === 'active');
  assert('only a pending application can be rejected', t.reject.from.length === 1 && t.reject.from[0] === 'pending');
  assert('only an active partner can be suspended', t.suspend.from.length === 1 && t.suspend.from[0] === 'active');
  assert('reinstating is from suspended only', t.reinstate.from.length === 1 && t.reinstate.from[0] === 'suspended');
  assert('a terminated partner has no verb back', Object.values(t).every((rule) => !rule.from.includes('terminated')));

  const history = [
    { to: 'pending' as const, at: new Date('2026-01-01T00:00:00.000Z') },
    { to: 'active' as const, at: new Date('2026-02-01T00:00:00.000Z') },
    { to: 'suspended' as const, at: new Date('2026-03-01T00:00:00.000Z') },
    { to: 'active' as const, at: new Date('2026-04-01T00:00:00.000Z') },
  ];
  assert('not active while pending', !wasPartnerActiveAt(history, new Date('2026-01-15T00:00:00.000Z')));
  assert('active after approval', wasPartnerActiveAt(history, new Date('2026-02-15T00:00:00.000Z')));
  assert('not during the suspension: nothing is paid for that period, even after reinstating', !wasPartnerActiveAt(history, new Date('2026-03-15T00:00:00.000Z')));
  assert('active again afterwards', wasPartnerActiveAt(history, new Date('2026-04-15T00:00:00.000Z')));
  assert('an empty history is never active', !wasPartnerActiveAt([], EARNED));

  assert('an active partner may withdraw', !isBalanceFrozen({ status: 'active', balance_released: null }));
  assert('a suspended partner may not', isBalanceFrozen({ status: 'suspended', balance_released: null }));
  assert('a terminated partner may not', isBalanceFrozen({ status: 'terminated', balance_released: null }));
  assert('unless an administrator released it', !isBalanceFrozen({ status: 'terminated', balance_released: { at: EARNED } }));
}

console.log('\n9. Codes and masks');
{
  assert('a code is case-insensitive', normalizeReferralCode(' ulrich123 ') === 'ULRICH123');
  assert('nonsense is not a code', normalizeReferralCode('no spaces allowed') === null && normalizeReferralCode('abc') === null && normalizeReferralCode(42) === null);
  assert('the stem is the first name', referralCodeStem('Ulrich Mbarga') === 'ULRICH');
  assert('accents are removed', referralCodeStem('Élodie') === 'ELODIE');
  assert('a name with no latin letters gets a neutral stem', referralCodeStem('محمد') === 'WIMALL' && referralCodeStem(null) === 'WIMALL');
  assert('the WhatsApp link text parses back', parseReferralCodeFromMessage(referralWhatsappText('ULRICH123')) === 'ULRICH123');
  assert('the Telegram start parses back', parseReferralCodeFromMessage(`/start ${referralTelegramStart('ULRICH123')}`) === 'ULRICH123');
  assert('a group-style /start@bot parses too', parseReferralCodeFromMessage('/start@WiMallBot ref_ULRICH123') === 'ULRICH123');
  assert('an ordinary message carries no code', parseReferralCodeFromMessage('how much is this reference?') === null && parseReferralCodeFromMessage('/start') === null && parseReferralCodeFromMessage(undefined) === null);
  assert('a masked name hides all but the first letters', maskDisplayName('Ulrich Mbarga') === 'U***** M*****');
  assert('a missing name stays masked', maskDisplayName(null) === '***' && maskDisplayName('  ') === '***');
}

console.log('\n10. What a partner may see');
{
  const dto = stripComments(read('modules/referrals/dto/referral-partner.dto.ts'));
  for (const forbidden of ['order_id', 'orderId', 'booking_id', 'bookingId', 'vendor_id', 'vendorId', 'commission', 'share', 'source_id', 'rate_percent']) {
    assert(`a partner's DTOs never carry ${forbidden}`, !dto.includes(forbidden));
  }
  const controller = stripComments(read('modules/referrals/controllers/me-referral.controller.ts'));
  assert('rewards reach a partner only through the DTO', controller.includes('toPartnerRewardDto') && !/sendSuccess\(res, rows\b/.test(controller));
  const pub = stripComments(read('modules/referrals/routes/public-referral.routes.ts'));
  assert('the public route never reads a name or a user', !pub.includes('user_id') && !/\bname\b/.test(pub));
}

console.log('\n11. Source scans');
{
  const auth = stripComments(read('modules/auth/auth.service.ts'));
  const register = auth.slice(auth.indexOf('async register('), auth.indexOf('async login('));
  const addRole = auth.slice(auth.indexOf('async addRole('));
  assert('registration attaches a referral', register.includes('referralAttributionService.attach'));
  assert('adding a role never does (only a new account can be referred)', !addRole.includes('referralAttributionService'));

  const bot = stripComments(read('modules/bot-surface/services/bot-registration.service.ts'));
  const ensure = bot.slice(bot.indexOf('private async ensureCustomer('), bot.indexOf('private async backfillOnboarding('));
  assert('the bot attaches one when it creates an account', bot.includes('referralAttributionService.attach'));
  assert("the customer role the bot adds to a business account never does", !ensure.includes('referralAttributionService'));
  assert('a Telegram code waits for the contact share', bot.includes('rememberPendingCode') && bot.includes('consumePendingCode'));

  const attribution = stripComments(read('modules/referrals/services/referral-attribution.service.ts'));
  const attach = attribution.slice(attribution.indexOf('async attach('), attribution.indexOf('async rememberPendingCode('));
  assert('attach catches everything: a referral never fails a registration', /try \{[\s\S]*\} catch \(error\)/.test(attach) && !attach.includes('throw'));
  assert("a code works only for an active partner", attach.includes("status: 'active'"));
  assert('a disabled program records nothing', attach.includes('settings.enabled'));
  assert('the expiry is computed once, at registration', attach.includes('referralExpiresAt'));

  const rewards = stripComments(read('modules/referrals/services/referral-reward.service.ts'));
  assert('only the platform commission row is read, never the bargain fee', rewards.includes("beneficiary_type: 'platform',") && !rewards.includes('platform_ai'));
  assert('a damage-claim fee is not a commission', /COMMISSION_SOURCES[^;]*\['order', 'cod_collection', 'booking'\]/.test(rewards) && !/COMMISSION_SOURCES[^;]*agency_claim/.test(rewards));
  assert('the commission mark and the rewards share one transaction', /runInTransactionWithRetry[\s\S]{0,700}referral_evaluated_at: now[\s\S]{0,700}createReward/.test(rewards));
  assert('a refund landing since the read is noticed', rewards.includes('clawed_amount: (row.clawed_amount ?? 0) === 0'));
  assert('rewards are created with the session array form', /ReferralRewardModel\.create\(\s*\[[\s\S]*?\],\s*\{ session \}/.test(rewards));
  assert('a refund sync reads the rate saved on the reward', rewards.includes('rewardAmount(retained, reward.rate_percent, reward.share)'));
  assert('the sync can only lower a reward', rewards.includes('Math.min(before, rewardAmount('));

  const worker = stripComments(read('modules/earnings/workers/earnings-release.worker.ts'));
  assert('the stages run straight after the release', /releaseMaturedHolds\(now\);\s*await this\.runReferralStages\(now\);/.test(worker));
  const release = worker.slice(worker.indexOf('private async releaseMaturedHolds('), worker.indexOf('private async runReferralStages('));
  assert('the release transaction itself knows nothing of referrals', !release.includes('referral'));
  const stages = worker.slice(worker.indexOf('private async runReferralStages('));
  assert('the stages cannot stop the sweep', /try \{\s*await referralRewardService\.runNightlyStages[\s\S]*?\} catch/.test(stages));
  assert('a partner is never paid automatically at the threshold', /owner_type === 'referral_partner'\) continue/.test(worker));

  const clawback = stripComments(read('modules/earnings/services/earnings-clawback.service.ts'));
  assert('the refund engine only leaves a mark in its own transaction', clawback.includes('markReferralResync(row._id'));
  assert('only a platform row is marked', /beneficiary_type === 'platform'\) \{\s*await this\.allocationRepo\.markReferralResync/.test(clawback));
  const afterCommit = clawback.indexOf('syncAfterRefund');
  assert('the sync runs after the commit', afterCommit > clawback.lastIndexOf('runInTransactionWithRetry'));
  assert('the sync cannot throw into a refund', /async syncAfterRefund[\s\S]*?try \{[\s\S]*?\} catch/.test(rewards));

  const allocation = read('modules/earnings/models/earnings-allocation.model.ts');
  assert('a reward can never be an allocation', !allocation.includes("beneficiary_type: { type: String, enum: ['vendor', 'agency', 'platform', 'agent', 'platform_ai', 'referral_partner']"));

  const payouts = stripComments(read('modules/referrals/services/referral-payout.service.ts'));
  assert('a frozen balance is refused before anything else', payouts.indexOf('isBalanceFrozen(partner)') < payouts.indexOf('requestPayout('));
  assert('the minimum comes from the settings', payouts.includes('minAmount: settings.minPayoutAmount'));
  assert('a role destination cannot be overwritten from the page', payouts.includes('!destination.editableHere'));
  const accounts = stripComments(read('modules/earnings/services/earnings-account.service.ts'));
  assert('every other owner keeps the existing minimum', accounts.includes('minAmount: number = EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT'));

  const admin = stripComments(read('modules/referrals/routes/admin-referral.routes.ts'));
  assert('there is no way to change a referrer', !/relationship/i.test(admin));
  const api = read('api/routes/internal-admin.routes.ts');
  assert('the admin surface is mounted behind the admin caller', api.includes("router.use('/referrals', buildAdminReferralRouter([requireAdminCaller]));"));
}

console.log('\n12. What a partner is told');
{
  let complete = true;
  try {
    assertReferralCatalogComplete();
  } catch {
    complete = false;
  }
  assert('every situation has copy in all five languages', complete);

  const names = REFERRAL_SITUATIONS.map((s) => REFERRAL_NOTIFICATION_CATALOG[s].template.name);
  assert('every template name is its own, and says referral', new Set(names).size === names.length && names.every((n) => n.startsWith('referral_')));

  const file = JSON.parse(readFileSync(join(ROOT, 'api-doc', 'notifications', 'whatsapp-template-payloads.json'), 'utf8')) as {
    payloads: Array<{ name: string; language: string; category: string; components: Array<{ type: string; text?: string }> }>;
  };
  const payload = (name: string, language: string) => file.payloads.find((p) => p.name === name && p.language === language);
  assert('each is in the submission set, in English and French', names.every((n) => !!payload(n, 'en') && !!payload(n, 'fr')));
  assert('each is UTILITY', names.every((n) => payload(n, 'en')?.category === 'UTILITY' && payload(n, 'fr')?.category === 'UTILITY'));
  assert('none carries a button: its host would be permanent, and the roles have different ones',
    names.every((n) => !payload(n, 'en')?.components.some((c) => c.type === 'BUTTONS') && !payload(n, 'fr')?.components.some((c) => c.type === 'BUTTONS')));
  const body = (n: string, lang: string) => payload(n, lang)?.components.find((c) => c.type === 'BODY')?.text ?? '';
  assert('the placeholder count matches what the send passes',
    REFERRAL_SITUATIONS.every((s) => {
      const count = REFERRAL_NOTIFICATION_CATALOG[s].template.bodyParams.length;
      const name = REFERRAL_NOTIFICATION_CATALOG[s].template.name;
      return ['en', 'fr'].every((lang) => (body(name, lang).match(/\{\{\d+\}\}/g) ?? []).length === count);
    }));
  assert('the reason never reaches a template: Meta refuses a line break in a parameter',
    names.every((n) => !body(n, 'en').includes('reasonLine')) && REFERRAL_SITUATIONS.every((s) => !REFERRAL_NOTIFICATION_CATALOG[s].template.bodyParams.some((p) => p.includes('reasonLine'))));
  assert('the code is in the approval message',
    renderReferralWhatsAppTemplateParams('partner.approved', 'en', { referralCode: 'ULRICH123' }).join() === 'ULRICH123');
  assert('a payout passes its currency, then its amount',
    renderReferralWhatsAppTemplateParams('payout.paid', 'en', { currency: 'XAF', amountFormatted: '2,100' }).join() === 'XAF,2,100');
  const registry = new TemplateRegistry();
  assert('the registry knows them, and warns about nothing that exists', names.every((n) => registry.has(n, 'en') && registry.has(n, 'fr')));

  const withReason = renderReferralChannelText('partner.suspended', 'whatsapp', 'en', { reasonLine: referralReasonLine('en', 'Under review') });
  assert('a free message carries the reason', withReason.body.includes('Reason: Under review.'));
  const noReason = renderReferralChannelText('partner.suspended', 'whatsapp', 'en', { reasonLine: '' });
  assert('and reads cleanly without one', !noReason.body.includes('  ') && !noReason.body.includes('Reason'));
  assert('a reason keeps its own full stop, and loses its line breaks', referralReasonLine('fr', 'Fraude\nprobable.') === 'Motif: Fraude probable.');
  assert('no reason is no clause', referralReasonLine('en', null) === '' && referralReasonLine('en', '  ') === '');

  const service = stripComments(read('modules/referrals/services/referral-notifications.ts'));
  assert('WhatsApp is tried first, and email only if it did not deliver', /if \(await sendWhatsApp\([^)]*\)\) return;\s*await sendEmail\(/.test(service));
  assert('outside the window it sends the template, in an approved language', service.includes('templateLanguage(contact.lang)') && !service.includes('META_LANGUAGE_CODE'));
  assert('an unverified phone is never messaged', service.includes('profile.phone_verified ? profile.phone : null'));
  assert('a failed transfer is told too', service.includes("eventBus.subscribe('payout.transfer_failed', onPayoutEvent)"));
  assert('a payout message never carries the partnership\'s reason', /reasonLine: '',/.test(service));
  const notify = service.slice(service.indexOf('export async function notifyPartner('), service.indexOf('const PAYOUT_SITUATIONS'));
  assert('it cannot throw into a caller', /try \{[\s\S]*\} catch \(error\)/.test(notify));

  const partners = stripComments(read('modules/referrals/services/referral-partner.service.ts'));
  assert('an administrator never waits for the send', partners.includes('void notifyPartner(') && !partners.includes('await notifyPartner('));
  assert('reinstating has its own message, not the welcome one', partners.includes("reinstate: 'partner.reinstated'") && partners.includes("approve: 'partner.approved'"));
  assert('releasing a balance and allowing an application are both told', partners.includes("tell(updated, 'partner.balance_released')") && partners.includes("tell(updated, 'partner.reapply_allowed')"));
}

console.log('\n13. The bot guide');
{
  assert('a topic is written for each of the four apps, in English and French',
    ['shop', 'vendor', 'agency', 'agent'].every((app) => {
      const topic = [...REFERRAL_GUIDE_TOPICS, ...HELD_REFERRAL_GUIDE_TOPICS].find((t) => t.app === app);
      return !!topic && topic.copy.en.steps.length === topic.copy.fr.steps.length && topic.copy.en.notes.length === topic.copy.fr.notes.length;
    }));
  assert('the storefront and both dashboards are served: the bot guides people to the website (R-11)',
    REFERRAL_GUIDE_TOPICS.length === 3 && REFERRAL_GUIDE_TOPICS.every((t) => WEBSITE_GUIDE_KEYS.includes(t.key)));
  assert('the agent topic is not served until the app ships its screens: no route check can catch it',
    HELD_REFERRAL_GUIDE_TOPICS.every((t) => t.app === 'agent' && !WEBSITE_GUIDE_KEYS.includes(t.key)));
}

console.log('\n13. Provider payments (LISTING-REVIEWS-SAVES-REFERRALS-PLAN § 3.3, 2026-11-08)');
{
  const PAID = new Date('2026-06-01T10:00:00.000Z');
  const providerRel = relationship('rel-p', 'partner-1', 'provider-user', 'provider');
  const base = { relationship: providerRel, partner: activePartner('partner-1'), globalTerms: THREE_PERCENT, pricePaid: 3_000, paidAt: PAID };

  const r = planProviderPaymentReward(base);
  assert('RS-6: 3% of a 3,000 XAF plan is 90 XAF, on the FULL price', r?.amount === 90 && r.category === 'provider' && r.share.numerator === 1 && r.share.denominator === 1);
  assert('the rate is the provider category\'s, not the vendor one', planProviderPaymentReward({
    ...base, globalTerms: { ...THREE_PERCENT, provider: { rate_percent: 10, duration_months: 6 } },
  })?.amount === 300);
  assert('a partner\'s own provider rate overrides the global one', planProviderPaymentReward({
    ...base, partner: activePartner('partner-1', { provider: { rate_percent: 5, duration_months: null } }),
  })?.rateSource === 'custom');
  assert('⛔ a seller\'s VENDOR relationship never earns on what they pay for a plan (commission is its basis)',
    planProviderPaymentReward({ ...base, relationship: relationship('rel-v', 'partner-1', 'provider-user', 'vendor') }) === null);
  assert('RS-5: judged AT THE PAYMENT — after the period ends, nothing',
    planProviderPaymentReward({ ...base, relationship: relationship('rel-p', 'partner-1', 'provider-user', 'provider', new Date('2026-05-01T00:00:00.000Z')) }) === null);
  assert('…and not while the partner was suspended at the payment, whatever their status today',
    planProviderPaymentReward({ ...base, partner: { id: 'partner-1', statusHistory: [{ to: 'active', at: LONG_AGO }, { to: 'suspended', at: new Date('2026-05-15T00:00:00.000Z') }], customTerms: null } }) === null);
  assert('under 1 FCFA after flooring is no reward (a 30 XAF pack at 3%)', planProviderPaymentReward({ ...base, pricePaid: 30 }) === null);
  assert('a relationship that is not this partner\'s, or no partner, earns nothing',
    planProviderPaymentReward({ ...base, partner: activePartner('someone-else') }) === null && planProviderPaymentReward({ ...base, partner: null }) === null);

  assert('a provider vendor is referred as `provider`; a seller and every other role as itself',
    referredCategoryOf('vendor', 'provider') === 'provider' && referredCategoryOf('vendor', 'seller') === 'vendor'
    && referredCategoryOf('vendor', undefined) === 'vendor' && referredCategoryOf('customer', 'provider') === 'customer');
  assert('`provider` is a referred AND an earning category; `agent` still earns nothing',
    (REFERRED_CATEGORIES as readonly string[]).includes('provider') && (EARNING_CATEGORIES as readonly string[]).includes('provider')
    && !(EARNING_CATEGORIES as readonly string[]).includes('agent'));
  assert('RS-7: a partner sees the KIND — plan or credits — and nothing on a commission reward',
    paymentKindOf('plan_purchase') === 'plan' && paymentKindOf('credit_topup') === 'credits' && paymentKindOf('order') === null);

  const dto = stripComments(read('modules/referrals/dto/referral-partner.dto.ts'));
  assert('RS-7: the reward DTO carries paymentKind and never the price paid (commission_earned / price)',
    /paymentKind: paymentKindOf\(row\.source_type\)/.test(dto) && !/price|commission_earned/.test(dto));

  const service = stripComments(read('modules/referrals/services/referral-reward.service.ts'));
  const evaluate = service.slice(service.indexOf('async evaluateProviderPayments('), service.indexOf('private async planProviderReward('));
  assert('only a VENDOR\'s paid, unjudged payments are read — agency and agent plans never',
    evaluate.includes("{ owner_type: 'vendor', status: 'paid', referral_evaluated_at: null }"));
  assert('⛔ the mark and the reward are written in ONE transaction, the claim filtering on status paid',
    /runInTransactionWithRetry\(async \(session\) => \{[\s\S]*findOneAndUpdate\(\s*\{ _id: row\._id, status: 'paid', referral_evaluated_at: null \}[\s\S]*ReferralRewardModel\.create\(\s*\[/.test(evaluate));
  assert('a provider reward has no commission, holds the PRICE as its base, and its ledger row no allocation',
    /commission_allocation_id: null/.test(evaluate) && /commission_earned: Math\.floor\(row\.price\)/.test(evaluate)
    && /allocation_id: null \}, session\)/.test(evaluate));
  const claw = service.slice(service.indexOf('async clawBackReversedProviderPayments('));
  assert('a REVERSED payment (dispute or completed refund) claws every reward on it back to zero',
    claw.includes("{ status: 'reversed', referral_evaluated_at: { $ne: null }, referral_reversal_synced_at: null }")
    && /this\.clawReward\(reward, before, 0, 0,/.test(claw));
  const stages = service.slice(service.indexOf('async runNightlyStages('), service.indexOf('async evaluateProviderPayments('));
  assert('the stages run earn → follow reversals → release, so a reversal beats the release',
    stages.indexOf('evaluateProviderPayments') < stages.indexOf('clawBackReversedProviderPayments')
    && stages.indexOf('clawBackReversedProviderPayments') < stages.indexOf('releaseMaturedRewards'));
  const billing = stripComments(read('modules/billing/services/credit-topup.service.ts')) + stripComments(read('modules/billing/services/plan-purchase.service.ts'));
  assert('⛔ billing knows nothing of referrals: the status is the mark, and no billing transaction carries a reward',
    !/referral/i.test(billing));

  const model = read('modules/referrals/models/referral-reward.model.ts');
  assert('⚠ both reward uniqueness indexes are PARTIAL, by source — a plain one collides on the missing commission',
    /name: 'referral_reward_one_per_commission', partialFilterExpression: \{ commission_allocation_id: \{ \$type: 'objectId' \} \}/.test(model)
    && /name: 'referral_reward_one_per_payment', partialFilterExpression: \{ source_type: \{ \$in: \[\.\.\.BILLING_REWARD_SOURCES\] \} \}/.test(model));
  const migrate = readFileSync(join(ROOT, 'scripts', 'migrate.ts'), 'utf8');
  assert('…and the swap is a registered migration, before the catch-all',
    migrate.indexOf("'migrate:referral-billing-rewards'") > -1
    && migrate.indexOf("'migrate:referral-billing-rewards'") < migrate.indexOf("name: 'migrate:declared-indexes'"));
  const auth = stripComments(read('modules/auth/auth.service.ts'));
  assert('registration attaches a provider vendor under `provider` (the kind is fixed there)',
    /category: referredCategoryOf\(role, input\.vendorKind\)/.test(auth));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
