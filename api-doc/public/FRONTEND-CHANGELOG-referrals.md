# Landing and shop: the referral program

**2026-11-02 · not deployed yet · additive.** Read [the shared rules](../FRONTEND-CHANGELOG-referrals.md) first,
and [me/referrals.md](../me/referrals.md) for the contract.

## 1. `/register?ref=CODE`

This is the link partners share, so the existing page must keep the code through every step.

1. On load with `?ref=`, call `GET /api/public/referral/:code`. On `valid: false` carry on as an ordinary visit,
   with no error.
2. **Vendor or agency:** send `referral_code` with the form. Also keep it through `?role=`.
3. **Customer:** customers register in the chat, so the WhatsApp and Telegram buttons on the customer step must use
   `whatsappUrl` and `telegramUrl` from that response. ⚠ They carry the code into the first message, and that is
   the only way it reaches the backend.
4. **Agent:** agents sign up in the app. On `/apps`, tell them to enter the code during sign-up, and show it.

The WhatsApp link prefills the text `Wi-Mall ref: ULRICH123`. If the person deletes it before sending, the
referral is lost. There is no way to fix that afterwards, by the owner's decision: they should ask the referrer
for a new link only if they have not registered yet.

## 2. `/shop/account/referrals`

A new page in the customer account, with a link from the account menu. Build the states in
[the shared rules](../FRONTEND-CHANGELOG-referrals.md).

⚠ Customers are the people with no payout destination, so `payoutDestination.source: null` is normal here. Ask for
a mobile money number with `PUT /api/me/referral/payout-method` before they can withdraw.

If the signed-in person also holds a vendor, agency or agent role with a destination, `source` names it and
`editableHere` is `false`. Show it masked and link to that app's payout page.

## 3. Marketing

A short section may explain the program, reading its numbers from a signed-in `GET /api/me/referral`. There is no
public endpoint for the rates: they can differ per partner.

## 4. The Legal Centre

A new document, `referral-partner-terms`, joins the hub. It appears with the next publish.
