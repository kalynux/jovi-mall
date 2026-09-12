/**
 * The deterministic command parser — raw message text in, a resolved command out.
 *
 * ── WHY THIS LIVES IN THE BACKEND, AGAINST THE WRITTEN SPEC ─────────────────
 * `api-doc/n8n/ARCHITECTURE.md` places the parser in the automation layer, in six separate
 * places, and this file is deliberately the other decision. The documents' own reasoning is
 * what overrules them:
 *
 *   ARCHITECTURE.md's `PLATFORM RENDERER` box is a correction the authors wrote against
 *   themselves after moving rendering server-side — *"this layer relays, it does not
 *   render… Each of those three moves was reported as a defect rather than foreseen."*
 *
 *   `bot-surface.md` § 14.6 makes the identical argument about PARSING: *"The reason is not
 *   ergonomics, it is parsing. A typed answer is language-dependent and whatever reads it is
 *   not… That table would have lived in the automation layer, which is the one layer with no
 *   copy table."*
 *
 * The alias table is a five-language table (`/chercher /buscar /procurar`,
 * `/annuler /cancelar`). It is exactly the kind of table that argument is about. The
 * boundary has already moved server-side three times for copy and once for idempotency;
 * this is the fifth move and the first made on purpose rather than after a defect report.
 *
 * ── PURE, AND IT MUST STAY PURE ─────────────────────────────────────────────
 * No I/O, no clock, no database — the registry is passed in. That is what lets the whole
 * grammar be tested without Mongo, and it is the discipline `bot-onboarding.ts` already
 * keeps (that file imports nothing at all).
 *
 * ⚠ **Ordinal arguments are NOT resolved here.** `product_ref` admits "the second one",
 * which needs the conversation's last result — so resolution belongs to the router, where
 * that context exists. A parser reaching for it would stop being pure and would still be
 * unable to validate `product_ref` at parse time.
 */

/** What a command declares about one of its positional arguments. */
export interface CommandArgSpec {
    name: string;
    /**
     * `free_text` is the one type that changes TOKENISING: everything from that position on
     * is joined into it. Every other type takes exactly one whitespace-separated token.
     */
    type: 'free_text' | 'identifier' | 'enum' | 'quantity';
    required: boolean;
    /** For `enum`. Absent means the router validates it. */
    values?: readonly string[];
}

/** The parser's view of a command. The registry supplies everything else. */
export interface CommandGrammarSpec {
    name: string;
    aliases: readonly string[];
    args: readonly CommandArgSpec[];
}

export type ParseOutcome =
    /** Not command-shaped at all. Goes to the model, always. */
    | { kind: 'not_a_command' }
    /** Command-shaped and recognised. */
    | { kind: 'matched'; name: string; args: Record<string, string>; positional: string[] }
    /**
     * Command-shaped and NOT recognised. ⚠ This is never handed to the model —
     * `commands.json`: *"a typo'd /cancel must not become a cancellation."*
     */
    | { kind: 'unknown'; typed: string };

/**
 * Case-fold and strip diacritics, for matching a command NAME only.
 *
 * ⚠ **Arguments are never folded.** `/search café` must search for `café`; folding the whole
 * message would quietly change what the customer asked for. The spec draws the line in the
 * same place: *"Diacritic-insensitive on the command name. Arguments keep their accents."*
 *
 * The combining-mark range is stripped after NFD rather than using `\p{Diacritic}`, because
 * the property escape needs the `u` flag and a `u`-flagged class here would also change how
 * the rest of this file's regexes treat lone surrogates in an emoji-laden message.
 */
export function foldCommandName(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

/**
 * Split a command tail into tokens, honouring double quotes.
 *
 * ⚠ **Only the straight double quote groups**, because it is the only one the spec names.
 * A smart quote is ORDINARY TEXT here — treating it as grouping would mean a customer whose
 * keyboard produced a curly quote got a different search from one whose did not, which is
 * worse than the quote simply being part of the term.
 *
 * An unterminated quote runs to the end of the string rather than failing: the customer is
 * typing a sentence, not a shell command.
 */
export function tokenizeArguments(tail: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoted = false;

    for (const character of tail) {
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && /\s/.test(character)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += character;
    }

    if (current.length > 0) tokens.push(current);
    return tokens;
}

/**
 * Parse one inbound message.
 *
 * @param text     the RAW message text. ⚠ Never Telegram's `bot_command` entity — that
 *                 entity stops at a hyphen, which is the trap `commands.json`'s
 *                 `canonical_name_rule` documents at length.
 * @param registry every command, matched on canonical name and on aliases alike.
 */
export function parseCommand(
    text: string | null | undefined,
    registry: readonly CommandGrammarSpec[],
): ParseOutcome {
    if (typeof text !== 'string') return { kind: 'not_a_command' };

    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return { kind: 'not_a_command' };

    // A lone `/` is somebody opening the autocomplete menu and thinking better of it.
    if (trimmed === '/') return { kind: 'not_a_command' };

    /**
     * The colon form binds to the FIRST argument only — `/support:vendor` is
     * `/support vendor`, and there is deliberately no `/cmd:a:b`. Splitting the head on its
     * first colon and tokenising the remainder gives both forms one code path.
     */
    const firstSpace = trimmed.search(/\s/);
    const head = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);

    const colonAt = head.indexOf(':');
    const wordRaw = colonAt === -1 ? head : head.slice(0, colonAt);
    // A trailing `:` with no argument is the bare command.
    const colonArg = colonAt === -1 ? '' : head.slice(colonAt + 1);

    // `@botname` is appended by Telegram wherever a bot shares a chat.
    const word = foldCommandName(wordRaw.replace(/@[^\s:]*$/, ''));
    if (!word) return { kind: 'not_a_command' };

    const spec = registry.find(
        (row) =>
            foldCommandName(row.name) === word
            || row.aliases.some((alias) => foldCommandName(alias) === word),
    );

    if (!spec) return { kind: 'unknown', typed: word };

    const tail = tokenizeArguments(rest);
    const positional = colonArg ? [colonArg, ...tail] : tail;

    return { kind: 'matched', name: spec.name, args: bindArguments(spec, positional), positional };
}

/**
 * Bind positional tokens onto the command's declared argument names.
 *
 * ⚠ **The LAST declared argument decides how the tail is treated**, which is the spec's
 * *"joined for free-text commands, and split for identifier commands"* made mechanical. So
 * `/search red summer dress` is one query rather than three, while `/cart qty ABC 3` keeps
 * its three tokens apart. A command whose free-text argument were NOT last would silently
 * swallow every argument after it — none exists, and the registry's boot guard refuses one.
 */
function bindArguments(
    spec: CommandGrammarSpec,
    positional: readonly string[],
): Record<string, string> {
    const bound: Record<string, string> = {};
    if (spec.args.length === 0) return bound;

    spec.args.forEach((arg, index) => {
        const isLast = index === spec.args.length - 1;

        if (isLast && arg.type === 'free_text') {
            const joined = positional.slice(index).join(' ').trim();
            if (joined) bound[arg.name] = joined;
            return;
        }

        const value = positional[index];
        if (value !== undefined && value !== '') bound[arg.name] = value;
    });

    return bound;
}
