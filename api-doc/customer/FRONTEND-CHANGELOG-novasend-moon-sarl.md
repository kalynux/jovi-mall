# Customer shop — confirm with "Moon SARL", and no Orange code

**Applies to:** the shop on the landing site (checkout, pay again, bookings, booking balance,
delivery-fee top-up)
**Status:** ✅ built 2026-11-04. It applies once the backend is deployed and an administrator selects
NovaSend, which the owner intends as the default.
**Breaks:** nothing.

Why, and the full rules: [cross-role page](../FRONTEND-CHANGELOG-novasend-moon-sarl.md).

## What to change

On the waiting screen after these four calls, read `instructions` from the response:
`POST /api/payments/initiate`, `POST /api/bookings/:id/pay`,
`POST /api/customer/bookings/:id/pay-balance`,
`POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/pay`.

1. **When `instructions.payeeName` is present,** make the instruction the main thing on the screen:
   show `instructions.message`, or your own wording built from `payeeName` and `ussdCode`. The
   customer must know the request comes from **Moon SARL**. Never hard-code that name.
2. **Show `instructions.ussdCode`** as text and as a `tel:` link (encode `#` as `%23`). An Orange
   customer gets **no prompt**: nothing happens until they dial it.
3. **Keep polling, and do not time out early.** An Orange payment stays pending for minutes.
4. **Skip the Orange code step** from the 2026-10-05 changelog. If you already built it, it hides
   itself.
5. **Read `limits` from `/options`:** the minimum is now 301 XAF, not 200.

When `payeeName` is absent, the screen stays as it is today.
