/**
 * A Mongoose sub-document as a plain object, safe to spread.
 *
 * `Model.findById()` returns a HYDRATED document, so a single-nested path like
 * `agent.settings` is a `SingleNested` instance rather than a POJO. Its schema
 * fields live on the prototype as getters, which means its OWN enumerable keys
 * are `$__parent`, `$__`, `$isNew` and `_doc` — and nothing else. Spreading one
 * therefore copies none of the data and smuggles Mongoose's internals into the
 * update payload, where the cast rebuilds the sub-document from the stale
 * `_doc` and discards the keys the caller actually set. The write then persists
 * the value it started with, and the endpoint answers `200` describing a change
 * that never happened.
 *
 * Use this on any read-modify-write of a sub-document:
 *
 *     const next = { ...plainSubdocument(agent.settings), ...input };
 *
 * A value that is already plain (a `.lean()` read, a fresh literal) is copied
 * as-is, so this is safe to apply without first knowing how the parent was
 * loaded — which is the point, since that is exactly the detail callers get
 * wrong.
 */
export function plainSubdocument<T>(value: T): T {
  const candidate = value as { toObject?: () => T } | null | undefined;
  if (typeof candidate?.toObject === 'function') return candidate.toObject();
  return { ...(value as object) } as T;
}
