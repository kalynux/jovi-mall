# Vendor dashboard — delete a product permanently (2026-10-18)

**Status:** built, not deployed. No migration. Additive: nothing that works today changes.

Vendors can now remove a product for good. Until now, "Delete" only ever **archived**
(`DELETE /api/vendor/products/:id`), and that route is unchanged.

Full contract: [products.md § Delete Product Permanently](./products.md#delete-product-permanently).

## The rule, in one line

**Only an archived product that has never been sold can be deleted.** "Sold" means it was
ever on an order, booked, downloaded, or reviewed. A product that sold stays archived, which
already hides it from shoppers. Its order history, downloads, bookings and reviews still need
it.

## What to build

1. **Keep the existing "Archive" action exactly as it is.** It still calls
   `DELETE /api/vendor/products/:id`. ⚠ Do not repoint it at the new route.
2. **Add "Delete permanently" to archived products only**, for example in the archived
   filter of the product list and on an archived product's detail page.
3. **Confirm first.** The action cannot be undone, so the dialog should say so. Then call:

   ```http
   DELETE /api/vendor/products/:id/permanent
   Content-Type: application/json

   { "confirm": true }
   ```

   The body is required. Without it, or with any other key, the answer is `400 VALIDATION_ERROR`.
4. **On `200`**, remove the row from the list. `data.deletedFileCount` is how many pictures
   and files went with it. Optional to show.
5. **On `422 CATALOG_PRODUCT_DELETE_BLOCKED`**, show every entry of `error.details.blockers[]`
   as a list. Every reason is listed at once, so one refusal is enough to show the whole
   picture. ⚠ `message` is **English only**. Translate by `reason`, which is a closed set of
   nine (table below), and use `message` only as the fallback for a `reason` you do not know.
   The English sentences are the source copy:

   | `reason` | English copy (`message`) |
   |---|---|
   | `not_archived` | Archive this product before deleting it permanently. |
   | `has_orders` | This product has been ordered. A product that has been sold can only be archived, never deleted. |
   | `has_bookings` | This service has been booked. A booked service can only be archived, never deleted. |
   | `has_digital_purchases` | Customers have bought this download. It must stay available to them, so it can only be archived. |
   | `has_reviews` | This product has reviews. A reviewed product can only be archived, never deleted. |
   | `checkout_in_progress` | A customer is checking out with this product right now. Try again in about 30 minutes. |
   | `negotiation_in_progress` | A customer is negotiating a price for this product, or holds an agreed price not yet used. Try again once it expires. |
   | `agency_stock_counted` | A delivery agency has recorded stock of this product in its warehouse, so it can only be archived. |
   | `stock_request_pending` | A stock change request for this product is waiting for an answer. Withdraw it or wait for the agency to answer. |

   Three of the reasons are temporary, and a retry later can succeed:
   `checkout_in_progress`, `negotiation_in_progress` and `stock_request_pending`. Every other
   reason is permanent for that product. If you want to hide the button rather than let it
   fail, `not_archived` is the only reason the dashboard can know in advance (from `status`).
6. **On `409 CATALOG_PRODUCT_VECTORISATION_PENDING`**, the product is being indexed for AI
   search: "Try again in a moment". This is the same refusal every other product edit gets.

## Reasons (`details.blockers[].reason`)

| `reason` | Temporary? |
|---|---|
| `not_archived` | — archive first |
| `has_orders` | no |
| `has_bookings` | no |
| `has_digital_purchases` | no |
| `has_reviews` | no |
| `checkout_in_progress` | yes (≈ 30 min) |
| `negotiation_in_progress` | yes |
| `agency_stock_counted` | no |
| `stock_request_pending` | yes, once answered or withdrawn |

`count` is present on every reason except `not_archived`. Treat an unknown `reason` as
permanent and show its `message`.

## Side effects worth knowing

- The product disappears from customers' carts, wishlists and recently-viewed lists.
- Files that nothing else uses are deleted, so the vendor's storage usage goes down. A picture
  shared with another product (for example via Duplicate) is kept.
- A vendor that was over its plan's storage allowance may see blocked files come back. This is
  the same automatic release an archive already triggers.

## Also fixed (no frontend change)

Archiving through `DELETE /api/vendor/products/:id` or `POST /api/vendor/products/bulk/archive`
now tells AI search the product is archived. Only the status-change route used to do that, so
products archived the usual way could stay listed as active in the index the WhatsApp/Telegram
bot searches.
