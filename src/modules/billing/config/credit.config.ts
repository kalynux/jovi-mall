/**
 * Credit System Configuration
 *
 * Central place for credit unit-costs of metered actions and the purchasable
 * top-up packs. Costs are intentionally config (not per-plan) for now — every
 * plan pays the same per-action cost; plans differ only by the credit allowance
 * they grant. Values may be overridden via env without a code change.
 */

/** Cost (in credits) of vectorising a single product. */
export const VECTORISATION_COST = parseInt(process.env.CREDIT_COST_VECTORISATION || '10', 10);

/** Cost (in credits) of sending one billable WhatsApp template (vendor → customer). */
export const WHATSAPP_TEMPLATE_COST = parseInt(process.env.CREDIT_COST_WHATSAPP_TEMPLATE || '5', 10);

/**
 * Purchasable credit packs. `code` is the stable identifier the client sends to
 * `POST /vendor/credits/topups`; price is in the wallet owner's currency (XAF).
 */
export interface CreditPack {
  code: string;
  credits: number;
  price: number;
  currency: string;
}

export const CREDIT_TOPUP_PACKS: ReadonlyArray<CreditPack> = Object.freeze([
  { code: 'pack_5k', credits: 5_000, price: 2_500, currency: 'XAF' },
  { code: 'pack_15k', credits: 15_000, price: 6_000, currency: 'XAF' },
]);

export function findCreditPack(code: string): CreditPack | undefined {
  return CREDIT_TOPUP_PACKS.find((p) => p.code === code);
}
