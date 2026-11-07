# FRONTEND CHANGELOG — why money was taken back, seller-cancel fees, damage compensation (2026-10-22)

**Additive only.** Two new GET routes; no existing response changed.
Contract: [earnings.md § Why money was taken back](./earnings.md).

## What changed for vendors

1. **Cancelling a paid order costs you the fees.** When you cancel an order the customer already
   paid, the customer gets back **everything** they paid, and the payment fee (2%) and the transfer fee
   (2%) are charged to you on top of your share. Example: a 12,000 order → 480 in fees.
2. **A lost card dispute** also charges you the 2% payment fee the provider kept.
3. **Wi-Mall gives back only what it earned.** On a refund, the customer bears the payment and
   transfer fees (not you); your share comes back as before.
4. **A delivery at fault no longer costs you the delivery.** When the team finds the delivery
   damaged or lost the parcel inside the agency's own window, the agency (not you) refunds the
   delivery money, or carries the courier cost of your free delivery.
5. **Damage compensation.** When the team charges an agency a damage claim for your parcel, the
   claim amount is **credited to you** (released at the next nightly run).

## New routes

- `GET /api/vendor/earnings/adjustments?page=&limit=` — every movement that took money from you,
  paid off your debt, or forgave it, **with a sentence explaining it** (`explanation`) and a code
  (`reasonCode`) to render it in French.
- `GET /api/vendor/earnings/agency-claims?page=&limit=` — damage claims that compensated you.

## What to change

1. **Earnings screen → new "Adjustments" list.** Show date, `amount`, `explanation`. Where the money
   came from: `takenFrom` (held / reserve / available / **debt** — say "you now owe" for debt).
2. **Earnings screen → "Damage compensation" list** from `/earnings/agency-claims`: order, parcel,
   amount, `explanation`.
3. **Cancel-order confirmation** (paid orders only), EN / FR:

   | EN | FR |
   |---|---|
   | The customer will be refunded in full. The payment and transfer fees (about 4%) are charged to you. | Le client sera remboursé intégralement. Les frais de paiement et de transfert (environ 4 %) vous sont facturés. |
