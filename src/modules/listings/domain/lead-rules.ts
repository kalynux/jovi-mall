import {
  LISTING_LEAD_WINDOW_DAYS,
  PROVIDER_CALL_ME_CAP,
  PROVIDER_MESSAGE_CAP,
  ProviderMessageChannel,
  ProviderMessageKind,
} from './listing.types';

/**
 * The pure half of a provider's leads (SERVICE-LISTINGS-PLAN L-13, L-14, L-15, L-24) — what a
 * provider may see of a customer, and which of the two message buttons a lead may show. No
 * I/O and no clock of its own, so `test:service-listings-messaging` drives every boundary.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── What the provider sees of a customer (L-13) ─────────────────────────────

/**
 * "Jean-Paul Kamga" → "Jean-Paul K.". The first name in full and the initial of the LAST word;
 * one word stays as it is. A missing name is `null` and the dashboard writes "A customer".
 */
export function maskedDisplayName(name: string | null | undefined): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];
  const last = words[words.length - 1];
  return `${words[0]} ${last.charAt(0).toUpperCase()}.`;
}

/**
 * The calling codes in use, longest first so `+1` never swallows `+1 876`. Only the prefix is
 * shown, so an unknown one just shows fewer digits — never more.
 */
const CALLING_CODES = [
  '1876', '1868', '1809', '1787', '1684', '1671', '1670', '1664', '1649', '1473', '1441', '1345', '1340', '1284', '1268', '1264', '1246', '1242',
  '880', '886', '852', '853', '855', '856', '850', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389', '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '1', '7',
].sort((a, b) => b.length - a.length);

/**
 * "+237 6 71 23 45 31" → "+237 ••• ••• •31": the country code and the LAST TWO digits, nothing
 * else (L-13). Enough for a provider to tell two customers apart (the drain risk depends on
 * that), never enough to call them. A number with too few digits is fully masked.
 */
export function maskedPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 6) return digits.length ? '+••• ••• •••' : null;
  const code = CALLING_CODES.find((c) => digits.startsWith(c)) ?? '';
  return `+${code}${code ? ' ' : ''}••• ••• •${digits.slice(-2)}`;
}

// ─── Which channel a message goes on ─────────────────────────────────────────

export interface ConnectedChannels {
  whatsapp: boolean;
  telegram: boolean;
}

/**
 * Where the customer is reached. The lead's own channel first — it is where they unlocked the
 * contact, so it is the conversation they will recognise — then Telegram (no window, no
 * template cost), then WhatsApp. A web lead has no chat of its own and takes the fallback.
 * `null`: no linked chat at all (`LISTING_MESSAGE_CHANNEL_UNAVAILABLE`).
 */
export function messageChannelFor(leadChannel: string, connected: ConnectedChannels): ProviderMessageChannel | null {
  if (leadChannel === 'whatsapp' && connected.whatsapp) return 'whatsapp';
  if (leadChannel === 'telegram' && connected.telegram) return 'telegram';
  if (connected.telegram) return 'telegram';
  if (connected.whatsapp) return 'whatsapp';
  return null;
}

// ─── The caps (L-15, L-24) ───────────────────────────────────────────────────

/** The rolling window the caps count over: the last `LISTING_LEAD_WINDOW_DAYS` days. */
export function messageCapWindowStart(now: Date): Date {
  return new Date(now.getTime() - LISTING_LEAD_WINDOW_DAYS * DAY_MS);
}

/** Messages SENT to one customer by one provider in the window. A failed send counts for nothing. */
export interface MessageCounts {
  total: number;
  callMe: number;
}

export const messagesLeft = (counts: MessageCounts): number => Math.max(0, PROVIDER_MESSAGE_CAP - counts.total);

export interface MessageAvailabilityFacts {
  consentGranted: boolean;
  channel: ProviderMessageChannel | null;
  /** WhatsApp only: is the customer inside the 24-hour window with Wi-Mall's number? */
  whatsappWindowOpen: boolean;
  /** Does the listing have a phone or WhatsApp number to put in the call-me message? */
  hasCallableNumber: boolean;
  counts: MessageCounts;
}

/**
 * Why a message of this kind cannot go — in the order the dashboard should explain it — or
 * `null` when it can. The error codes are § C-4's.
 */
export type MessageRefusal =
  | 'LISTING_MESSAGE_CONSENT_REQUIRED'
  | 'LISTING_MESSAGE_CHANNEL_UNAVAILABLE'
  | 'LISTING_MESSAGE_CAP_REACHED'
  | 'LISTING_CALL_ME_ALREADY_SENT'
  | 'LISTING_MESSAGE_WINDOW_CLOSED'
  | 'LISTING_FIELD_UNAVAILABLE';

export function messageRefusal(kind: ProviderMessageKind, f: MessageAvailabilityFacts): MessageRefusal | null {
  if (!f.consentGranted) return 'LISTING_MESSAGE_CONSENT_REQUIRED';
  if (!f.channel) return 'LISTING_MESSAGE_CHANNEL_UNAVAILABLE';
  if (f.counts.total >= PROVIDER_MESSAGE_CAP) return 'LISTING_MESSAGE_CAP_REACHED';
  if (kind === 'call_me') {
    if (f.counts.callMe >= PROVIDER_CALL_ME_CAP) return 'LISTING_CALL_ME_ALREADY_SENT';
    // A template goes outside the window, so call-me works at any time (L-15).
    if (!f.hasCallableNumber) return 'LISTING_FIELD_UNAVAILABLE';
    return null;
  }
  // Free text: WhatsApp's rule, not Wi-Mall's — inside the 24-hour window only; always on Telegram.
  if (f.channel === 'whatsapp' && !f.whatsappWindowOpen) return 'LISTING_MESSAGE_WINDOW_CLOSED';
  return null;
}

/**
 * The number a call-me message carries (stated defaults: "the vendor sending their own number
 * is not a reveal"): the listing's PHONE, else its WhatsApp. The "Chat on WhatsApp" button
 * opens the WhatsApp number when there is one, else the same phone.
 */
export function callMeNumbers(phone: string | null, whatsapp: string | null): { display: string; chat: string } | null {
  const display = phone || whatsapp;
  if (!display) return null;
  return { display, chat: whatsapp || display };
}
