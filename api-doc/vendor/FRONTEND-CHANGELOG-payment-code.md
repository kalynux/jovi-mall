# Vendor dashboard — the Orange Money payment code, and mobile-money limits

**Applies to:** the vendor dashboard's billing (plan purchase, credit top-up)
**Status:** ✅ built 2026-10-05; live after the next production deploy. Visible only once an
administrator makes NovaSend the collection aggregator.
**Breaks:** nothing. Without this change, a vendor paying with Orange is refused
`PAYMENT_CODE_REQUIRED` while NovaSend is active, with nowhere to type the code.

Why, the full error table and the rules: [cross-role page](../FRONTEND-CHANGELOG-payment-code.md).

## What to change

1. **Read the new `/options` fields** (`GET /api/payments/options`, fetched when the payment dialog
   opens): `flow: "CODE_FIRST"`, `fields` containing `"paymentCode"`, `codeUssd`,
   `limits: { min, max }`.
2. **When the chosen provider is `CODE_FIRST`**, show *"Orange Money: dial **{codeUssd}** to get
   your payment code"* and a **Payment code** input (4–8 digits, `inputmode="numeric"`,
   `autocomplete="one-time-code"`, never saved). Disable Pay until it is filled.
3. **Send `channel.paymentCode`**:
   - `POST /api/vendor/plans/:planId/purchase` → `{ provider, channel: { phoneNumber, paymentCode } }`
   - `POST /api/vendor/credits/topups` → `{ packCode, provider, channel: { phoneNumber, paymentCode } }`
4. **Handle in the dialog:** `PAYMENT_CODE_REQUIRED` (show the field with `details.ussd`),
   `PAYMENT_CODE_REJECTED` (clear it, ask for a new code; nothing charged; the purchase or top-up
   is marked failed, so Pay again starts a new one), `PAYMENT_AMOUNT_OUT_OF_RANGE` (*"limited to
   {details.max} FCFA right now"*). All 422, nothing charged.
5. **`limits`**: a plan or pack priced above `limits.max` cannot be bought by mobile money while
   that aggregator is active. Say so on the card instead of letting the vendor press Pay.
6. The `requiresOtp` → `/authorize` branch and `/verify` polling are unchanged.
