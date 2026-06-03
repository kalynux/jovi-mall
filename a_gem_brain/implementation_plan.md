# Unified Optimistic Concurrency Control (OCC)

Standardize OCC across the entire codebase to use a single, consistent mechanism instead of the current three divergent approaches.

## Problem: Three Different OCC Mechanisms

| Module | Field | Stored On | Auto-incremented? | Where Used |
|--------|-------|-----------|--------------------|------------|
| **Vendor** profile | `version` (custom) | `vendor.version` | Manual `$inc` in repo | `PATCH /profile` only — **NOT on onboarding steps** |
| **Store** profile | `version` (custom) | `store.version` | Manual `$inc` in repo | `PATCH /store`, `PATCH /store/status` |
| **Agency** onboarding | `updated_at` (timestamp) | `agency.updated_at` | Mongoose auto-set | All 4 onboarding `PUT` endpoints |
| **Vendor** onboarding | ❌ None | — | — | No OCC at all |

## Chosen Strategy: `__v` (Mongoose versionKey)

> [!IMPORTANT]
> **Mongoose's `__v` is NOT automatically incremented by `findOneAndUpdate()`.** It's only auto-incremented by `.save()`. Since the entire codebase uses `findOneAndUpdate` for mutations, `__v` provides no "free" automation over a custom `version` field — both require explicit `$inc: { __v: 1 }` in every update query.

Given this reality, there are **two viable options**:

### Option A: Use `__v` anyway
- **Pro**: Standard Mongoose convention, no extra schema fields needed, already present on every document.
- **Con**: Currently stripped from responses in `BaseSchemaOptions.toJSON` (`delete ret.__v`). The base schema would need updating and every DTO that maps responses would need to expose `__v`.
- **Con**: `__v` is a Mongoose implementation detail — building business logic on it couples us to Mongoose internals.

### Option B: Keep `version` (custom integer) and standardize it everywhere
- **Pro**: Already used by Vendor and Store modules — 2 out of 3 modules are already on this pattern.
- **Pro**: Explicit, self-documenting field name. No coupling to ORM internals.
- **Pro**: No need to touch `BaseSchemaOptions` or change what's stripped from JSON.
- **Con**: Requires adding a `version` field to the agency model (the only module not using it).

> [!WARNING]
> **Recommendation: Option B (`version` integer).** Two modules already use it, the field name is explicit, and it avoids coupling business logic to Mongoose's `__v` implementation detail. The `__v` field continues to exist on documents for Mongoose's internal array-diffing but should NOT be used for application-level OCC.

## Open Questions

> [!IMPORTANT]
> **Should `version` be required or optional on vendor/agency onboarding step submissions?**
> 
> The agency dashboard currently sends `updated_at` as **optional** — if omitted, no OCC check happens. The same approach would apply: if `version` is sent, the backend validates it; if not, the write proceeds without a concurrency guard. This keeps onboarding forms simple for solo users while protecting against multi-tab/admin scenarios.
> 
> **Recommended: Optional.** The same pattern the agency already uses.

---

## Proposed Changes

### Component 1: Shared Infrastructure

#### [MODIFY] [base.schema.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/base.schema.ts)

No changes needed. `__v` continues to be stripped from JSON output. The custom `version` field is returned explicitly by each DTO mapper.

---

### Component 2: Delivery Agency Module

The agency currently uses `updated_at` timestamp comparison. We'll migrate it to use an integer `version` field, matching the vendor/store pattern.

#### [MODIFY] [delivery-agency.model.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/delivery-agency.model.ts)

- Add `version: { type: Number, default: 0 }` to the schema definition.
- Add `version: number` to the `IDeliveryAgency` interface.

#### [MODIFY] [delivery-agency.repository.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/delivery-agency.repository.ts)

- Rename `atomicOnboardingUpdate` parameter from `expectedUpdatedAt?: Date` to `expectedVersion?: number`.
- Change the filter from `filter.updated_at = expectedUpdatedAt` to `filter.version = expectedVersion`.
- Add `$inc: { version: 1 }` to the update operation.
- Update `updateProfile` to also `$inc: { version: 1 }` for consistency (general profile updates).

#### [MODIFY] [agency-profile.service.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/services/agency-profile.service.ts)

- Update all `completeStep1`–`completePolicySetup` signatures: `expectedUpdatedAt?: Date` → `expectedVersion?: number`.
- Update the service docblock comment from "updated_at check" to "version check".

#### [MODIFY] [agency-profile.controller.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/controllers/agency-profile.controller.ts)

