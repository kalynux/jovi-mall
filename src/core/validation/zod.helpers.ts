import { z } from 'zod';

/**
 * Clearable optional field for PATCH bodies.
 *
 * `.optional()` alone only means "the key may be absent" — once the key is
 * present, the value must still satisfy the wrapped constraint. A field
 * validated as `z.string().url().optional()` can therefore never be emptied
 * again: `''` fails `.url()` and `null` fails the string type check.
 *
 * `clearable()` adds the missing "clear" semantics:
 *
 *   - key absent          → leave the field unchanged
 *   - `null`, `''`, `'  '` → clear the field (mappers receive `null`)
 *   - anything else       → must satisfy the wrapped schema
 *
 * Empty/whitespace-only strings are normalised to `null` because an emptied
 * form input naturally submits `''` — frontends should not have to
 * special-case that into `null` themselves.
 *
 * Usage:
 *   logoUrl: clearable(z.string().url('Logo URL must be valid')),
 */
export function clearable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable().optional()
  );
}
