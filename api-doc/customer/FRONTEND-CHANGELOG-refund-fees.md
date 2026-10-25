# FRONTEND CHANGELOG — refund fees, explained line by line (2026-10-22)

**Additive only.** The order's (and booking's) `refund` block gains fields; nothing was removed or
renamed. Contract: [orders.md § The `refund` block](./orders.md#the-refund-block).

## What changed

A refund is now smaller by **two** fees, each only where it actually happened:

| Paid by | Payment fee (kept by the payment provider when you paid) | Transfer fee (to send it back) | 10,000 refunded → you receive |
|---|---|---|---|
| mobile money | 2% | 2% of what is left | **9,604** |
| card | 2% | — (back on the card) | **9,800** |
| cash on delivery | — | 2% | **9,800** |
| the **seller** cancelled after you paid | paid by the seller | paid by the seller | **10,000** |

When a delivery was damaged or lost and the team says the delivery was at fault, the delivery fee
can now come back to the customer too, even when the seller's return policy says it doesn't. Nothing
changes on screen for that: it is already inside `grossAmount` / `netAmount`.

## New fields on `refund`

```jsonc
"paymentFee": 100, "paymentFeePercent": 2,
"transferFee": 98,
"feesPaidBy": "customer",          // "seller": you receive everything
"lines": [
  { "code": "refund_amount", "label": "Refund", "amount": 5000, "percent": null },
  { "code": "payment_fee",   "label": "Payment provider fee, kept when you paid", "amount": -100, "percent": 2 },
  { "code": "transfer_fee",  "label": "Transfer fee to send the money back", "amount": -98, "percent": 2 },
  { "code": "you_receive",   "label": "You receive", "amount": 4802, "percent": null }
]
```

`feeAmount` is now **both fees together** (`grossAmount − netAmount`); `feePercent` stays the transfer
fee's percent.

## What to change

1. **Order and booking refund card:** replace the single "minus a 2% transfer fee" line by the
   `lines` list. They add up: refund − fees = you receive. Use these FR labels (switch on `code`):

   | `code` | EN | FR |
   |---|---|---|
   | `refund_amount` | Refund | Remboursement |
   | `payment_fee` | Payment provider fee, kept when you paid ({percent}%) | Frais du prestataire de paiement, retenus lors de votre paiement ({percent} %) |
   | `transfer_fee` | Transfer fee to send the money back ({percent}%) | Frais de transfert pour vous renvoyer l'argent ({percent} %) |
   | `fees_paid_by_seller` | Fees are paid by the seller | Les frais sont payés par le vendeur |
   | `you_receive` | You receive | Vous recevez |

2. A refund from before 2026-10-22 has `paymentFee: 0` and a transfer fee line only — nothing special
   to do.

WhatsApp and Telegram messages already say the new lines (no template change).
