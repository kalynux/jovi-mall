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


/**
 * The letters a search treats as one, accented or not (2026-11-08). French, Portuguese and Spanish
 * names are typed without their accents on a phone keyboard: "electricite" must find
 * "Électricité", and "Électricité" must find a title stored as "Electricite".
 */
const ACCENT_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  a: 'aàáâãäåāăą',
  c: 'cçćĉċč',
  e: 'eèéêëēĕėęě',
  i: 'iìíîïĩīĭįı',
  n: 'nñńņňŉ',
  o: 'oòóôõöøōŏő',
  u: 'uùúûüũūŭůűų',
  y: 'yýÿŷ',
  s: 'sśŝşš',
  z: 'zźżž',
  g: 'gĝğġģ',
});

/**
 * Case- AND accent-insensitive substring matcher for a user-supplied term, for MongoDB `$regex`.
 *
 * The term is folded to its unaccented lower-case letters first, each character is escaped, and
 * every letter that has accented forms becomes a class of all of them, upper case included (so
 * the match does not depend on how the server's regex engine case-folds non-ASCII letters). The
 * output is built only from escaped characters and fixed classes, so it is as safe from
 * injection and backtracking as {@link buildSearchRegex}.
 */
export function buildAccentInsensitiveSearchRegex(term: string): RegExp {
  const folded = term.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const pattern = [...folded]
    .map((ch) => {
      const variants = ACCENT_CLASSES[ch];
      if (!variants) return escapeRegex(ch);
      return `[${variants}${variants.toUpperCase()}]`;
    })
    .join('');
  // eslint-disable-next-line no-restricted-syntax -- every typed character went through escapeRegex above; the only unescaped parts are the fixed ACCENT_CLASSES
  return new RegExp(pattern, 'i');
}
