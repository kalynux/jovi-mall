# FRONTEND CHANGELOG — agency earnings released by your own terms (2026-10-22)

**No endpoint, request or response shape changed.** Only *when* `pending` money becomes
`available`, and the copy that explains it.

## What changed

**Before:** every agency's share of a delivery waited **3 days after the last parcel of the whole
order** was delivered, the same as the seller.

**Now:** your share waits only as long as **your own policy terms** make you answerable after
delivery, counted from **your parcel's** delivery:

| Your terms (Policies screen) | Held for |
|---|---|
| "Return costs paid by" = **Agency** | 3 days |
| Otherwise, "Damage claim deadline" = N days | N days, at most 3 (4 → 3, 2 → 2, 0 → none) |
| Neither | **no hold**: released at the next nightly run after the delivery is **confirmed** |

"Confirmed" means the customer confirmed receipt, the customer gave the COD code, or the system
confirmed automatically after 3 days. A rider's "delivered" tap alone is not enough when there is no
hold, because money already paid out cannot be taken back.

- The two terms combine: the **longer** hold applies.
- Terms are read when the delivery is recorded. Editing them afterwards does not move money already counted.
- Your **agent's** share on the same delivery follows your terms.
- **Cash on delivery** still needs the cash to reach Wi-Mall before anything is released, and the
  rolling reserve is unchanged.
- Money can still be **paused**: a disputed card payment, a paid order the seller cancelled, a
  problem the customer reported, or our team. Our team can now pause **one delivery's** payment.
  Paused time does not count.

## What to change in the app

1. **Earnings help text** (EN / FR):

   | EN | FR |
   |---|---|
   | Pending earnings are released after a hold of up to 3 days, set by your return and damage-claim terms. With neither, they are released the night after the delivery is confirmed. | Les revenus en attente sont libérés après une retenue de 3 jours au plus, fixée par vos conditions de retours et de réclamations pour dommages. Sans l'une ni l'autre, ils sont libérés la nuit suivant la confirmation de la livraison. |

2. **Policies screen**, next to "Return costs paid by" and "Damage claim deadline":

   | EN | FR |
   |---|---|
   | These terms also decide how long your earnings are held after delivery (up to 3 days). | Ces conditions déterminent aussi la durée de retenue de vos revenus après la livraison (3 jours au plus). |

3. Remove any copy that says "3 days after the order is delivered".

## Docs updated

- [earnings.md](./earnings.md) § When it lands, and why not sooner
