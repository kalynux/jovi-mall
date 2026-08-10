# Vehicle colour & photo

> **Status: built.** Both halves of this document are implemented. The photo
> persists and comes back as `vehicle_info.photo`; colours are normalized on
> write. One operational step is outstanding — the colour migration has been
> dry-run but **not applied**. See [What is left](#what-is-left).

The agent app replaced the free-text vehicle colour box with a swatch palette,
and added an optional photo of the vehicle, both in onboarding step 1
(`PATCH /api/agent/onboarding/step`) and in the profile editor
(`PATCH /api/agent/profile`, field `vehicle_info`).

The endpoint-level contract lives in [profile.md](./profile.md) and
[onboarding.md](./onboarding.md). This page is the design record: what the two
fields mean and why they are shaped the way they are.

---

## 1. `color` is a vocabulary, not free text

`VehicleInfoSchema.color` was `z.string().min(1).max(50)` — validated for length
and nothing else. What reached an agency dispatcher was whatever the agent
typed: `Red`, `red`, `rouge`, `dark blu`, `Silver/grey`. It could not be
filtered, translated, or shown as a colour.

### The vocabulary

```
white  silver  grey  black  red  orange  yellow  green  blue  purple  brown  beige  gold
```

Same convention `vehicle_type` already uses: lowercase, singular, English,
**never localized on the wire**. Each consumer renders its own translated label
and swatch.

### What was built

1. **`color` is still a string.** Not a `z.enum`, deliberately — two populations
   would fail validation on their next profile save: every agent onboarded
   before the palette, and the "another colour" escape hatch the app keeps for a
   two-tone or unusual vehicle. The field stays `z.string().min(1).max(50)`; the
   vocabulary is a documented convention, not a constraint.

2. **Normalized on write.** `normalizeVehicleColor` trims, lowercases, collapses
   inner whitespace and maps known aliases (`gray → grey`) before storing.
   Capitalisation (`Red → red`) falls out of the lowercasing. Anything
   unrecognised is stored verbatim — that is the escape hatch, and it has to
   survive intact.

   The alias map is deliberately tiny, and its docstring says so: grow it from
   the migration's unmapped report, not from guesses. Inventing an alias
   silently rewrites what an agent reported.

3. **A migration for the stored values.** `npm run migrate:agent-vehicle-colors`
   (`--dry-run` supported, idempotent). It normalizes every stored
   `vehicle_info.color` and — the part that matters — **reports every value that
   is not in the vocabulary**, with counts and samples of the raw text. That
   list is the evidence for whether the palette is missing a colour: if 200
   agents wrote some variant of "maroon", the palette should gain it rather than
   pushing them all through the escape hatch.

4. **Other consumers.** `agent-directory.dto.ts` and
   `agency-tracking-board.service.ts` expose `vehicleType` only — unaffected.
   The agency roster and the admin agent view do render `color`, and now receive
   `red` where they used to receive `Red`. Each should map token → its own
   localized label, exactly as it already does for `vehicle_type`.

5. **Not built: a `color` filter.** `BrowseAgentsQuerySchema` takes
   `vehicle_type`; a `color` filter is now *possible* for the first time, since
   the values are a vocabulary. The app does not need it, so it was left out.

---

## 2. `vehicle_info.photo_file_id`

Pickup points and dispatchers identify an agent's vehicle by sight. Type +
colour + plate is a description; a photo is the thing itself.

The field is modelled **exactly** on `avatar_file_id`, which already did all of
this correctly.

**Write** — `vehicle_info.photo_file_id`, a 24-hex file id, `clearable()`:

```jsonc
{
  "step": 1,
  "vehicle_info": {
    "vehicle_type": "van",
    "color": "white",
    "plate_number": "LT-123-AB",
    "photo_file_id": "665f1c2a9b1e4a0012a3b4ee"  // null/"" clears; omit = unchanged
  }
}
```

Upload to the existing `POST /api/files/upload` first and send the returned
`id` — there is no new upload route.

**Read** — `vehicle_info.photo`, a resolved file object (`resolveFileDetail`),
or `null`. Never a bare URL string, never the raw id:

```jsonc
"vehicleInfo": {
  "vehicle_type": "van",
  "color": "white",
  "plate_number": "LT-123-AB",
  "photo": {
    "id": "665f1c2a9b1e4a0012a3b4ee",
    "key": "...", "url": "https://...", "mimeType": "image/jpeg",
    "size": 284119, "originalName": "van.jpg"
  }
}
```

### The five things that were easy to get wrong

1. **`vehicle_info` was replaced wholesale.** `toUpdatePayload` did
   `payload.vehicle_info = input.vehicle_info`, which breaks the promise
   `clearable()` makes on `plate_number` — and would have broken it on
   `photo_file_id` too: any client PATCHing `vehicle_info` to fix a plate number
   would silently drop the photo, with a `200` back. The sub-document is now
   **merged** (`mergeVehicleInfo`), on both write paths. `vehicle_type` and
   `color` are required by the schema so they always come from the patch; the
   two clearable slots keep their stored value when omitted.

2. **The file reference is reconciled on every change**, under
   `entityType: 'agent', field: 'vehicle_photo'` — its own field, so the avatar
   and the photo are counted independently. The photo appears under
   `usage.references` on `GET /api/files/:id`, cannot be deleted while attached,
   and the *previous* photo is released when replaced. Without this, replacing a
   photo ten times leaves ten undeletable files against the agent's quota.

3. **Onboarding step 1 accepts it too.** `AgentOnboardingStep1Schema` uses the
   same `VehicleInfoSchema`, so it came free — but it is now asserted in the
   test suite rather than assumed, because `z.object` **strips unknown keys
   silently**. That is exactly how the field failed before it existed: the app
   sent `photo_file_id`, the request returned `200`, and the photo was gone.
   There was no error to notice.

4. **Who may see it.** The photo is on the agent's own profile, the admin agent
   view, and the agency's roster **detail** (`GET /api/agency/agents/:membershipId`)
   — the three surfaces that return the full profile DTO and already carry the
   plate number and avatar. The roster **list** returns a photo-less summary
   shape instead of `photo: null`, because "this view does not carry it" and
   "this agent has no photo" are different claims. This is a product call, and a
   reversible one: narrowing it to the agent's own profile means passing no
   photo at the other two call sites.

5. **Image-only.** `POST /api/files/upload` takes any allowed kind, so a PDF's
   id could be sent as a vehicle photo. A non-image `mimeType` is rejected at
   attach time with `400 CATALOG_FILE_TYPE_INVALID`.

---

## Where it lives

| Concern | File |
|---|---|
| Palette, normalization, merge rule (pure, DB-free) | `src/modules/agents/domain/vehicle-info.ts` |
| Field + validation | `models/agent.model.ts`, `validators/agent.validator.ts` |
| Wire shape (`photo`, and the summary variant) | `dto/agent-profile.dto.ts` |
| Photo resolution, reference-counting, image guard | `domain/services/agent-profile.service.ts` |
| Colour migration | `scripts/migrate-agent-vehicle-colors.ts` |
| Tests (31 assertions, no DB) | `npm run test:vehicle-profile` |

---

## What is left

- **Run the colour migration.** `npm run migrate:agent-vehicle-colors --dry-run`
  first; the unmapped report is the interesting output. On the dev database it
  surfaces French colour names (`rouge`, `bleu`) — decide whether those become
  aliases (`rouge → red`) or a signal that the app should offer more of the
  palette, then add the aliases before running it for real.
- **Localize the colour tokens** in the agency dashboard and admin views, the
  way `vehicle_type` already is.
