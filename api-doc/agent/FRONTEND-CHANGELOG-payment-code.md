# Agent app — the Orange Money payment code, and mobile-money limits

**Applies to:** the agent app's billing (plan purchase, credit top-up)
**Status:** ✅ built 2026-10-05; live after the next production deploy. Visible only once an
administrator makes NovaSend the collection aggregator.
**Breaks:** nothing on the wire. ⚠ But installed app versions stay in the field for months: an
agent on a build without this step who pays with Orange while NovaSend is active is refused
`PAYMENT_CODE_REQUIRED` with nowhere to type the code. Ship it before the switch.

The agent's billing doors take exactly the vendor's body and give exactly the vendor's answers,
under `/api/agent`:

- `POST /api/agent/plans/:planId/purchase` → `{ provider, channel: { phoneNumber, paymentCode } }`
- `POST /api/agent/credits/topups` → `{ packCode, provider, channel: { phoneNumber, paymentCode } }`

## What to change (Flutter)

1. **Parse the new `/options` fields** (`GET /api/payments/options`): `flow` may now be
   `"CODE_FIRST"` (give the enum an `unknown` fallback if it has none), `fields` may contain
   `"paymentCode"`, and an entry may carry `codeUssd` (string) and `limits` (`{ min, max }`).
2. **`CODE_FIRST` provider chosen** → show *"Orange Money: dial **{codeUssd}** to get your payment
   code"*, with a button that opens the dialer (`tel:` URI, `#` encoded as `%23`), and a **Payment
   code** field: digits only, 4–8, `keyboardType: number`, `autofillHints: [oneTimeCode]`, never
   persisted (not in shared preferences, not in a draft, not in a log).
3. **Send `channel.paymentCode`** on the two calls above.
4. **Handle the three 422s** on the payment sheet: `PAYMENT_CODE_REQUIRED` (show the field with
   `details.ussd`), `PAYMENT_CODE_REJECTED` (clear it, ask for a new code; nothing charged),
   `PAYMENT_AMOUNT_OUT_OF_RANGE` (*"limited to {details.max} FCFA right now"*).
5. Unchanged: `requiresOtp` → `/authorize`, `/verify` polling.

Why and the full table: [cross-role page](../FRONTEND-CHANGELOG-payment-code.md).
