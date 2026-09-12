/**
 * What to say when a message is command-shaped and names nothing.
 *
 * ⚠ **The one rule this file exists to enforce: an unknown command is NEVER handed to the
 * model as prose.** `commands.json` states the reason in one line — *"a typo'd /cancel must
 * not become a cancellation"* — and it is the difference between a mistyped word and an
 * order that no longer exists. A model reading `/cancle ORD-2026-000123` charitably is
 * behaving correctly and doing the wrong thing.
 *
 * ── DAMERAU, NOT PLAIN LEVENSHTEIN ──────────────────────────────────────────
 * The transposition is the whole point: `/cnacel` is **one** Damerau edit from `cancel` and
 * **two** plain ones, and swapped adjacent letters are the single most common typing error
 * on a phone keyboard. Under plain Levenshtein it sits exactly at the threshold alongside
 * genuinely unrelated words, which is where a wrong suggestion comes from.
 *
 * ── CANONICAL NAMES ONLY, WHICH RESOLVES A CONTRADICTION IN THE SPEC ────────
 * `COMMAND-SPECIFICATION.md` says *"the closest canonical name"*; `commands.json` says
 * *"the closest match"*. They disagree, and the narrower reading is the correct one:
 * matching aliases too puts five languages in the candidate set, where `/anular` is within
 * two edits of BOTH `annuler` and `cancelar` and `/carito` of `carrito`. Suggesting a word
 * in a language the customer did not write, chosen by a tie-break they cannot see, is worse
 * than offering `/help`.
 */

/** The threshold the spec fixes. Two edits, inclusive. */
export const MAX_SUGGESTION_DISTANCE = 2;

/**
 * Damerau-Levenshtein with adjacent transposition (the "optimal string alignment" variant).
 *
 * OSA rather than unrestricted Damerau deliberately: unrestricted needs an alphabet-sized
 * table for a difference that cannot show up at a threshold of two, and every command name
 * here is short enough that the quadratic table is a few dozen cells.
 */
export function editDistance(left: string, right: string): number {
    if (left === right) return 0;
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;

    const rows = left.length + 1;
    const columns = right.length + 1;
    const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

    for (let row = 0; row < rows; row += 1) table[row][0] = row;
    for (let column = 0; column < columns; column += 1) table[0][column] = column;

    for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;

            table[row][column] = Math.min(
                table[row - 1][column] + 1,
                table[row][column - 1] + 1,
                table[row - 1][column - 1] + cost,
            );

            const transposed =
                row > 1
                && column > 1
                && left[row - 1] === right[column - 2]
                && left[row - 2] === right[column - 1];

            if (transposed) {
                table[row][column] = Math.min(table[row][column], table[row - 2][column - 2] + cost);
            }
        }
    }

    return table[rows - 1][columns - 1];
}

/**
 * The closest canonical name within the threshold, or null.
 *
 * ⚠ **A tie yields NOTHING, and that is deliberate** — the spec states a threshold and never
 * states a tie-break, so inventing one (alphabetical, registry order) would make the
 * suggestion depend on something the customer cannot see and the author did not choose.
 * Two equally-close candidates mean the platform genuinely does not know which was meant,
 * and `/help` is the honest answer.
 *
 * @param typed  the folded command word, already stripped of `/` and `@botname`
 * @param names  canonical names only — never aliases; see the header
 */
export function suggestCommand(typed: string, names: readonly string[]): string | null {
    if (!typed) return null;

    let best: string | null = null;
    let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
    let tied = false;

    for (const name of names) {
        const distance = editDistance(typed, name);
        if (distance > MAX_SUGGESTION_DISTANCE) continue;

        if (distance < bestDistance) {
            best = name;
            bestDistance = distance;
            tied = false;
        } else if (distance === bestDistance) {
            tied = true;
        }
    }

    return tied ? null : best;
}
