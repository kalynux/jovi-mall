# FRONTEND CHANGELOG — agent earnings follow your agency's terms (2026-10-22)

**No endpoint, request or response shape changed.** Only *when* `pending` money becomes
`available`, and the copy that explains it.

## What changed

**Before:** your share of a delivery waited **3 days after the whole order** was delivered.

**Now:** it follows **your agency's** policy terms, counted from **your parcel's** delivery:

- the agency pays for returns → held 3 days;
- otherwise → held for the agency's damage-claim deadline, at most 3 days;
- neither → released at the next nightly run after the delivery is **confirmed** (by the customer,
  by the COD code, or automatically after 3 days).

On cash on delivery, the cash must still reach Wi-Mall first. Money can still be paused; our team
can now pause one delivery's payment. Paused time does not count.

## What to change in the app

1. **"Still held" help text** on Earnings & payouts (EN / FR):

   | EN | FR |
   |---|---|
   | Released up to 3 days after your parcel is delivered, depending on your agency's terms — sometimes the night after the delivery is confirmed. | Libéré jusqu'à 3 jours après la livraison de votre colis, selon les conditions de votre agence — parfois dès la nuit suivant la confirmation de la livraison. |

2. Remove any copy that says "3 days after the whole order is delivered".

## Docs updated

- [earnings.md](./earnings.md) § When it becomes withdrawable
