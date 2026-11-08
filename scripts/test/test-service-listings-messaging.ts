/**
 * test:service-listings-messaging — a provider's leads, messages and reports, the admin's report
 * actions, and the bot's listing buttons (SERVICE-LISTINGS-PLAN L-13 … L-16, L-24, L-25, L-29,
 * L-31, § C-3, § C-3a). DB-free: pure rules, services driven with in-memory fakes, source scans.
 *
 *   § 1  what a provider sees of a customer (L-13) and which channel a message takes
 *   § 2  the caps and the refusals (L-14, L-15, L-24)
 *   § 3  ListingLeadService: call-me charges 2 and refunds a send that did not go; free text
 *   § 4  the report (L-31): reveals must be on the lead; one open report per lead
 *   § 5  ListingReportAdminService: the refund (once, published after commit) and the block
 *   § 6  the bot: tokens round-trip, cards carry no value, reveal replies draw the right shape
 *   § 7  catalogue + template + wiring scans
 *
 * Run: npm run test:service-listings-messaging
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import { ERROR_CODES } from '../../src/core/error-codes';
import { createAppError } from '../../src/core/errors';
import { LISTING_CONTACT_FIELDS } from '../../src/modules/listings/domain/listing.types';
import {
  callMeNumbers,
  maskedDisplayName,
  maskedPhone,
  messageChannelFor,
  messageRefusal,
  messagesLeft,
} from '../../src/modules/listings/domain/lead-rules';
import { ListingLeadService } from '../../src/modules/listings/domain/services/listing-lead.service';
import { ListingReportAdminService } from '../../src/modules/listings/domain/services/listing-report-admin.service';
import { LeadReportBodySchema } from '../../src/modules/listings/validators/listing.validator';
import { CreateTicketSchema } from '../../src/modules/tickets/validators/ticket.validator';
import {
  LISTING_FIELD_CODES,
  listingConsentActionId,
  listingRevealActionId,
  listingShowActionId,
  parseBotActionId,
  parseListingConsentArgument,
  parseListingRevealArgument,
  parseListingShowArgument,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { listingCardIntent, revealReplyIntent } from '../../src/modules/bot-surface/domain/bot-listing-reply';
import {
  LISTING_MESSAGE_CATALOG,
  LISTING_STOP_LABEL,
  listingStopToken,
  renderListingMessageButton,
} from '../../src/modules/notifications/catalog/listing-message-catalog';
import { NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/notification-catalog';
import { LISTING_SITUATIONS } from '../../src/modules/notifications/services/vendor-notification-event-handler.service';

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
async function errOf(fn: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number; details?: Record<string, unknown> } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as { code?: string; statusCode?: number; details?: Record<string, unknown> };
  }
}

const ROOT = path.join(__dirname, '..', '..');
const raw = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel: string): string => raw(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const VENDOR = new Types.ObjectId().toString();
const LISTING = new Types.ObjectId();
const CUSTOMER = new Types.ObjectId();
const LEAD = new Types.ObjectId();
const NOW = new Date('2026-11-07T12:00:00Z');

// ─── A lead world for ListingLeadService ─────────────────────────────────────

interface LeadWorld {
  consent: 'granted' | 'none' | 'revoked';
  connected: { whatsapp: boolean; telegram: boolean };
  windowOpen: boolean;
  counts: { total: number; callMe: number };
  contacts: Record<string, string | null>;
  sendOk: boolean;
  balance: number;
  messages: Array<{ _id: Types.ObjectId; kind: string; status: string; credits: number; channel: string; at: Date }>;
  ledger: Array<{ type: string; amount: number; ref: string }>;
  sent: Array<Record<string, unknown>>;
  openReport: boolean;
  tickets: Array<Record<string, unknown>>;
  revealIds: string[];
  customerStatus: string;
}

function leadWorld(over: Partial<LeadWorld> = {}): LeadWorld {
  return {
    consent: 'granted',
    connected: { whatsapp: true, telegram: false },
    windowOpen: true,
    counts: { total: 0, callMe: 0 },
    contacts: { phone: '+237233445566', whatsapp: '+237671234531' },
    sendOk: true,
    balance: 10,
    messages: [],
    ledger: [],
    sent: [],
    openReport: false,
    tickets: [],
    revealIds: [new Types.ObjectId().toString(), new Types.ObjectId().toString()],
    customerStatus: 'active',
    ...over,
  };
}

function leadService(w: LeadWorld): ListingLeadService {
  const lead = { _id: LEAD, customer_id: CUSTOMER, listing_id: LISTING, vendor_id: new Types.ObjectId(VENDOR), channel: 'whatsapp', window_start: NOW, window_end: new Date(NOW.getTime() + 86400000), fields_revealed: ['phone'] };
  const svc = new ListingLeadService(
    { findOwned: async (id: string, v: string) => (id === LEAD.toString() && v === VENDOR ? lead : null), pageForVendor: async () => ({ data: [lead], total: 1 }) } as never,
    { findById: async () => ({ _id: LISTING, vendor_id: new Types.ObjectId(VENDOR), published: { title: 'Plumbing', company_name: 'Akwa Plumbers' }, available_fields: ['phone', 'whatsapp'] }) } as never,
    { readPublishedField: async (_l: string, f: string) => w.contacts[f] ?? null } as never,
    { findByLeadIds: async () => w.revealIds.map((id) => ({ _id: new Types.ObjectId(id), lead_id: LEAD, field: 'phone', cost: 7, refund: null, at: NOW })) } as never,
    {
      find: async () => (w.consent === 'none' ? null : { granted_at: NOW, revoked_at: w.consent === 'revoked' ? NOW : null, asked_at: NOW }),
      towardProvider: async () => new Map(w.consent === 'none' ? [] : [[CUSTOMER.toString(), { granted_at: NOW, revoked_at: w.consent === 'revoked' ? NOW : null }]]),
    } as never,
    {
      countsSince: async () => w.counts,
      countsSinceForCustomers: async () => new Map([[CUSTOMER.toString(), w.counts]]),
      claim: async (input: { kind: string; channel: string; credits: number; at: Date }) => {
        const row = { _id: new Types.ObjectId(), kind: input.kind, status: 'sent', credits: input.credits, channel: input.channel, at: input.at };
        w.messages.push(row);
        return row;
      },
      markSent: async () => undefined,
      markFailed: async (id: Types.ObjectId) => { const m = w.messages.find((x) => x._id.equals(id)); if (m) m.status = 'failed'; },
    } as never,
    { send: async (d: Record<string, unknown>) => { w.sent.push(d); return { ok: w.sendOk, providerMessageId: w.sendOk ? 'wamid.x' : null, via: w.sendOk ? 'text' : null }; } } as never,
    {
      debit: async (_t: string, _o: string, amount: number, _r: string, ref: string) => {
        if (w.balance < amount) throw createAppError(ERROR_CODES.BILLING_INSUFFICIENT_CREDITS, 402);
        w.balance -= amount;
        w.ledger.push({ type: 'debit', amount: -amount, ref });
        return { balance: w.balance };
      },
      credit: async (_t: string, _o: string, amount: number, type: string, _r: string, ref: string) => {
        w.balance += amount;
        w.ledger.push({ type, amount, ref });
        return { balance: w.balance };
      },
    } as never,
    { createTicket: async (input: Record<string, unknown>) => { const t = { ...input, id: new Types.ObjectId().toString() }; w.tickets.push(t); return t; } } as never,
    { canSendFreeMessage: async () => w.windowOpen } as never,
    2,
    () => NOW,
  );
  // The three reads that go straight to other modules' models, replaced for a DB-free run.
  const s = svc as unknown as Record<string, unknown>;
  s.customersById = async () => new Map([[CUSTOMER.toString(), { _id: CUSTOMER, user_id: new Types.ObjectId(), name: 'Jean-Paul Kamga', phone: '+237671234531', status: w.customerStatus, closed_at: null, preferences: { language: 'fr' } }]]);
  s.chatFactsOf = async () => ({ connected: w.connected, whatsappId: w.connected.whatsapp ? '237671234531' : null, whatsappWindowOpen: w.windowOpen });
  s.openReportLeadIds = async (ids: string[]) => new Set(w.openReport ? ids : []);
  return svc;
}

async function main(): Promise<void> {
  // ─── § 1 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 1 the masked customer and the channel');

  assert('"Jean-Paul Kamga" → "Jean-Paul K."; one word stays; nothing → null', () =>
    maskedDisplayName('Jean-Paul Kamga') === 'Jean-Paul K.' && maskedDisplayName('  Amina ') === 'Amina'
    && maskedDisplayName('Ama Kofi Mensah') === 'Ama M.' && maskedDisplayName('') === null);
  assert('"+237 6 71 23 45 31" → "+237 ••• ••• •31" — the code and the last two digits only (L-13)', () =>
    maskedPhone('+237 6 71 23 45 31') === '+237 ••• ••• •31' && maskedPhone('+1 876 555 0199') === '+1876 ••• ••• •99');
  assert('⛔ a masked number never carries more than its code and two digits', () => {
    const m = maskedPhone('+237671234531')!;
    return !m.includes('6712345') && (m.match(/\d/g) ?? []).length === '237'.length + 2;
  });
  assert('the lead\'s own chat first, then Telegram, then WhatsApp; none → null', () =>
    messageChannelFor('whatsapp', { whatsapp: true, telegram: true }) === 'whatsapp'
    && messageChannelFor('web', { whatsapp: true, telegram: true }) === 'telegram'
    && messageChannelFor('telegram', { whatsapp: true, telegram: false }) === 'whatsapp'
    && messageChannelFor('web', { whatsapp: false, telegram: false }) === null);
  assert('call-me shows the PHONE and chats on the WhatsApp; either alone serves both', () => {
    const both = callMeNumbers('+2372', '+2376');
    return both?.display === '+2372' && both.chat === '+2376' && callMeNumbers(null, '+2376')?.display === '+2376' && callMeNumbers(null, null) === null;
  });

  // ─── § 2 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 2 the caps and the refusals');

  const base = { consentGranted: true, channel: 'whatsapp' as const, whatsappWindowOpen: true, hasCallableNumber: true, counts: { total: 0, callMe: 0 } };
  assert('no opt-in → both refused with CONSENT_REQUIRED (L-14)', () =>
    messageRefusal('call_me', { ...base, consentGranted: false }) === 'LISTING_MESSAGE_CONSENT_REQUIRED'
    && messageRefusal('free_text', { ...base, consentGranted: false }) === 'LISTING_MESSAGE_CONSENT_REQUIRED');
  assert('no linked chat → CHANNEL_UNAVAILABLE', () => messageRefusal('free_text', { ...base, channel: null }) === 'LISTING_MESSAGE_CHANNEL_UNAVAILABLE');
  assert('3 messages in 30 days → CAP_REACHED for both (L-24)', () =>
    messageRefusal('free_text', { ...base, counts: { total: 3, callMe: 0 } }) === 'LISTING_MESSAGE_CAP_REACHED'
    && messageRefusal('call_me', { ...base, counts: { total: 3, callMe: 1 } }) === 'LISTING_MESSAGE_CAP_REACHED');
  assert('one call-me per 30 days → CALL_ME_ALREADY_SENT, free text still allowed', () =>
    messageRefusal('call_me', { ...base, counts: { total: 1, callMe: 1 } }) === 'LISTING_CALL_ME_ALREADY_SENT'
    && messageRefusal('free_text', { ...base, counts: { total: 1, callMe: 1 } }) === null);
  assert('free text outside WhatsApp\'s window → WINDOW_CLOSED; call-me goes (a template)', () =>
    messageRefusal('free_text', { ...base, whatsappWindowOpen: false }) === 'LISTING_MESSAGE_WINDOW_CLOSED'
    && messageRefusal('call_me', { ...base, whatsappWindowOpen: false }) === null);
  assert('Telegram has no window: free text always goes there', () =>
    messageRefusal('free_text', { ...base, channel: 'telegram', whatsappWindowOpen: false }) === null);
  assert('call-me with no phone and no WhatsApp on the listing → FIELD_UNAVAILABLE', () =>
    messageRefusal('call_me', { ...base, hasCallableNumber: false }) === 'LISTING_FIELD_UNAVAILABLE');
  assert('messagesLeft counts down from 3 and never goes negative', () =>
    messagesLeft({ total: 0, callMe: 0 }) === 3 && messagesLeft({ total: 2, callMe: 1 }) === 1 && messagesLeft({ total: 5, callMe: 1 }) === 0);

  // ─── § 3 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 3 call-me and free text');

  {
    const w = leadWorld();
    const out = await leadService(w).callMe(VENDOR, LEAD.toString());
    assert('call-me charges 2 credits as a whatsapp_template, the ref being the message row', () =>
      out.message.status === 'sent' && out.message.credits === 2 && w.balance === 8
      && w.ledger.length === 1 && w.ledger[0].ref === out.message.id);
    assert('it carries the business name, the PHONE to call and the WhatsApp to chat on', () =>
      w.sent[0].businessName === 'Akwa Plumbers' && w.sent[0].providerPhone === '+237233445566'
      && w.sent[0].chatNumber === '+237671234531' && w.sent[0].situation === 'listing.call_me' && w.sent[0].lang === 'fr');
  }
  {
    const w = leadWorld({ sendOk: false });
    const out = await leadService(w).callMe(VENDOR, LEAD.toString());
    assert('a send that does not go: the row turns failed and the 2 credits come back', () =>
      out.message.status === 'failed' && out.message.credits === 0 && w.balance === 10
      && w.ledger.map((l) => l.type).join() === 'debit,refund' && w.messages[0].status === 'failed');
  }
  {
    const w = leadWorld({ balance: 1 });
    const e = await errOf(() => leadService(w).callMe(VENDOR, LEAD.toString()));
    assert('a provider who cannot pay: 402 BILLING_INSUFFICIENT_CREDITS, the claim released, nothing sent', () =>
      e?.code === ERROR_CODES.BILLING_INSUFFICIENT_CREDITS && w.messages[0].status === 'failed' && w.sent.length === 0);
  }
  {
    const w = leadWorld({ consent: 'revoked' });
    const e = await errOf(() => leadService(w).message(VENDOR, LEAD.toString(), 'Hello'));
    assert('a WITHDRAWN opt-in refuses with 422 LISTING_MESSAGE_CONSENT_REQUIRED', () =>
      e?.code === ERROR_CODES.LISTING_MESSAGE_CONSENT_REQUIRED && e.statusCode === 422 && w.messages.length === 0);
  }
  {
    const w = leadWorld({ customerStatus: 'inactive' });
    const e = await errOf(() => leadService(w).message(VENDOR, LEAD.toString(), 'Hello'));
    assert('a closed or deactivated customer is unreachable whatever their consent row says (O-20)', () =>
      e?.code === ERROR_CODES.LISTING_MESSAGE_CONSENT_REQUIRED);
  }
  {
    const w = leadWorld({ windowOpen: false });
    const e = await errOf(() => leadService(w).message(VENDOR, LEAD.toString(), 'Hello'));
    assert('free text outside the window → 422 LISTING_MESSAGE_WINDOW_CLOSED, nothing charged', () =>
      e?.code === ERROR_CODES.LISTING_MESSAGE_WINDOW_CLOSED && w.ledger.length === 0);
  }
  {
    const w = leadWorld({ counts: { total: 2, callMe: 0 } });
    const out = await leadService(w).message(VENDOR, LEAD.toString(), 'Je passe demain à 9h');
    assert('free text is never charged and is relayed as written', () =>
      out.message.credits === 0 && w.balance === 10 && w.sent[0].messageBody === 'Je passe demain à 9h');
  }
  {
    const w = leadWorld({ counts: { total: 3, callMe: 1 } });
    const e = await errOf(() => leadService(w).message(VENDOR, LEAD.toString(), 'x'));
    assert('the cap answers with messagesLeft: 0 in details', () =>
      e?.code === ERROR_CODES.LISTING_MESSAGE_CAP_REACHED && e.details?.messagesLeft === 0);
  }
  {
    const e = await errOf(() => leadService(leadWorld()).callMe(new Types.ObjectId().toString(), LEAD.toString()));
    assert('another provider\'s lead is a 404 LISTING_LEAD_NOT_FOUND', () => e?.code === ERROR_CODES.LISTING_LEAD_NOT_FOUND && e.statusCode === 404);
  }
  {
    const w = leadWorld();
    const page = await leadService(w).list(VENDOR, { page: 1, limit: 20 });
    const row = page.data[0];
    assert('the lead row is masked and says what the dashboard may show', () =>
      row.customer.displayName === 'Jean-Paul K.' && row.customer.maskedPhone === '+237 ••• ••• •31'
      && row.consent === 'granted' && row.callMeAvailable && row.freeTextAvailable && row.messagesLeft === 3
      && row.fields.length === 2 && !row.reportOpen && !JSON.stringify(row).includes('671234531'));
    const w2 = leadWorld({ consent: 'none' });
    const row2 = (await leadService(w2).list(VENDOR, { page: 1, limit: 20 })).data[0];
    assert('no opt-in: both buttons unavailable and consent says not_granted', () =>
      row2.consent === 'not_granted' && !row2.callMeAvailable && !row2.freeTextAvailable);
  }

  // ─── § 4 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 4 the report (L-31)');

  {
    const w = leadWorld();
    const out = await leadService(w).report(VENDOR, new Types.ObjectId().toString(), LEAD.toString(), {
      wants: ['refund', 'check_customer'], revealIds: [w.revealIds[0]], reason: 'Same person, five numbers, all today',
    });
    const t = w.tickets[0];
    assert('one LISTING_LEAD_REPORT ticket on the LISTING_LEAD, metadata { listingId, wants, revealIds }', () =>
      t.type === 'LISTING_LEAD_REPORT' && t.entityType === 'LISTING_LEAD' && t.entityId === LEAD.toString()
      && JSON.stringify(t.metadata) === JSON.stringify({ listingId: LISTING.toString(), wants: ['refund', 'check_customer'], revealIds: [w.revealIds[0]] }));
    assert('answers { ticketId, ticketNumber } — the number is the short #XXXXXX reference', () =>
      out.ticketId === t.id && out.ticketNumber === `#${String(t.id).slice(-6).toUpperCase()}`);
  }
  {
    const w = leadWorld();
    const e = await errOf(() => leadService(w).report(VENDOR, 'u', LEAD.toString(), { wants: ['refund'], revealIds: [new Types.ObjectId().toString()], reason: 'Not my customer at all' }));
    assert('a reveal that is not on this lead → 422 LISTING_REPORT_INVALID naming it', () =>
      e?.code === ERROR_CODES.LISTING_REPORT_INVALID && Array.isArray(e.details?.revealIds) && w.tickets.length === 0);
    const e2 = await errOf(() => leadService(w).report(VENDOR, 'u', LEAD.toString(), { wants: ['refund'], revealIds: [], reason: 'Please refund this one' }));
    assert('a refund wish naming no reveal → 422 LISTING_REPORT_INVALID', () => e2?.code === ERROR_CODES.LISTING_REPORT_INVALID);
    const w3 = leadWorld({ openReport: true });
    const e3 = await errOf(() => leadService(w3).report(VENDOR, 'u', LEAD.toString(), { wants: ['check_customer'], revealIds: [], reason: 'Checking this one again' }));
    assert('a second report while one is open → 422 with details.reason report_open', () =>
      e3?.code === ERROR_CODES.LISTING_REPORT_INVALID && e3.details?.reason === 'report_open');
  }
  assert('the report body: 1–2 distinct wishes, a 10–700 character reason', () =>
    LeadReportBodySchema.safeParse({ wants: ['refund', 'refund'], reason: '0123456789' }).success === false
    && LeadReportBodySchema.safeParse({ wants: [], reason: '0123456789' }).success === false
    && LeadReportBodySchema.safeParse({ wants: ['check_customer'], reason: 'short' }).success === false
    && LeadReportBodySchema.safeParse({ wants: ['check_customer'], reason: 'x'.repeat(701) }).success === false
    && LeadReportBodySchema.safeParse({ wants: ['check_customer'], reason: 'x'.repeat(700) }).success === true);
  assert('⛔ the generic ticket form refuses a lead report (only the lead\'s own route opens one)', () =>
    !CreateTicketSchema.safeParse({ subject: 's', description: 'd', type: 'LISTING_LEAD_REPORT', importance: 'medium', entityType: 'OTHER' }).success
    && !CreateTicketSchema.safeParse({ subject: 's', description: 'd', type: 'OTHER', importance: 'medium', entityType: 'LISTING_LEAD', entityId: LEAD.toString() }).success);

  // ─── § 5 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 5 the administrator\'s refund and block');

  {
    const revealId = new Types.ObjectId();
    let refundStamp: Record<string, unknown> | null = null;
    let balance = -3;
    const credits: number[] = [];
    let raced = false;
    const admin = new ListingReportAdminService(
      {
        findById: async () => ({ _id: revealId, vendor_id: new Types.ObjectId(VENDOR), cost: 7, refund: refundStamp }),
        markRefunded: async (_id: Types.ObjectId, stamp: Record<string, unknown>) => { if (refundStamp || raced) return false; refundStamp = stamp; return true; },
        ledgerRefFor: async () => 'ledger-refund',
      } as never,
      { place: async () => null, lift: async () => null } as never,
      { findById: async () => ({ _id: LISTING, vendor_id: new Types.ObjectId(VENDOR) }) } as never,
      {
        creditInSession: async (_t: string, _o: string, amount: number) => { balance += amount; credits.push(amount); return { balance, owner_type: 'vendor', owner_id: new Types.ObjectId(VENDOR) }; },
        getBalance: async () => balance,
      } as never,
      {
        runInTransactionWithRetry: async <T>(fn: (s: never) => Promise<T>): Promise<T> => {
          const before = { balance, credits: credits.length };
          try { return await fn({} as never); } catch (err) { balance = before.balance; credits.length = before.credits; throw err; }
        },
      },
      () => NOW,
    );
    const actor = { userId: new Types.ObjectId().toString(), source: 'admin' as const, name: 'Ada' };
    const out = await admin.refundReveal(revealId.toString(), { note: 'Drain confirmed', ticketId: null }, actor);
    assert('a refund credits the reveal\'s cost and pays the debt first (−3 + 7 = 4)', () =>
      out.refundedCredits === 7 && out.balanceAfter === 4 && credits.join() === '7');
    assert('the stamp names the administrator, the ledger row and the note', () =>
      refundStamp?.by_source === 'admin' && refundStamp?.by_name === 'Ada' && refundStamp?.ledger_ref === 'ledger-refund' && refundStamp?.note === 'Drain confirmed');
    const again = await errOf(() => admin.refundReveal(revealId.toString(), { note: 'again' }, actor));
    assert('a second refund → 409 LISTING_REVEAL_ALREADY_REFUNDED', () => again?.code === ERROR_CODES.LISTING_REVEAL_ALREADY_REFUNDED && again.statusCode === 409);
    refundStamp = null;
    raced = true;
    balance = 0;
    const lost = await errOf(() => admin.refundReveal(revealId.toString(), { note: 'race' }, actor));
    assert('losing the race to another administrator rolls the credit back and answers 409', () =>
      lost?.code === ERROR_CODES.LISTING_REVEAL_ALREADY_REFUNDED && balance === 0);
    const dup = await errOf(() => admin.blockCustomer(LISTING.toString(), CUSTOMER.toString(), { reason: 'Drainer' }, actor));
    assert('a block where one is active → 409 LISTING_REVEAL_BLOCK_EXISTS', () => dup?.code === ERROR_CODES.LISTING_REVEAL_BLOCK_EXISTS);
    const none = await errOf(() => admin.liftBlock(LISTING.toString(), CUSTOMER.toString(), null, actor));
    assert('a lift with no active block → 404 LISTING_REVEAL_BLOCK_NOT_FOUND', () => none?.code === ERROR_CODES.LISTING_REVEAL_BLOCK_NOT_FOUND);
  }
  const adminSrc = code('src/modules/listings/domain/services/listing-report-admin.service.ts');
  assert('⛔ the refund publishes billing.wallet.credited AFTER its transaction (a refund may resume listings)', () =>
    adminSrc.indexOf('publishWalletCredited(') > adminSrc.indexOf('runInTransactionWithRetry('));

  // ─── § 6 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 6 the bot');

  const id = LISTING.toString();
  assert('the seven field codes agree with LISTING_CONTACT_FIELDS, one letter each, all distinct', () =>
    JSON.stringify(Object.keys(LISTING_FIELD_CODES)) === JSON.stringify([...LISTING_CONTACT_FIELDS])
    && new Set(Object.values(LISTING_FIELD_CODES)).size === 7 && Object.values(LISTING_FIELD_CODES).every((c) => c.length === 1));
  assert('ls / lr / lc round-trip through the dispatcher\'s parser and their own', () =>
    LISTING_CONTACT_FIELDS.every((f) => {
      const t = parseBotActionId(listingRevealActionId(id, f));
      return t?.verb === 'lr' && parseListingRevealArgument(t.argument)?.field === f;
    })
    && parseListingShowArgument(parseBotActionId(listingShowActionId(id))!.argument) === id
    && parseListingConsentArgument(parseBotActionId(listingConsentActionId(VENDOR, false))!.argument)?.granted === false);
  assert('every listing token fits Telegram\'s 64 bytes (lr: is 29)', () =>
    Buffer.byteLength(listingRevealActionId(id, 'video')) === 29 && Buffer.byteLength(listingConsentActionId(VENDOR, true)) === 29);
  assert('malformed arguments parse to null (bad id, unknown code, extra segment, bad answer)', () =>
    parseListingRevealArgument('nothex:w') === null && parseListingRevealArgument(`${id}:z`) === null
    && parseListingRevealArgument(`${id}:w:x`) === null && parseListingConsentArgument(`${VENDOR}:maybe`) === null
    && parseListingShowArgument('') === null);
  assert('the opt-out quick reply in relayed messages IS the lc:<vendorId>:n token', () => listingStopToken(VENDOR) === listingConsentActionId(VENDOR, false));

  const card = listingCardIntent({ id, title: 'Plumbing', companyName: 'Akwa Plumbers', city: 'Douala', area: 'Akwa', availableFields: ['phone', 'video', 'whatsapp'] }, 'en') as unknown as { kind: string; options: Array<{ id: string; label: string }>; text: string };
  assert('a card is a choice with one row per AVAILABLE field, in the plan\'s order, carrying names only', () =>
    card.kind === 'choice' && card.options.map((o) => o.id).join() === [listingRevealActionId(id, 'whatsapp'), listingRevealActionId(id, 'phone'), listingRevealActionId(id, 'video')].join()
    && card.text.includes('first name and part of your number'));
  assert('every row label fits WhatsApp\'s 24-character list title, in every language', () =>
    ['en', 'fr', 'pt', 'es', 'ar'].every((lang) => (listingCardIntent({ id, title: 't', companyName: 'c', city: 'x', area: 'y', availableFields: [...LISTING_CONTACT_FIELDS] }, lang) as unknown as { options: Array<{ label: string }> })
      .options.every((o) => [...o.label].length <= 24)));
  const loc = revealReplyIntent({ listingId: id, vendorId: VENDOR, businessName: 'Akwa Plumbers', field: 'location', value: { address: 'Rue 1', latitude: 4.05, longitude: 9.7, mapUrl: '' }, hasVideo: true, videoAlreadyRevealed: false, askConsent: true }, 'en') as unknown as { kind: string; parts: Array<{ kind: string; options?: Array<{ id: string }> }> };
  assert('a location reveal: the map pin, the video offer (lr:<id>:v), then the opt-in question', () =>
    loc.kind === 'sequence' && loc.parts.map((p) => p.kind).join() === 'place,choice,choice'
    && loc.parts[1].options?.[0].id === listingRevealActionId(id, 'video')
    && loc.parts[2].options?.map((o) => o.id).join() === [listingConsentActionId(VENDOR, true), listingConsentActionId(VENDOR, false)].join());
  const wa = revealReplyIntent({ listingId: id, vendorId: VENDOR, businessName: 'Akwa Plumbers', field: 'whatsapp', value: { number: '+237671234531', link: 'https://wa.me/237671234531' }, hasVideo: false, videoAlreadyRevealed: false, askConsent: false }, 'fr') as unknown as { kind: string; url: string };
  assert('a WhatsApp reveal is a link to wa.me; no opt-in question when not asked', () => wa.kind === 'link' && wa.url === 'https://wa.me/237671234531');

  // ─── § 7 ───────────────────────────────────────────────────────────────────
  console.log('\n§ 7 catalogue, templates and wiring');

  const catalog = JSON.parse(raw('api-doc/n8n/tools/catalog.json')) as { tools: Array<{ name: string; tier: string; mutating: boolean }> };
  const tool = (n: string) => catalog.tools.find((t) => t.name === n);
  assert('⛔ listings_reveal and listings_consent are flow_only (never model-facing) and mutating', () =>
    tool('listings_reveal')?.tier === 'flow_only' && tool('listings_consent')?.tier === 'flow_only'
    && tool('listings_reveal')?.mutating === true && tool('listings_consent')?.mutating === true);
  assert('listings_display and listings_get are model-facing reads', () =>
    tool('listings_display')?.tier !== 'flow_only' && tool('listings_get')?.tier !== 'flow_only'
    && tool('listings_display')?.mutating === false && tool('listings_get')?.mutating === false);
  assert('⛔ the call-me template has NO URL button (Meta refuses one that opens WhatsApp, 2026-11-07)', () =>
    renderListingMessageButton('listing.call_me', 'en', {}) === null);
  assert('the call-me template carries the business and the number; the free text has no template', () =>
    JSON.stringify(LISTING_MESSAGE_CATALOG['listing.call_me'].template?.bodyParams) === JSON.stringify(['{{businessName}}', '{{providerPhone}}'])
    && LISTING_MESSAGE_CATALOG['listing.provider_message'].template === null);
  assert('the opt-out label fits the 20-character quick-reply limit in every language', () =>
    Object.values(LISTING_STOP_LABEL).every((l) => [...l].length <= 20));
  assert('the five provider situations are catalogued, each with a vendor_listing_* template', () =>
    [...LISTING_SITUATIONS].every((s) => (NOTIFICATION_CATALOG[s].whatsapp.template?.name ?? '').startsWith('vendor_listing_'))
    && LISTING_SITUATIONS.size === 5);
  const consumer = code('src/modules/notifications/vendor-notification-event-consumer.ts');
  assert('the vendor consumer subscribes the five listing events (and not listing.submitted)', () =>
    ['listing.approved', 'listing.rejected', 'listing.suspended', 'listing.resumed', 'listing.video_unavailable'].every((e) => consumer.includes(`'${e}'`))
    && !consumer.includes("'listing.submitted'"));
  const leadRoutes = code('src/modules/listings/routes/vendor-lead.routes.ts');
  assert('⛔ the lead router is provider-only at router level and carries the four routes', () =>
    /router\.use\(requireVendorKind\('provider'\)\)/.test(leadRoutes)
    && ["router.get('/'", "'/:leadId/call-me'", "'/:leadId/message'", "'/:leadId/report'"].every((r) => leadRoutes.includes(r)));
  const internal = code('src/api/routes/internal-admin.routes.ts');
  assert('the reveal refund is mounted at /listing-reveals behind requireAdminCaller', () =>
    /router\.use\('\/listing-reveals', buildAdminListingRevealRouter\(\[requireAdminCaller\]\)\)/.test(internal));
  const leadSvc = code('src/modules/listings/domain/services/listing-lead.service.ts');
  assert('⛔ the lead service reaches contacts only through readPublishedField, for the call-me numbers', () =>
    !/ListingContactModel|listing-contact\.model/.test(leadSvc) && (leadSvc.match(/readPublishedField\(/g) ?? []).length === 2);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