- Change all step handlers from:
  ```ts
  const expectedUpdatedAt = req.body.updated_at ? new Date(req.body.updated_at) : undefined;
  ```
  to:
  ```ts
  const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
  ```

#### [MODIFY] [agency-profile.dto.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/dto/agency-profile.dto.ts)

- Add `version: number` to `GetAgencyProfileResponseDto` interface.
- Add `version: agency.version` to the `toResponseDto` mapper (alongside the existing `updatedAt`).
- Add `version: agency.version` to `toCreateResponseDto`.

#### [MODIFY] [agency-onboarding.validator.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/validators/agency-onboarding.validator.ts)

- No structural changes needed to step schemas since `version` is extracted from `req.body` in the controller rather than being part of the Zod schema (matching the existing `updated_at` pattern).

#### [MODIFY] [agency.routes.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/delivery/agency.routes.ts)

- Update JSDoc comments from `{ updated_at }` to `{ version }`.

---

### Component 3: Vendor Module

The vendor profile update already uses `version`. We need to add OCC to the onboarding step handlers.

#### [MODIFY] [vendor-profile.controller.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/vendor/controller/vendor-profile.controller.ts)

- In each of `completeBasicSetup`, `completeDeliveryLinking`, `completeBrandingSetup`:
  ```ts
  const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
  ```
- Pass `expectedVersion` to the service methods.

#### [MODIFY] [vendor-profile.service.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/vendor/service/vendor-profile.service.ts)

- Update `completeStep1`, `completeStep2`, `completeStep3` signatures to accept `expectedVersion?: number`.
- When `expectedVersion` is provided, add `version: expectedVersion` to the `findOneAndUpdate` filter.
- Add `$inc: { version: 1 }` to onboarding update operations.
- When `expectedVersion` is provided and the update returns null, throw a new `VENDOR_ONBOARDING_CONCURRENT_MODIFICATION` error.

#### [MODIFY] [vendor.repository.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/vendors/vendor.repository.ts)

- Add an `atomicOnboardingUpdate` method (matching the agency repo pattern) that:
  - Accepts `vendorId`, `updates`, and optional `expectedVersion`.
  - Adds `version` to the filter when provided.
  - Always does `$inc: { version: 1 }`.
- Update `updateOnboardingStep` to also `$inc: { version: 1 }`.

#### [MODIFY] [vendor routes.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/vendor/routes.ts)

- Add JSDoc noting `{ version }` as optional OCC field on each onboarding PUT route.

---

### Component 4: Error Codes

#### [MODIFY] [error-codes.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/error-codes.ts)

- Add `VENDOR_ONBOARDING_CONCURRENT_MODIFICATION` error code.

#### [MODIFY] [errors.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/errors.ts)

- Add default message for the new error code.

---

### Component 5: Documentation Updates

#### [MODIFY] [api-doc/vendor/onboarding.md](file:///c:/Users/Fante/Desktop/projects/jovi-mall/api-doc/vendor/onboarding.md)

- Add `version` field documentation to each step's field reference table.
- Add OCC section (mirroring the agency doc's concurrency guidance).
- Add `409 VENDOR_ONBOARDING_CONCURRENT_MODIFICATION` to the error table.

#### [MODIFY] [api-doc/agency/onboarding.md](file:///c:/Users/Fante/Desktop/projects/jovi-mall/api-doc/agency/onboarding.md)

- Replace all `updated_at` references with `version` (integer).
- Update the "Optimistic Concurrency" section to describe the integer version pattern.
- Update the error table description for `DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION`.

---

## Verification Plan

### Automated Tests

```bash
npx tsc --noEmit
```
Ensure no new type errors are introduced.

### Manual Verification

1. Confirm `version` appears in GET profile responses for both vendor and agency.
2. Submit an onboarding step **without** `version` → should succeed (OCC skipped).
3. Submit an onboarding step **with correct `version`** → should succeed, `version` increments.
4. Submit an onboarding step **with stale `version`** → should return `409`.

---

## Summary of Final State

After implementation, **all modules** use the same OCC pattern:

| Module | OCC Field | Required? | How It Works |
|--------|-----------|-----------|--------------|
| Vendor Profile (`PATCH /profile`) | `version` | **Required** | Must match; `$inc` on success |
| Vendor Onboarding (`PUT /onboarding/*`) | `version` | Optional | If sent, must match; `$inc` on success |
| Store Profile (`PATCH /store`) | `version` | **Required** | Must match; `$inc` on success |
| Agency Onboarding (`PUT /onboarding/*`) | `version` | Optional | If sent, must match; `$inc` on success |
| Agency Profile (future) | `version` | — | Ready for when general profile update endpoint is added |
