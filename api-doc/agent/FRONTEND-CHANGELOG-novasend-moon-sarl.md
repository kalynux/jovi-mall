# Agent app — confirm with "Moon SARL", and no Orange code

**Applies to:** plan purchases and credit top-ups paid by mobile money
**Status:** ✅ built 2026-11-04. It applies once the backend is deployed and an administrator selects
NovaSend, which the owner intends as the default.
**Breaks:** nothing.

Why, and the full rules: [cross-role page](../FRONTEND-CHANGELOG-novasend-moon-sarl.md).

## What to change

On the waiting screen after `POST /api/agent/plans/:planId/purchase` and
`POST /api/agent/credits/topups`, read `instructions` from the response.

1. **Add `payeeName` as an optional string** on the instructions model, so older responses without it
   still parse.
2. **When `instructions.payeeName` is present,** make the instruction the main thing on the screen:
   show `instructions.message`, or your own wording built from `payeeName` and `ussdCode`. The agent
   must know the request comes from **Moon SARL**. Never hard-code that name.
3. **Show `instructions.ussdCode`** as text and as a `tel:` link (encode `#` as `%23`). An Orange
   payer gets **no prompt**: nothing happens until they dial it.
4. **Keep polling, and do not time out early.** An Orange payment stays pending for minutes.
5. **Skip the Orange code step** from the 2026-10-05 changelog. If you already built it, it hides
   itself.
6. **Read `limits` from `/options`:** the minimum is now 301 XAF, not 200.

When `payeeName` is absent, the screen stays as it is today.
