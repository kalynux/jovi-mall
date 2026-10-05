import { toE164 } from '../../../core/validation/phone';
import { toCameroonNationalNumber } from './cm-operator';
import type { RefundPaymentChannel } from './refund-fee';

/**
 * WHERE a refund's money goes (REFUND-FLOW-PLAN R-7, R-7b, D-6). Pure; pinned by
 * `test:refund-flow`.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 * 1. **The number that paid.** Every payment since 2026-09-27 carries `payer.phone`; a
 *    mobile-money refund goes back to it, as stored. A relative who paid gets the money back —
 *    that is the decision (R-7), not an accident.
 * 2. **No stored number → an administrator TYPES one**, and must attach a picture of the
 *    customer's message giving it (`destination_proof_file_id`); a SECOND administrator then
 *    approves (`secondApproverRequired` in `refund-status.ts`). COD and billing never have a
 *    paying number, so they always take this path (or settle externally).
 * 3. **A card refund has no destination** — it goes back to the card through Stripe.
 *
 * ── Normalisation (D-6) ───────────────────────────────────────────────────────
 * Stored numbers are used as stored, normalised to E.164 at refund time: bot booking numbers
 * were not always normalised, and arrive as bare digits (`237677…`) or a national Cameroon
 * number (`677…`). A STORED number that still cannot be read is treated as absent (the request
 * then needs a typed one); a TYPED number that cannot be read is refused outright — nobody is
 * sent money on a guess.
 */

/** E.164, or null. Accepts E.164, bare international digits, and a 9-digit Cameroon mobile. */
export function normalizeRefundPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const direct = toE164(raw);
  if (direct) return direct;
  const digits = raw.replace(/[\s().-]/g, '');
  if (/^00\d+$/.test(digits)) return toE164(`+${digits.slice(2)}`);
  if (/^\d+$/.test(digits)) {
    const national = toCameroonNationalNumber(digits);
    if (national && digits.length === 9) return `+237${national}`;
    return toE164(`+${digits}`);
  }
  return null;
}

export interface RefundDestination {
  phone: string;
  name: string;
  source: 'payer' | 'typed';
}

export interface PayerLeg {
  /** `payer.phone` of the succeeded payment, as stored. */
  phone: string | null;
  name: string | null;
}

export interface DestinationInput {
  paymentChannel: RefundPaymentChannel;
  /** The succeeded payment legs this refund is taken from (empty for COD / billing). */
  payerLegs: readonly PayerLeg[];
  /** An administrator's typed number, if any. */
  typed?: { phone: string; name?: string | null } | null;
  /** The proof picture for a typed number (R-7). */
  proofFileId?: string | null;
  /** Fallback beneficiary name for the provider record. */
  fallbackName?: string | null;
}

export type DestinationVerdict =
  | { kind: 'card' }
  | { kind: 'resolved'; destination: RefundDestination }
  | { kind: 'refused'; reason: 'no_destination' | 'proof_required' | 'typed_phone_invalid' };

/**
 * Decide the destination. A typed number always wins (it is what an administrator chose for a
 * reason) — and always needs its proof.
 */
export function resolveRefundDestination(input: DestinationInput): DestinationVerdict {
  if (input.typed) {
    const phone = normalizeRefundPhone(input.typed.phone);
    if (!phone) return { kind: 'refused', reason: 'typed_phone_invalid' };
    if (!input.proofFileId) return { kind: 'refused', reason: 'proof_required' };
    return {
      kind: 'resolved',
      destination: { phone, name: nameOr(input.typed.name, input.fallbackName), source: 'typed' },
    };
  }

  if (input.paymentChannel === 'card') return { kind: 'card' };
  if (input.paymentChannel !== 'mobile_money') return { kind: 'refused', reason: 'no_destination' };
  if (input.payerLegs.length === 0) return { kind: 'refused', reason: 'no_destination' };

  // EVERY leg must name a readable number — a leg with none cannot be sent anywhere.
  const phones = input.payerLegs.map((l) => normalizeRefundPhone(l.phone));
  if (phones.some((p) => p === null)) return { kind: 'refused', reason: 'no_destination' };

  const first = input.payerLegs[0];
  return {
    kind: 'resolved',
    destination: { phone: phones[0] as string, name: nameOr(first.name, input.fallbackName), source: 'payer' },
  };
}

function nameOr(name: string | null | undefined, fallback: string | null | undefined): string {
  return (name ?? '').trim() || (fallback ?? '').trim() || 'Customer';
}

/** Mask a number for a customer or admin listing: `+237 6•• ••• 512`-style, last 3 digits kept. */
export function maskRefundPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '•••';
  return `${phone.startsWith('+') ? '+' : ''}${'•'.repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}
