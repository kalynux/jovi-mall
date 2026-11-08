/**
 * test:service-listings-reveal — the reveal (SERVICE-LISTINGS-PLAN § The reveal, L-7 … L-11,
 * L-29, L-30, § C-8a). DB-free: the pure rules, then `ListingRevealService` driven end to end
 * with in-memory fakes whose transaction ROLLS BACK on a throw, so "nothing was charged" is
 * asserted against state, not against a mock's call count.
 *
 *   § 1  the pure rules (`reveal-rules.ts`)
 *   § 2  the ordinary path: first 7, next 4, the same field free, a new window at 7
 *   § 3  refusals that charge nothing: absent field, block, daily cap, video gone, not live
 *   § 4  the grace path (L-10, L-11): engaged customers only, into debt, down to the floor
 *   § 5  step 7: below the first-reveal cost, the provider's listings close to new customers
 *   § 6  concurrency, own listing, inactive / non-provider vendor
 *   § 7  source scans: the reveal reads one published field and owns the debt path
 *
 * Run: npm run test:service-listings-reveal
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import { AppError, createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import {
  exceedsDailyCap,
  isCurrentLead,
  leadWindowFrom,
  liveDebitFallback,
  normaliseForFingerprint,
  platformDayBounds,
  revealFingerprint,
  revealPathFor,
  revealPrice,
  revealValueOf,
  shouldSuspendAfterDebit,
} from '../../src/modules/listings/domain/reveal-rules';
import { ListingRevealService } from '../../src/modules/listings/domain/services/listing-reveal.service';

let passed = 0;
let failed = 0;
function assert(name: string, fn: () => boolean): void {
  try {
    if (fn()) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ FAIL: ${name}`); }
  } catch (err) {
    failed++;
    console.log(`  ❌ FAIL: ${name} — threw ${(err as Error).message}`);
  }
}
async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    if (await fn()) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ FAIL: ${name}`); }
  } catch (err) {
    failed++;
    console.log(`  ❌ FAIL: ${name} — threw ${(err as Error).message}`);
  }
}
async function errOf(fn: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as { code?: string; statusCode?: number };
  }
}

const ROOT = path.join(__dirname, '..', '..');
const code = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DAY = 24 * 60 * 60 * 1000;
const COSTS = { first: 7, next: 4 };

// ─── The world ───────────────────────────────────────────────────────────────

interface Lead { _id: Types.ObjectId; customer_id: string; listing_id: string; vendor_id: string; window_start: Date; window_end: Date; engaged_while_live: boolean; fields_revealed: string[]; channel: string }
interface Reveal { _id: Types.ObjectId; lead_id: Types.ObjectId; listing_id: string; customer_id: string; field: string; cost: number; charged_into_debt: boolean; value_fingerprint: string; refund: null | object; at: Date }

interface World {
  now: Date;
  balance: number;
  listing: Record<string, unknown> & { _id: Types.ObjectId; vendor_id: Types.ObjectId; status: string; suspension: null | { reason: string }; available_fields: string[]; published: unknown };
  contacts: Record<string, unknown>;
  vendor: { userId: string | null; active: boolean; isProvider: boolean; settings: Record<string, unknown> | null };
  leads: Lead[];
  reveals: Reveal[];
  blocked: boolean;
  oembed: 'watchable' | 'gone' | 'unknown';
  suspendCalls: number;
  afterSuspendedCalls: number;
  ledgerRows: Array<{ amount: number; ref: string | null }>;
  failNextInsertAsDuplicate: boolean;
}

const VENDOR = new Types.ObjectId();
const LISTING = new Types.ObjectId();
const CUSTOMER = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const OWNER_USER = new Types.ObjectId().toString();

function freshWorld(over: Partial<World> = {}): World {
  return {
    now: new Date('2026-11-07T12:00:00Z'),
    balance: 100,
    listing: {
      _id: LISTING,
      vendor_id: VENDOR,
      status: 'live',
      suspension: null,
      available_fields: ['whatsapp', 'phone', 'email', 'location', 'video'],
      published: { title: 'Plumbing', company_name: 'Akwa Plumbers' },
    },
    contacts: {
      whatsapp: '+237671234531',
      phone: '+237233445566',
      email: 'hello@akwa.cm',
      location: { formatted_address: 'Rue 1, Akwa', coordinates: { type: 'Point', coordinates: [9.7, 4.05] } },
      video: { url: 'https://youtu.be/abc123', host: 'youtube', checked_at: null },
    },
    vendor: { userId: OWNER_USER, active: true, isProvider: true, settings: null },
    leads: [],
    reveals: [],
    blocked: false,
    oembed: 'watchable',
    suspendCalls: 0,
    afterSuspendedCalls: 0,
    ledgerRows: [],
    failNextInsertAsDuplicate: false,
    ...over,
  };
}

function serviceFor(w: World): ListingRevealService {
  const snapshot = () => JSON.parse(JSON.stringify({ balance: w.balance, leads: w.leads, reveals: w.reveals, ledgerRows: w.ledgerRows, suspendCalls: w.suspendCalls }));
  const restore = (s: ReturnType<typeof snapshot>) => {
    w.balance = s.balance;
    w.ledgerRows = s.ledgerRows;
    w.suspendCalls = s.suspendCalls;
    w.leads = s.leads.map((l: Lead) => ({ ...l, _id: new Types.ObjectId(String(l._id)), window_start: new Date(l.window_start), window_end: new Date(l.window_end) }));
    w.reveals = s.reveals.map((r: Reveal) => ({ ...r, _id: new Types.ObjectId(String(r._id)), lead_id: new Types.ObjectId(String(r.lead_id)), at: new Date(r.at) }));
  };
  const current = (customerId: string, listingId: string, now: Date) =>
    w.leads.filter((l) => l.customer_id === customerId && l.listing_id === listingId && l.window_end.getTime() > now.getTime())
      .sort((a, b) => b.window_end.getTime() - a.window_end.getTime())[0] ?? null;

  return new ListingRevealService(
    { findById: async () => w.listing as never },
    { readPublishedField: async (_id: string, field: string) => (w.contacts[field] ?? null) as never },
    {
      findCurrent: async (c: string, l: string, now: Date) => current(c, l, now) as never,
      create: async (input: { _id: Types.ObjectId; customerId: string; listingId: string; vendorId: string; windowStart: Date; windowEnd: Date; field: string; channel: string }) => {
        const lead: Lead = { _id: input._id, customer_id: input.customerId, listing_id: input.listingId, vendor_id: input.vendorId, window_start: input.windowStart, window_end: input.windowEnd, engaged_while_live: true, fields_revealed: [input.field], channel: input.channel };
        w.leads.push(lead);
        return lead as never;
      },
      addField: async (leadId: Types.ObjectId, field: string, channel: string) => {
        const lead = w.leads.find((l) => l._id.equals(leadId))!;
        if (!lead.fields_revealed.includes(field)) lead.fields_revealed.push(field);
        lead.channel = channel;
      },
    } as never,
    {
      insert: async (input: { _id: Types.ObjectId; leadId: Types.ObjectId; listingId: string; customerId: string; field: string; cost: number; chargedIntoDebt: boolean; valueFingerprint: string; at: Date }) => {
        if (w.failNextInsertAsDuplicate) {
          w.failNextInsertAsDuplicate = false;
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        }
        if (w.reveals.some((r) => r.lead_id.equals(input.leadId) && r.field === input.field)) throw Object.assign(new Error('E11000'), { code: 11000 });
        const row: Reveal = { _id: input._id, lead_id: input.leadId, listing_id: input.listingId, customer_id: input.customerId, field: input.field, cost: input.cost, charged_into_debt: input.chargedIntoDebt, value_fingerprint: input.valueFingerprint, refund: null, at: input.at };
        w.reveals.push(row);
        return row as never;
      },
      findByLeadAndField: async () => null,
      spentBetween: async (c: string, l: string, start: Date, end: Date) =>
        w.reveals.filter((r) => r.customer_id === c && r.listing_id === l && !r.refund && r.at >= start && r.at < end).reduce((s, r) => s + r.cost, 0),
      hasActiveBlock: async () => w.blocked,
      ledgerRefFor: async () => 'ledger-row',
      vendorFacts: async () => w.vendor as never,
    } as never,
    {
      debitInSession: async (_t: string, _o: string, amount: number, _r: string, ref: string | null) => {
        if (w.balance < amount) throw createAppError(ERROR_CODES.BILLING_INSUFFICIENT_CREDITS, 402);
        w.balance -= amount;
        w.ledgerRows.push({ amount: -amount, ref });
        return { balance: w.balance } as never;
      },
      debitAllowingDebtInSession: async (_t: string, _o: string, amount: number, floor: number | null, _r: string, ref: string | null) => {
        if (floor !== null && w.balance - amount < floor) return null;
        w.balance -= amount;
        w.ledgerRows.push({ amount: -amount, ref });
        return { balance: w.balance } as never;
      },
    } as never,
    {
      suspendForInsufficientCredits: async () => { w.suspendCalls++; return [{ id: LISTING.toString(), vectorisedDataId: null }]; },
      afterSuspended: () => { w.afterSuspendedCalls++; },
    } as never,
    { check: async () => w.oembed },
    {
      runInTransactionWithRetry: async <T>(fn: (s: never) => Promise<T>): Promise<T> => {
        const before = snapshot();
        try {
          return await fn({} as never);
        } catch (err) {
          restore(before);
          throw err;
        }
      },
    },
    COSTS,
    () => w.now,
  );
}

const req = (field: string, over: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER,
  userId: USER,
  listingId: LISTING.toString(),
  field: field as never,
  channel: 'whatsapp' as const,
  ...over,
});

async function main(): Promise<void> {
  // ─── § 1 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 1 the pure rules');

  const now = new Date('2026-11-07T12:00:00Z');
  const win = leadWindowFrom(now);
  assert('a window is 30 days from the first reveal', () => win.end.getTime() - win.start.getTime() === 30 * DAY);
  assert('a lead whose window_end is now is no longer current', () => !isCurrentLead({ window_end: now }, now) && isCurrentLead({ window_end: new Date(now.getTime() + 1) }, now));
  assert('price: first field 7, any later field 4, no lead 7', () =>
    revealPrice(null, COSTS) === 7 && revealPrice({ fields_revealed: [] }, COSTS) === 7 && revealPrice({ fields_revealed: ['phone'] }, COSTS) === 4);

  const facts = { status: 'live' as const, suspensionReason: null, vendorActive: true, currentLeadEngaged: false, onEmpty: 'continue_engaged' as const };
  assert('live + active → live', () => revealPathFor(facts) === 'live');
  assert('an inactive provider refuses everyone, even live', () => revealPathFor({ ...facts, vendorActive: false }) === 'refuse');
  assert('credit suspension + engaged + continue → grace', () =>
    revealPathFor({ ...facts, status: 'suspended', suspensionReason: 'insufficient_credits', currentLeadEngaged: true }) === 'grace');
  assert('credit suspension + NOT engaged → refuse (a suspended listing opens no lead)', () =>
    revealPathFor({ ...facts, status: 'suspended', suspensionReason: 'insufficient_credits' }) === 'refuse');
  assert('credit suspension + engaged + stop → refuse', () =>
    revealPathFor({ ...facts, status: 'suspended', suspensionReason: 'insufficient_credits', currentLeadEngaged: true, onEmpty: 'stop' }) === 'refuse');
  assert('oversight / quota suspension and archive refuse even the engaged (§ C-8a)', () =>
    ['platform_oversight', 'plan_quota_exceeded'].every((r) => revealPathFor({ ...facts, status: 'suspended', suspensionReason: r as never, currentLeadEngaged: true }) === 'refuse')
    && revealPathFor({ ...facts, status: 'archived', currentLeadEngaged: true }) === 'refuse');
  assert('a live debit that fails falls back to grace only for an engaged customer under continue', () =>
    liveDebitFallback(true, 'continue_engaged') === 'grace' && liveDebitFallback(false, 'continue_engaged') === 'refuse' && liveDebitFallback(true, 'stop') === 'refuse');
  assert('suspend when the balance drops BELOW the first-reveal cost (7 stays live, 6 does not)', () =>
    !shouldSuspendAfterDebit(7, COSTS) && shouldSuspendAfterDebit(6, COSTS) && shouldSuspendAfterDebit(-3, COSTS));
  assert('the daily cap: null is no limit; spent + price above the cap refuses, equal passes', () =>
    !exceedsDailyCap(1000, 7, null) && exceedsDailyCap(7, 4, 10) && !exceedsDailyCap(6, 4, 10));
  const day = platformDayBounds(new Date('2026-11-07T23:30:00Z'));
  assert('the platform day is Africa/Douala (UTC+1): 23:30Z belongs to the NEXT local day', () =>
    day.start.toISOString() === '2026-11-07T23:00:00.000Z' && day.end.toISOString() === '2026-11-08T23:00:00.000Z');
  assert('values: whatsapp carries a wa.me link of digits only', () => {
    const v = revealValueOf('whatsapp', '+237 671 23 45 31') as { link: string };
    return v.link === 'https://wa.me/237671234531';
  });
  assert('values: a location without coordinates is no value (treated as absent)', () =>
    revealValueOf('location', { formatted_address: 'x' }) === null && revealValueOf('socials', []) === null && revealValueOf('phone', '  ') === null);
  assert('fingerprint: one number as WhatsApp on one listing and phone on another is recognisably one', () =>
    revealFingerprint('whatsapp', { number: '+237 671234531', link: '' }) === revealFingerprint('phone', { number: '237671234531' }));
  assert('fingerprint: sha256 hex, never the value', () => {
    const fp = revealFingerprint('email', { address: 'Hello@Akwa.cm' });
    return /^[0-9a-f]{64}$/.test(fp) && !fp.includes('akwa') && normaliseForFingerprint('email', { address: ' Hello@Akwa.cm ' }) === 'email:hello@akwa.cm';
  });

  // ─── § 2 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 2 the ordinary path');

  {
    const w = freshWorld();
    const svc = serviceFor(w);
    const first = await svc.reveal(req('whatsapp'));
    await assertAsync('the first field costs 7, opens a lead engaged while live, and says the next costs 4', async () =>
      first.result.charged && first.result.cost === 7 && first.openedLead && w.balance === 93
      && w.leads.length === 1 && w.leads[0].engaged_while_live && first.result.nextCost === 4
      && first.result.windowEndsAt === new Date(w.now.getTime() + 30 * DAY).toISOString());
    assert('the reveal row keeps a fingerprint, never the number', () =>
      w.reveals.length === 1 && !JSON.stringify(w.reveals).includes('671234531') && /^[0-9a-f]{64}$/.test(w.reveals[0].value_fingerprint));
    assert('the ledger row names the reveal (ref = revealId)', () => w.ledgerRows.length === 1 && w.ledgerRows[0].ref === w.reveals[0]._id.toString());

    const second = await svc.reveal(req('phone'));
    await assertAsync('a second field in the window costs 4 on the SAME lead', async () =>
      second.result.cost === 4 && !second.openedLead && w.balance === 89 && w.leads.length === 1 && w.leads[0].fields_revealed.length === 2);

    const again = await svc.reveal(req('whatsapp'));
    await assertAsync('the same field again is free and says so', async () =>
      !again.result.charged && again.result.cost === 0 && again.result.alreadyRevealed && w.balance === 89 && w.reveals.length === 2);

    w.now = new Date(w.now.getTime() + 31 * DAY);
    const later = await svc.reveal(req('whatsapp'));
    await assertAsync('after the window ends, the next reveal opens a new lead at 7', async () =>
      later.result.cost === 7 && later.openedLead && w.leads.length === 2 && w.balance === 82);
  }

  // ─── § 3 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 3 refusals charge nothing');

  {
    const w = freshWorld();
    const e = await errOf(() => serviceFor(w).reveal(req('website')));
    assert('a field the listing does not have → 422 LISTING_FIELD_UNAVAILABLE, nothing charged', () =>
      e?.code === ERROR_CODES.LISTING_FIELD_UNAVAILABLE && e.statusCode === 422 && w.balance === 100 && w.leads.length === 0);
  }
  {
    const w = freshWorld({ blocked: true });
    const e = await errOf(() => serviceFor(w).reveal(req('phone')));
    assert('a blocked customer (L-29) → the NEUTRAL 422 LISTING_UNREACHABLE, nothing charged', () =>
      e?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === 100 && w.reveals.length === 0);
  }
  {
    const w = freshWorld({ vendor: { userId: OWNER_USER, active: true, isProvider: true, settings: { max_credits_per_customer_per_day: 10 } } });
    const svc = serviceFor(w);
    await svc.reveal(req('phone'));
    const e = await errOf(() => svc.reveal(req('email')));
    assert('the daily cap (L-30): 7 then 4 > 10 → 422 LISTING_REVEAL_DAILY_LIMIT, the 4 not charged', () =>
      e?.code === ERROR_CODES.LISTING_REVEAL_DAILY_LIMIT && w.balance === 93 && w.reveals.length === 1);
    w.reveals[0].refund = { at: w.now };
    const ok = await svc.reveal(req('email'));
    assert('a REFUNDED reveal stops counting toward the cap', () => ok.result.charged && ok.result.cost === 4);
  }
  {
    const w = freshWorld({ oembed: 'gone' });
    const e = await errOf(() => serviceFor(w).reveal(req('video')));
    assert('a YouTube video oEmbed calls gone → 422 LISTING_VIDEO_UNAVAILABLE, nothing charged', () =>
      e?.code === ERROR_CODES.LISTING_VIDEO_UNAVAILABLE && w.balance === 100 && w.leads.length === 0);
  }
  {
    const w = freshWorld({ oembed: 'unknown' });
    const out = await serviceFor(w).reveal(req('video'));
    assert('oEmbed unreachable FAILS OPEN: served and charged (§ C-8a)', () => out.result.charged && w.balance === 93);
  }
  {
    const w = freshWorld({ contacts: { ...freshWorld().contacts, video: { url: 'https://drive.google.com/file/d/x/view', host: 'google_drive' } }, oembed: 'gone' });
    const out = await serviceFor(w).reveal(req('video'));
    assert('a Drive link is never oEmbed-checked and is served as given', () => out.result.charged && (out.result.value as { host: string }).host === 'google_drive');
  }
  {
    const w = freshWorld();
    w.listing.status = 'suspended';
    w.listing.suspension = { reason: 'platform_oversight' };
    const e = await errOf(() => serviceFor(w).reveal(req('phone')));
    assert('a listing taken offline refuses a new customer, nothing charged', () => e?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === 100);
  }
  {
    const w = freshWorld();
    w.listing.published = null;
    const e = await errOf(() => serviceFor(w).reveal(req('phone')));
    assert('a listing never approved is the same 404 as an unknown one', () => e?.code === ERROR_CODES.LISTING_NOT_FOUND && e.statusCode === 404);
  }

  // ─── § 4 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 4 the grace path (L-10, L-11)');

  {
    const w = freshWorld({ balance: 8 });
    const svc = serviceFor(w);
    await svc.reveal(req('phone')); // 8 → 1, suspends
    w.listing.status = 'suspended';
    w.listing.suspension = { reason: 'insufficient_credits' };
    const grace = await svc.reveal(req('email'));
    assert('an engaged customer is served after the credit suspension, into debt (1 − 4 = −3)', () =>
      grace.result.charged && w.balance === -3 && w.reveals[1].charged_into_debt === true);
    const fresh = await errOf(() => svc.reveal(req('phone', { customerId: new Types.ObjectId().toString() })));
    assert('a NEW customer is refused on the suspended listing (it opens no lead)', () =>
      fresh?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === -3);
    const old = await svc.reveal(req('phone'));
    assert('an already-revealed field is still free during the suspension', () => !old.result.charged && w.balance === -3);
  }
  {
    const w = freshWorld({ balance: -3, vendor: { userId: OWNER_USER, active: true, isProvider: true, settings: { debt_floor: -5 } } });
    w.listing.status = 'suspended';
    w.listing.suspension = { reason: 'insufficient_credits' };
    w.leads.push({ _id: new Types.ObjectId(), customer_id: CUSTOMER, listing_id: LISTING.toString(), vendor_id: VENDOR.toString(), window_start: w.now, window_end: new Date(w.now.getTime() + DAY), engaged_while_live: true, fields_revealed: ['phone'], channel: 'whatsapp' });
    const e = await errOf(() => serviceFor(w).reveal(req('email')));
    assert('the provider\'s floor (L-11): −3 − 4 = −7 < −5 → neutral refusal, nothing written', () =>
      e?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === -3 && w.reveals.length === 0 && w.leads[0].fields_revealed.length === 1);
  }
  {
    const w = freshWorld({ balance: -3, vendor: { userId: OWNER_USER, active: true, isProvider: true, settings: { on_empty: 'stop' } } });
    w.listing.status = 'suspended';
    w.listing.suspension = { reason: 'insufficient_credits' };
    w.leads.push({ _id: new Types.ObjectId(), customer_id: CUSTOMER, listing_id: LISTING.toString(), vendor_id: VENDOR.toString(), window_start: w.now, window_end: new Date(w.now.getTime() + DAY), engaged_while_live: true, fields_revealed: ['phone'], channel: 'whatsapp' });
    const e = await errOf(() => serviceFor(w).reveal(req('email')));
    assert('on_empty = stop refuses even the engaged customer', () => e?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === -3);
  }
  {
    const w = freshWorld({ balance: 3 });
    const e = await errOf(() => serviceFor(w).reveal(req('phone')));
    assert('a LIVE listing whose provider cannot pay refuses a new customer (no lead to grant grace)', () =>
      e?.code === ERROR_CODES.LISTING_UNREACHABLE && w.balance === 3 && w.leads.length === 0);
    w.leads.push({ _id: new Types.ObjectId(), customer_id: CUSTOMER, listing_id: LISTING.toString(), vendor_id: VENDOR.toString(), window_start: w.now, window_end: new Date(w.now.getTime() + DAY), engaged_while_live: true, fields_revealed: ['whatsapp'], channel: 'whatsapp' });
    const ok = await serviceFor(w).reveal(req('phone'));
    assert('…and serves an engaged one through the debt path (3 − 4 = −1)', () => ok.result.charged && w.balance === -1);
  }

  // ─── § 5 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 5 below the first-reveal cost');

  {
    const w = freshWorld({ balance: 12 });
    const svc = serviceFor(w);
    await svc.reveal(req('phone')); // 12 → 5
    assert('a debit leaving 5 (< 7) suspends inside the transaction, and the events run after it', () =>
      w.suspendCalls === 1 && w.afterSuspendedCalls === 1);
    const w2 = freshWorld({ balance: 14 });
    await serviceFor(w2).reveal(req('phone')); // 14 → 7
    assert('a debit leaving exactly 7 suspends nothing', () => w2.suspendCalls === 0 && w2.afterSuspendedCalls === 0);
  }

  // ─── § 6 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 6 concurrency, own listing, the provider');

  {
    const w = freshWorld();
    w.failNextInsertAsDuplicate = true;
    const svc = serviceFor(w);
    // The winner's row exists by the time the loser re-reads (what a real race leaves behind).
    const realFind = (svc as unknown as { leads: { findCurrent: (...a: unknown[]) => Promise<unknown> } }).leads.findCurrent;
    let calls = 0;
    (svc as unknown as { leads: { findCurrent: (...a: unknown[]) => Promise<unknown> } }).leads.findCurrent = async (...a: unknown[]) => {
      calls++;
      if (calls === 3) {
        return { _id: new Types.ObjectId(), customer_id: CUSTOMER, listing_id: LISTING.toString(), window_end: new Date(w.now.getTime() + DAY), engaged_while_live: true, fields_revealed: ['phone'] };
      }
      return realFind(...a);
    };
    const out = await svc.reveal(req('phone'));
    assert('a concurrent identical tap (E11000) answers with the winner\'s reveal, free, and rolls the debit back', () =>
      !out.result.charged && out.result.alreadyRevealed && w.balance === 100 && w.ledgerRows.length === 0);
  }
  {
    const w = freshWorld();
    const out = await serviceFor(w).reveal(req('phone', { userId: OWNER_USER }));
    assert('a provider revealing their OWN listing gets it free and opens no lead (§ C-8a)', () =>
      !out.result.charged && !out.openedLead && w.balance === 100 && w.leads.length === 0 && out.result.windowEndsAt === null);
  }
  {
    const w = freshWorld({ vendor: { userId: OWNER_USER, active: false, isProvider: true, settings: null } });
    const e = await errOf(() => serviceFor(w).reveal(req('phone')));
    assert('an inactive provider is unreachable', () => e?.code === ERROR_CODES.LISTING_UNREACHABLE);
    const w2 = freshWorld({ vendor: { userId: OWNER_USER, active: true, isProvider: false, settings: null } });
    const e2 = await errOf(() => serviceFor(w2).reveal(req('phone')));
    assert('a listing whose vendor is not a provider is a 404', () => e2?.code === ERROR_CODES.LISTING_NOT_FOUND);
  }

  // ─── § 7 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 7 source scans');

  const src = code('src/modules/listings/domain/services/listing-reveal.service.ts');
  assert('⛔ the reveal never names the contact model — only readPublishedField', () =>
    !/ListingContactModel|listing-contact\.model/.test(src) && /this\.contacts\.readPublishedField\(/.test(src));
  assert('⛔ the debt path is reached from exactly one place in the reveal', () => (src.match(/debitAllowingDebtInSession\(/g) ?? []).length === 1);
  assert('⛔ the value is checked (absent / video gone) BEFORE the transaction that charges', () =>
    src.indexOf('await this.assertVideoWatchable(') > 0 && src.indexOf('await this.assertVideoWatchable(') < src.indexOf('runInTransactionWithRetry('));
  assert('⛔ the suspension events run after the transaction, never inside it', () =>
    src.indexOf('this.funding.afterSuspended(') > src.indexOf('runInTransactionWithRetry('));
  assert('the AppError import is used for the insufficient-credits fall-back (not a string match)', () =>
    /err instanceof AppError && err\.code === ERROR_CODES\.BILLING_INSUFFICIENT_CREDITS/.test(src));
  assert('AppError is the class createAppError builds (sanity for the fall-back)', () =>
    createAppError(ERROR_CODES.BILLING_INSUFFICIENT_CREDITS, 402) instanceof AppError);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
