/**
 * Escape user-supplied input so it is matched LITERALLY inside a MongoDB
 * `$regex` / `RegExp`, preventing regex-injection and ReDoS from special
 * characters (a bare `(` is a syntax error; `(a+)+` is a catastrophic
 * backtracker; `.*` silently widens the result set).
 *
 * Every search path in this codebase is `$regex`-based — there is no `$text`
 * index anywhere — so any query string that reaches Mongo must pass through
 * here first. This is the single definition; it was previously copy-pasted per
 * module and omitted in several search paths.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive substring matcher for a user-supplied search term.
 * Convenience wrapper over {@link escapeRegex} for the common
 * `{ field: buildSearchRegex(q) }` filter.
 */
export function buildSearchRegex(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}
