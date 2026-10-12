# Vendor dashboard: Wi-Mall Protection, 3 days (2026-10-10)

**Backend built and tested, not deployed yet. The Seller Agreement 1.2 is already live.**
Shared rule: [../FRONTEND-CHANGELOG-wi-mall-protection.md](../FRONTEND-CHANGELOG-wi-mall-protection.md).

## What changed for the seller

1. **A customer's problem report now pauses the earnings of that order or booking**, when it is
   made before the earnings are released (3 days after delivery).
2. **The seller cannot lift that pause.** It ends when the customer or Wi-Mall resolves or closes
   the request. The seller changing the ticket's status changes nothing for the money.
3. **After the 3 days, Wi-Mall no longer settles the problem.** The customer deals with the
   seller directly. The seller's own return window (14 days by default) still binds the seller.
4. **Orders are completed automatically 3 days after delivery** (it was 7). This is the order's
   status only; it never delayed the money.

No request or response shape changed, except one new field.

## New: `holds_earnings` on a ticket

Present on every ticket read (`GET /api/vendor/tickets`, `GET /api/vendor/tickets/:id`).
`true`: this request keeps the earnings of its order or booking paused.

The seller sees these tickets because the order's seller follows every request about the order.

⛔ The vendor API does **not** return a pause reason anywhere. Do not look for one. The ticket
flag is the signal. On the order's money split, the affected shares keep showing the existing
`paused` wait state.

## What to build

1. **Ticket list:** a small "Earnings on hold" badge on rows with `holds_earnings: true`.
2. **Ticket detail:** a banner while `holds_earnings` is `true`.
3. **Status menu on such a ticket:** when the seller picks `resolved` or `closed`, show a note
   first. The status change still goes through; the money stays paused.
4. **Earnings help text and the payout screen:** add the new pause case.
5. **Return policy settings screen:** add one line under the return window field.
6. **Replace every "7 days"** about automatic order completion with "3 days".

## Copy

| Where | EN | FR |
|---|---|---|
| Badge | Earnings on hold | Revenus suspendus |
| Ticket banner | The customer reported a problem with this order. Your earnings for it are on hold until the customer or Wi-Mall closes this request. | Le client a signalé un problème concernant cette commande. Vos revenus correspondants sont suspendus jusqu'à ce que le client ou Wi-Mall clôture cette demande. |
| Note on resolve / close | Marking this request as resolved does not release your earnings. They are released when the customer or Wi-Mall closes it. | Marquer cette demande comme résolue ne libère pas vos revenus. Ils sont libérés lorsque le client ou Wi-Mall la clôture. |
| Earnings help | Earnings can also be paused when a customer reports a problem within 3 days of delivery. Paused time does not count: the hold continues where it stopped. | Les revenus peuvent aussi être suspendus lorsqu'un client signale un problème dans les 3 jours suivant la livraison. La durée de la suspension n'est pas décomptée : la période de rétention reprend là où elle s'était arrêtée. |
| Return window field | Wi-Mall settles customer problems during the first 3 days after delivery. After that, your return window is your own commitment: you handle the return and the refund with the customer. | Wi-Mall règle les problèmes des clients pendant les 3 premiers jours suivant la livraison. Passé ce délai, votre délai de retour est votre propre engagement : vous gérez le retour et le remboursement avec le client. |
| Automatic completion | Orders are completed automatically 3 days after delivery. | Les commandes sont finalisées automatiquement 3 jours après la livraison. |

## Docs to read

- [earnings.md](./earnings.md) § Paused earnings (updated)
- [tickets.md](./tickets.md) § `PATCH /api/vendor/tickets/:id/status`
- [orders.md](./orders.md) § refund eligibility: the seller's own refund button is unchanged and
  still works for the whole return window

## Done when

- A ticket with `holds_earnings: true` shows the badge and the banner.
- Resolving it shows the note, and the banner stays until the flag turns `false`.
- No screen says earnings are released, or orders completed, after "7 days".
