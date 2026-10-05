# FRONTEND CHANGELOG — earnings available 3 days after delivery (2026-10-05)

**Audience:** the agency dashboard. Owner decision of 2026-10-05. **No endpoint or response shape changed**: only
*when* money moves from `pending` to `available`. The work is copy.

**Before:** money waited for the whole order to be *completed* (the customer's confirmation, or 7
days after delivery), then a further 7 days.

**Now:** money becomes available **3 days after the order is delivered**, meaning the courier
finished the order's **last** parcel (for cash on delivery: the customer's code was entered, and the
cash must still reach Wi-Mall before release, as before). Everyone on the order is paid on the same
date. The customer's confirmation no longer delays anyone.

**Paused earnings:** money on an order can be paused, and is then not released: a card payment
disputed by the customer, a paid order cancelled by the seller, or our team investigating. When the
pause is lifted, the 3 days continue where they stopped. Mention it in the earnings help text so a
`pending` balance that is not moving has an explanation.

→ Update every place that explains when earnings become withdrawable. Full text: [earnings.md § When it lands](./earnings.md).
