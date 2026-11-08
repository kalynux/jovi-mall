import { Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { WHATSAPP_TEMPLATE_COST } from '../../../billing/config/credit.config';
import { connectionService } from '../../../channel-connections';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';
import { CustomerModel } from '../../../customers/customer.model';
import { TicketModel } from '../../../tickets/models/ticket.model';
import { TicketService } from '../../../tickets/services/ticket.service';
import { ActorRole, EntityType, TicketImportance, TicketType, TERMINAL_TICKET_STATUSES } from '../../../tickets/types/ticket.types';
import { resolveLanguage, Language } from '../../../notifications/catalog/notification-i18n';
import { shortRequestReference } from '../../../bot-surface/domain/bot-ticket-rows';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import { listingContactRepository, ListingContactRepository } from '../../repositories/listing-contact.repository';
import { listingLeadRepository, ListingLeadRepository, ListingLeadRow } from '../../repositories/listing-lead.repository';
import { listingRevealRepository, ListingRevealRepository, ListingRevealRow } from '../../repositories/listing-reveal.repository';
import { providerConsentRepository, ProviderConsentRepository } from '../../repositories/provider-consent.repository';
import { providerMessageRepository, ProviderMessageRepository, ProviderMessageRow } from '../../repositories/provider-message.repository';
import { ListingContactField, ProviderMessageChannel, ProviderMessageKind } from '../listing.types';
import {
  callMeNumbers,
  ConnectedChannels,
  maskedDisplayName,
  maskedPhone,
  messageCapWindowStart,
  MessageCounts,
  messageChannelFor,
  messageRefusal,
  messagesLeft,
} from '../lead-rules';
import { consentStateOf, ConsentState } from './listing-consent.service';
import { providerMessageSender, ProviderMessageSender } from './provider-message.sender';
import { LeadReportBody, VendorLeadListQuery } from '../../validators/listing.validator';

/**
 * A provider's leads (SERVICE-LISTINGS-PLAN L-13 … L-16, L-24, L-31, § C-3 "Provider"):
 *
 *   list      GET  /api/vendor/leads                  masked, newest first, with what each row may show
 *   report    POST /api/vendor/leads/:leadId/report    ONE `LISTING_LEAD_REPORT` ticket
 *   callMe    POST /api/vendor/leads/:leadId/call-me   the call-me message, 2 credits
 *   message   POST /api/vendor/leads/:leadId/message   free text, no credits, window-aware
 *
 * ⛔ **The provider never sees the customer's number** (L-13): a first name, a last initial and
 * the country code with the last two digits. The administrator working a report sees the rest,
 * in wi-admin.
 *
 * ── The money of a message ───────────────────────────────────────────────────
 * Call-me costs `CREDIT_COST_WHATSAPP_TEMPLATE` on every channel, so the price does not depend
 * on where the customer happens to be reachable. The row is CLAIMED before the debit and the
 * send (so a second tap sees it in the caps), and a send that does not go turns the row
 * `failed` — it stops counting — and refunds the credits. Free text is never charged.
 * The caps count by a read then a write, not a lock: two taps in the same instant can pass one
 * over the cap. Bounded (one message) and accepted.
 */

export interface VendorLeadRow {
  id: string;
  listingId: string;
  listingTitle: string | null;
  customer: { displayName: string | null; maskedPhone: string | null };
  fields: Array<{ field: ListingContactField; revealId: string; at: string; cost: number; refunded: boolean }>;
  windowStart: string;
  windowEnd: string;
  consent: ConsentState;
  channel: string;
  callMeAvailable: boolean;
  freeTextAvailable: boolean;
  messagesLeft: number;
  reportOpen: boolean;
}

export interface ProviderMessageView {
  id: string;
  kind: ProviderMessageKind;
  channel: ProviderMessageChannel;
  status: 'sent' | 'failed';
  credits: number;
  at: string;
}

interface LeadCustomer {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  name?: string | null;
  phone?: string | null;
  status?: string;
  closed_at?: Date | null;
  preferences?: { language?: string } | null;
}

interface ChatFacts {
  connected: ConnectedChannels;
  whatsappId: string | null;
  whatsappWindowOpen: boolean;
}

const leadNotFound = () => createAppError(ERROR_CODES.LISTING_LEAD_NOT_FOUND, 404, 'Lead not found');
const iso = (d: Date | null | undefined): string => (d ? new Date(d).toISOString() : '');

const CUSTOMER_PROJECTION = { user_id: 1, name: 1, phone: 1, status: 1, closed_at: 1, preferences: 1 } as const;

type Wallet = Pick<typeof creditWalletService, 'debit' | 'credit'>;
type Tickets = Pick<TicketService, 'createTicket'>;

export class ListingLeadService {
  constructor(
    private readonly leads: Pick<ListingLeadRepository, 'findOwned' | 'pageForVendor'> = listingLeadRepository,
    private readonly listings: Pick<ListingRepository, 'findById'> = listingRepository,
    private readonly contacts: Pick<ListingContactRepository, 'readPublishedField'> = listingContactRepository,
    private readonly reveals: Pick<ListingRevealRepository, 'findByLeadIds'> = listingRevealRepository,
    private readonly consents: Pick<ProviderConsentRepository, 'find' | 'towardProvider'> = providerConsentRepository,
    private readonly messages: Pick<
      ProviderMessageRepository,
      'countsSince' | 'countsSinceForCustomers' | 'claim' | 'markSent' | 'markFailed'
    > = providerMessageRepository,
    private readonly sender: Pick<ProviderMessageSender, 'send'> = providerMessageSender,
    private readonly wallet: Wallet = creditWalletService,
    private readonly tickets: Tickets = new TicketService(),
    private readonly window: Pick<WhatsappService, 'canSendFreeMessage'> = new WhatsappService(),
    private readonly callMeCost: number = WHATSAPP_TEMPLATE_COST,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ─── The list ──────────────────────────────────────────────────────────────

  async list(vendorId: string, q: VendorLeadListQuery): Promise<{ data: VendorLeadRow[]; meta: { page: number; limit: number; total: number; pages: number } }> {
    const page = await this.leads.pageForVendor(vendorId, q);
    const now = this.clock();
    const rows = page.data;
    const customerIds = rows.map((l) => l.customer_id.toString());
    const listingIds = [...new Set(rows.map((l) => l.listing_id.toString()))];

    const [customers, listings, reveals, consents, counts, openReports] = await Promise.all([
      this.customersById(customerIds),
      Promise.all(listingIds.map((id) => this.listings.findById(id))).then(
        (ls) => new Map(ls.filter((l): l is ListingRow => !!l).map((l) => [l._id.toString(), l])),
      ),
      this.reveals.findByLeadIds(rows.map((l) => l._id)),
      this.consents.towardProvider(vendorId, customerIds),
      this.messages.countsSinceForCustomers(vendorId, customerIds, messageCapWindowStart(now)),
      this.openReportLeadIds(rows.map((l) => l._id.toString())),
    ]);

    const chats = new Map<string, ChatFacts>();
    await Promise.all(
      [...customers.values()].map(async (c) => chats.set(c._id.toString(), await this.chatFactsOf(c))),
    );

    const revealsByLead = new Map<string, ListingRevealRow[]>();
    for (const r of reveals) {
      const key = r.lead_id.toString();
      revealsByLead.set(key, [...(revealsByLead.get(key) ?? []), r]);
    }

    const data = rows.map((lead) => {
      const customerId = lead.customer_id.toString();
      const customer = customers.get(customerId) ?? null;
      const listing = listings.get(lead.listing_id.toString()) ?? null;
      const chat = chats.get(customerId) ?? { connected: { whatsapp: false, telegram: false }, whatsappId: null, whatsappWindowOpen: false };
      const consentRow = consents.get(customerId) ?? null;
      const leadCounts = counts.get(customerId) ?? { total: 0, callMe: 0 };
      const facts = {
        consentGranted: consentStateOf(consentRow) === 'granted' && this.reachable(customer),
        channel: messageChannelFor(lead.channel, chat.connected),
        whatsappWindowOpen: chat.whatsappWindowOpen,
        hasCallableNumber: (listing?.available_fields ?? []).some((f) => f === 'phone' || f === 'whatsapp'),
        counts: leadCounts,
      };
      const row: VendorLeadRow = {
        id: lead._id.toString(),
        listingId: lead.listing_id.toString(),
        listingTitle: listing?.published?.title ?? null,
        customer: { displayName: maskedDisplayName(customer?.name), maskedPhone: maskedPhone(customer?.phone) },
        fields: (revealsByLead.get(lead._id.toString()) ?? []).map((r) => ({
          field: r.field,
          revealId: r._id.toString(),
          at: iso(r.at),
          cost: r.cost,
          refunded: !!r.refund,
        })),
        windowStart: iso(lead.window_start),
        windowEnd: iso(lead.window_end),
        consent: consentStateOf(consentRow),
        channel: lead.channel,
        callMeAvailable: messageRefusal('call_me', facts) === null,
        freeTextAvailable: messageRefusal('free_text', facts) === null,
        messagesLeft: messagesLeft(leadCounts),
        reportOpen: openReports.has(lead._id.toString()),
      };
      return row;
    });

    return {
      data,
      meta: { page: q.page, limit: q.limit, total: page.total, pages: Math.max(1, Math.ceil(page.total / q.limit)) },
    };
  }

  // ─── The report (L-31) ─────────────────────────────────────────────────────

  async report(vendorId: string, userId: string, leadId: string, body: LeadReportBody): Promise<{ ticketId: string; ticketNumber: string }> {
    const lead = await this.leads.findOwned(leadId, vendorId);
    if (!lead) throw leadNotFound();

    const onLead = new Set((await this.reveals.findByLeadIds([lead._id])).map((r) => r._id.toString()));
    const named = [...new Set(body.revealIds)];
    const strangers = named.filter((id) => !onLead.has(id));
    if (strangers.length > 0) {
      throw createAppError(ERROR_CODES.LISTING_REPORT_INVALID, 422, 'These reveals are not on this lead', { revealIds: strangers });
    }
    if (body.wants.includes('refund') && named.length === 0) {
      throw createAppError(ERROR_CODES.LISTING_REPORT_INVALID, 422, 'Name the reveals you want refunded', { field: 'revealIds' });
    }
    if ((await this.openReportLeadIds([leadId])).size > 0) {
      throw createAppError(ERROR_CODES.LISTING_REPORT_INVALID, 422, 'A report on this lead is already open', { reason: 'report_open' });
    }

    const listing = await this.listings.findById(lead.listing_id.toString());
    const title = listing?.published?.title ?? 'a service listing';
    const ticket = await this.tickets.createTicket({
      subject: `Lead report — ${title}`.slice(0, 200),
      description: body.reason,
      type: TicketType.LISTING_LEAD_REPORT,
      importance: TicketImportance.MEDIUM,
      entityType: EntityType.LISTING_LEAD,
      entityId: leadId,
      createdByUserId: userId,
      createdByRole: ActorRole.VENDOR,
      createdByEntityId: vendorId,
      metadata: { listingId: lead.listing_id.toString(), wants: [...body.wants], revealIds: named },
    });
    const ticketId = String((ticket as { id?: string; _id?: Types.ObjectId }).id ?? ticket._id);
    return { ticketId, ticketNumber: shortRequestReference(ticketId) };
  }

  // ─── Messages (L-14, L-15, L-24) ───────────────────────────────────────────

  async callMe(vendorId: string, leadId: string): Promise<{ message: ProviderMessageView }> {
    return this.sendMessage(vendorId, leadId, 'call_me', null);
  }

  async message(vendorId: string, leadId: string, body: string): Promise<{ message: ProviderMessageView }> {
    return this.sendMessage(vendorId, leadId, 'free_text', body);
  }

  private async sendMessage(
    vendorId: string,
    leadId: string,
    kind: ProviderMessageKind,
    text: string | null,
  ): Promise<{ message: ProviderMessageView }> {
    const lead = await this.leads.findOwned(leadId, vendorId);
    if (!lead) throw leadNotFound();
    const customerId = lead.customer_id.toString();
    const listingId = lead.listing_id.toString();
    const now = this.clock();

    const [listing, customer, consentRow, counts] = await Promise.all([
      this.listings.findById(listingId),
      this.customersById([customerId]).then((m) => m.get(customerId) ?? null),
      this.consents.find(customerId, vendorId),
      this.messages.countsSince(vendorId, customerId, messageCapWindowStart(now)),
    ]);
    if (!listing || !customer) throw leadNotFound();

    const chat = await this.chatFactsOf(customer);
    const channel = messageChannelFor(lead.channel, chat.connected);
    const numbers = kind === 'call_me' ? await this.callMeNumbersOf(listingId) : null;
    const refusal = messageRefusal(kind, {
      consentGranted: consentStateOf(consentRow) === 'granted' && this.reachable(customer),
      channel,
      whatsappWindowOpen: chat.whatsappWindowOpen,
      hasCallableNumber: kind === 'call_me' ? !!numbers : true,
      counts,
    });
    if (refusal) throw this.refusalError(refusal, counts);

    // Call-me with no chat number cannot reach this point (`hasCallableNumber`); free text
    // links to the listing's own numbers when it has any, and to nothing it does not.
    const chatNumbers = numbers ?? (await this.callMeNumbersOf(listingId));
    const credits = kind === 'call_me' ? this.callMeCost : 0;
    const claimed = await this.messages.claim({
      vendorId,
      customerId,
      leadId,
      listingId,
      kind,
      channel: channel!,
      body: kind === 'call_me' ? `[call-me] ${numbers!.display}` : text!,
      credits,
      at: now,
    });

    const ref = claimed._id.toString();
    if (credits > 0) {
      try {
        await this.wallet.debit('vendor', vendorId, credits, 'whatsapp_template', ref);
      } catch (err) {
        await this.messages.markFailed(claimed._id);
        throw err; // 402 BILLING_INSUFFICIENT_CREDITS — the claim is released, nothing was sent
      }
    }

    const result = await this.sender.send({
      situation: kind === 'call_me' ? 'listing.call_me' : 'listing.provider_message',
      deliveryKey: ref,
      channel: channel!,
      lang: resolveLanguage(customer) as Language,
      userId: customer.user_id.toString(),
      whatsappId: chat.whatsappId,
      withinWindow: chat.whatsappWindowOpen,
      vendorId,
      businessName: listing.published?.company_name ?? listing.pending?.company_name ?? 'A business',
      chatNumber: chatNumbers?.chat ?? '',
      providerPhone: numbers?.display,
      messageBody: text ?? undefined,
    });

    if (!result.ok) {
      await this.messages.markFailed(claimed._id);
      if (credits > 0) await this.wallet.credit('vendor', vendorId, credits, 'refund', 'whatsapp_template', ref);
      return { message: this.viewOf({ ...claimed, status: 'failed' }) };
    }
    await this.messages.markSent(claimed._id, result.providerMessageId);
    return { message: this.viewOf(claimed) };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** A closed or deactivated customer is unreachable by providers (O-20), whatever the row says. */
  private reachable(customer: LeadCustomer | null): boolean {
    return !!customer && customer.status !== 'inactive' && !customer.closed_at;
  }

  private refusalError(code: NonNullable<ReturnType<typeof messageRefusal>>, counts: MessageCounts) {
    if (code === 'LISTING_FIELD_UNAVAILABLE') {
      return createAppError(ERROR_CODES.LISTING_FIELD_UNAVAILABLE, 422, 'This listing has no phone or WhatsApp number to send', { field: 'phone' });
    }
    if (code === 'LISTING_MESSAGE_CAP_REACHED' || code === 'LISTING_CALL_ME_ALREADY_SENT') {
      return createAppError(ERROR_CODES[code], 422, undefined, { messagesLeft: messagesLeft(counts) });
    }
    return createAppError(ERROR_CODES[code], 422);
  }

  /** The provider's own published numbers for the call-me message (not a reveal — stated defaults). */
  private async callMeNumbersOf(listingId: string): Promise<{ display: string; chat: string } | null> {
    const [phone, whatsapp] = await Promise.all([
      this.contacts.readPublishedField(listingId, 'phone'),
      this.contacts.readPublishedField(listingId, 'whatsapp'),
    ]);
    return callMeNumbers(typeof phone === 'string' ? phone : null, typeof whatsapp === 'string' ? whatsapp : null);
  }

  private async customersById(ids: string[]): Promise<Map<string, LeadCustomer>> {
    const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (valid.length === 0) return new Map();
    const rows = await CustomerModel.find({ _id: { $in: valid } }, CUSTOMER_PROJECTION).lean<LeadCustomer[]>();
    return new Map(rows.map((c) => [c._id.toString(), c]));
  }

  private async chatFactsOf(customer: LeadCustomer): Promise<ChatFacts> {
    const map = await connectionService.getConnectionMap(customer.user_id);
    const whatsappId = map.whatsapp?.external_id ?? null;
    return {
      connected: { whatsapp: !!map.whatsapp, telegram: !!map.telegram },
      whatsappId,
      whatsappWindowOpen: whatsappId ? await this.window.canSendFreeMessage(whatsappId) : false,
    };
  }

  /** Lead ids among `leadIds` with a report ticket that is not closed. */
  private async openReportLeadIds(leadIds: string[]): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();
    const rows = await TicketModel.find(
      {
        entity_type: EntityType.LISTING_LEAD,
        entity_id: { $in: leadIds },
        type: TicketType.LISTING_LEAD_REPORT,
        status: { $nin: [...TERMINAL_TICKET_STATUSES] },
      },
      { entity_id: 1 },
    ).lean<Array<{ entity_id: string }>>();
    return new Set(rows.map((r) => r.entity_id));
  }

  private viewOf(row: Pick<ProviderMessageRow, '_id' | 'kind' | 'channel' | 'status' | 'credits' | 'at'>): ProviderMessageView {
    return {
      id: row._id.toString(),
      kind: row.kind,
      channel: row.channel,
      status: row.status,
      credits: row.status === 'failed' ? 0 : row.credits,
      at: iso(row.at),
    };
  }
}

export const listingLeadService = new ListingLeadService();
