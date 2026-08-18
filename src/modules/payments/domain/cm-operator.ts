/**
 * Which mobile-money operator a Cameroon number belongs to.
 *
 * ── WHY THIS IS NEEDED AT ALL ────────────────────────────────────────────────
 * NotchPay's direct charge takes an explicit `channel` (`cm.mtn` / `cm.orange`)
 * — it will not work it out from the number. `PaymentChannelInfo.phoneOperator`
 * is optional on our side and several existing clients omit it, so without a
 * derivation every one of those checkouts would start failing the day the real
 * gateway landed.
 *
 * My-CoolPay's `payin` derives the operator server-side and needs none of
 * this. The asymmetry is real and is not worth hiding behind a common shape.
 *
 * ── THE ORDER OF TRUST ───────────────────────────────────────────────────────
 * A declared operator always wins. The prefix table is a fallback, and prefix
 * tables go stale: Cameroon has ported numbers and the ranges have been
 * extended before. When the table cannot answer, we refuse with a typed error
 * rather than guessing — sending `cm.mtn` for an Orange number produces a
 * gateway-side failure the customer sees as "payment declined", which is a
 * worse outcome than being asked which network they are on.
 */

/** The operators the mobile-money gateways can actually charge in Cameroon. */
export type CameroonMobileOperator = 'MTN' | 'ORANGE';

/**
 * Prefix ranges for the 9-digit national number (which always starts with 6).
 *
 * Sources cross-checked against the ARTEL numbering plan. Deliberately narrow:
 * an unlisted range returns null and the caller asks, instead of the table
 * inventing an answer.
 *
 *   MTN     650-654, 670-679, 680-684
 *   ORANGE  655-659, 690-699, 685-689
 *   (660-669 is Nexttel and 62x is Camtel — neither is a mobile-money rail
 *    either gateway supports, so both fall through to null.)
 */
const PREFIX_RANGES: readonly { from: number; to: number; operator: CameroonMobileOperator }[] = [
  { from: 650, to: 654, operator: 'MTN' },
  { from: 655, to: 659, operator: 'ORANGE' },
  { from: 670, to: 679, operator: 'MTN' },
  { from: 680, to: 684, operator: 'MTN' },
  { from: 685, to: 689, operator: 'ORANGE' },
  { from: 690, to: 699, operator: 'ORANGE' },
];

/**
 * Reduce any of the shapes a phone number arrives in to its 9-digit national
 * form.
 *
 * The platform stores E.164 (`+237650123456`), a WhatsApp identity arrives as
 * bare digits with the country code (`237650123456`), and a checkout form
 * often carries the national number alone (`650123456`). All three must
 * resolve to the same operator — the messaging-login module learned this the
 * hard way, where a bare-digits identifier silently matched nothing for every
 * user.
 */
export function toCameroonNationalNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('6')) return digits;
  if (digits.length === 12 && digits.startsWith('237')) return digits.slice(3);
  return null;
}

/**
 * Resolve the operator, preferring what the caller declared.
 *
 * Returns null when neither source can answer — the caller must then refuse,
 * not default.
 */
export function resolveCameroonOperator(
  phone: string | null | undefined,
  declared?: string | null
): CameroonMobileOperator | null {
  const stated = (declared || '').toUpperCase();
  if (stated === 'MTN' || stated === 'ORANGE') return stated;

  // MOOV has no Cameroon mobile-money rail on either gateway. It is a valid
  // value of `PaymentChannelInfo.phoneOperator` because that union is shared
  // with other markets, so it reaches here and must fall through to the prefix
  // table rather than being honoured.
  const national = toCameroonNationalNumber(phone);
  if (!national) return null;

  const prefix = Number(national.slice(0, 3));
  const match = PREFIX_RANGES.find((range) => prefix >= range.from && prefix <= range.to);
  return match ? match.operator : null;
}

/** NotchPay's channel identifier for an operator. */
export function notchPayChannelFor(operator: CameroonMobileOperator): 'cm.mtn' | 'cm.orange' {
  return operator === 'MTN' ? 'cm.mtn' : 'cm.orange';
}
