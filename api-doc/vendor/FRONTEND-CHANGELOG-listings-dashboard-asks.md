# Frontend changelog (vendor dashboard, providers) — country, two phone numbers, listing search (2026-11-08)

The three backend changes the vendor dashboard asked for. Contract: `service-listings.md` (§ 1 Vendor kind,
§ 3 Listings). Not deployed yet.

## 1 · A provider's country is set at sign-up — remove the workaround

`POST /api/auth/register` and add-role with `vendorKind: "provider"` now set `vendors.country` from the
sign-up phone number's country code (`+237…` → `CM`, `+225…` → `CI`), or `CM` when it matches no country.
The platform's own dial-code table decides (no libphonenumber): longest code first, so `+1` resolves to the
first country listed with it.

- **Delete the first-visit `PATCH /vendor/profile { country }`.** It now does nothing for a new provider, and
  for one whose country is already set it is harmless only if it sends the same value: a different value is
  `403 PROFILE_COUNTRY_IMMUTABLE` (country is set-once).
- Providers registered earlier receive the same value from a backfill run at deploy
  (`backfill:provider-country`). A provider whose country the workaround already set keeps it.
- Read the country as before (`GET /api/vendor/profile` → `country`). Show it read-only.

## 2 · Up to two phone numbers on a listing — the field is `phone2`

Confirmed contract (the alternative `phones: string[]` was not taken, so nothing already built against
`phone` changes):

| Where | Shape |
|---|---|
| Write: `POST` / `PATCH /api/vendor/listings[/:id]` → `contacts` | `phone` (E.164), **`phone2`** (E.164, optional, `null` clears). `whatsapp` stays one number |
| Read: `GET /api/vendor/listings/:id` → `contacts.published` / `contacts.pending` | `phone`, **`phone2`** (`null` when unset) |
| Customer's reveal reply, `field: "phone"` | `value: { number, numbers }` — `numbers` is both, first first; `number` is `numbers[0]` |

Rules to reflect in the editor:

1. **One field, one charge.** "Phone" stays one contact button for customers: unlocking it shows both
   numbers for the price of one field. The seven-field bound is unchanged. Say so beside the second input
   ("Customers see both numbers when they unlock your phone, for one charge").
2. **The backend keeps the pair clean.** A `phone2` equal to `phone` (same digits) is dropped. A `phone2`
   with no `phone` becomes `phone`. Clearing `phone` moves the second number up. Re-read the detail after
   saving rather than echoing your form.
3. **Validation:** E.164 (`+2376…`), the same rule as `phone`: `400 VALIDATION_ERROR` otherwise. Use the
   same country picker as the first number.
4. **"Ask them to call me" sends the FIRST number**, as before. Label it so in the leads screen.
5. A change to either number on a live listing is a revision reviewed like any other edit.

## 3 · Server-side search on the listings list — `q`

`GET /api/vendor/listings?q=&status=&page=&limit=`

- `q`: 1–200 characters, trimmed. Matches the **title** and the **company name**, on the working copy and the
  live copy, so a draft and a live listing under revision are both found by either name.
- **Case- and accent-insensitive** both ways (`electricite` ↔ "Électricité"). Typed characters are literal.
- Combines with `status`. Paginated as before (`meta.total` counts the matches).
- `q=""` or over 200 characters is `400 VALIDATION_ERROR`: omit `q` for the full list, and debounce the box
  (≈300 ms).

**Remove the in-browser search over the first 100 rows**; it missed listings beyond the first page.
