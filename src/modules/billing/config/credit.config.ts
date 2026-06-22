/**
 * Credit System Configuration
 *
 * Central place for credit unit-costs of metered actions and the purchasable
 * top-up packs. Costs are intentionally config (not per-plan) — every plan pays
 * the same per-action cost; plans differ only by the credit allowance they grant
 * (set per-tier in `scripts/seed/seed-pricing-plans.ts`).
 *
 * Per-action costs are env-overridable so the economics can be re-tuned without a
 * code change. NOTE: the env file must be loaded BEFORE this module is imported
 * (both `src/server.ts` and the seed scripts do `import 'dotenv/config'` first),
 * otherwise these reads fall back to the defaults below.
 */

/**
 * Cost (in credits) of vectorising a single product. Metered from the vendor's
 * wallet (the free plan grants credits that cover it). Kept cheap (1 credit)
 * since the platform cost is near zero. Setting it to 0 makes it free and skips
 * the debit/refund entirely (see VectorisationService).
 */
export const VECTORISATION_COST = parseInt(process.env.CREDIT_COST_VECTORISATION || '1', 10);

/** Cost (in credits) of sending one billable WhatsApp template (vendor → customer). */
export const WHATSAPP_TEMPLATE_COST = parseInt(process.env.CREDIT_COST_WHATSAPP_TEMPLATE || '1', 10);

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

/**
 * Top-up catalogue. Each pack's credits ≈ price ÷ 6, hand-tuned so larger packs
 * give a growing bonus (better FCFA/credit) — the same model as the plan tiers.
 */
export const CREDIT_TOPUP_PACKS: ReadonlyArray<CreditPack> = Object.freeze([
  { code: 'pack_100', credits: 100, price: 600, currency: 'XAF' },
  { code: 'pack_320', credits: 320, price: 1_800, currency: 'XAF' },
  { code: 'pack_1100', credits: 1_100, price: 6_000, currency: 'XAF' },
  { code: 'pack_2250', credits: 2_250, price: 12_000, currency: 'XAF' },
]);

export function findCreditPack(code: string): CreditPack | undefined {
  return CREDIT_TOPUP_PACKS.find((p) => p.code === code);
}
