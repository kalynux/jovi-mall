/**
 * Test: the typed slash-command layer — the parser, the registry, and the contract pin.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free by construction: the parser and the suggestion rule are pure functions, and the
 * registry imports nothing but them.
 *
 * ── WHY THIS SUITE EXISTS AT ALL ────────────────────────────────────────────
 * `api-doc/n8n/tools/commands.json` was, until this change, **the only machine-readable
 * file in `tools/` that nothing read and nothing validated**. `catalog.json` is generated
 * from and asserted against `BOT_ROUTES` row for row; `commands.json` had neither, so its
 * 34 rows could say anything at all and no build, test or boot would notice. § 1 below is
 * that missing half: the registry in `src/` is the runtime truth, this file is the doc
 * mirror, and the assertion is what keeps them one thing.
 *
 * Run: npm run test:bot-commands
 */
import fs from 'fs';
import path from 'path';
import {
    CANONICAL_COMMAND_NAMES,
    CANONICAL_NAME_PATTERN,
    COMMANDS,
    LIVE_COMMANDS,
    assertCommandRegistryValid,
} from '../../src/modules/bot-commands/domain/command-registry';
import { foldCommandName, parseCommand, tokenizeArguments } from '../../src/modules/bot-commands/domain/command-parser';
import { editDistance, suggestCommand } from '../../src/modules/bot-commands/domain/command-suggest';
import { assertCommandCopyComplete, commandDescription, commandSentence } from '../../src/modules/bot-commands/domain/command-copy';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

interface DocCommand {
    name: string;
    aliases: string[];
    syntax: string;
    args?: { name: string; required?: boolean; on_missing?: string }[];
}

const doc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'api-doc/n8n/tools/commands.json'), 'utf8'),
) as { commands: DocCommand[]; grammar: { canonical_name_rule: { pattern: string } } };

function main(): void {
    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The contract copy — the registry against commands.json');

    assert('every documented command exists in the registry, and vice versa', () => {
        const docNames = doc.commands.map((c) => c.name).sort();
        const codeNames = [...CANONICAL_COMMAND_NAMES].sort();
        const same = JSON.stringify(docNames) === JSON.stringify(codeNames);
        if (!same) {
            const onlyDoc = docNames.filter((n) => !codeNames.includes(n));
            const onlyCode = codeNames.filter((n) => !docNames.includes(n));
            console.error('     ↳ doc only:', onlyDoc.join(', ') || '—');
            console.error('     ↳ code only:', onlyCode.join(', ') || '—');
        }
        return same;
    });

    assert('every command agrees with the doc on its ALIASES, in order', () => {
        const bad = doc.commands
            .filter((row) => {
                const spec = COMMANDS.find((c) => c.name === row.name);
                return !spec || JSON.stringify(spec.aliases) !== JSON.stringify(row.aliases);
            })
            .map((r) => r.name);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert("the doc's own canonical pattern matches the code's", () =>
        doc.grammar.canonical_name_rule.pattern === CANONICAL_NAME_PATTERN.source);

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · ⭐ One word — no hyphen, no underscore, anywhere in the vocabulary');

    /**
     * ⛔ The rule the owner set on 2026-09-09, and the reason it is asserted rather than
     * merely followed: a hyphenated command is not a cosmetic problem. Telegram's
     * `bot_command` entity stops at the hyphen, so `/reset-password` is parsed as `/reset`
     * followed by the text `-password`, and it **cannot be registered with BotFather at
     * all** — it never autocompletes and never appears in the command menu. A future
     * contributor adding `/my-orders` back would reintroduce a command that silently means
     * something else on the one channel that has a command menu.
     */
    assert('⛔ every canonical name is one lowercase word', () => {
        const bad = CANONICAL_COMMAND_NAMES.filter((n) => !CANONICAL_NAME_PATTERN.test(n));
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('⛔ no ALIAS contains a hyphen or an underscore either', () => {
        const bad: string[] = [];
        for (const command of COMMANDS) {
            for (const alias of command.aliases) {
                if (/[-_]/.test(alias)) bad.push(`/${command.name} → ${alias}`);
            }
        }
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('⛔ the same is true of the DOC, not only the code', () => {
        const bad: string[] = [];
        for (const row of doc.commands) {
            for (const word of [row.name, ...row.aliases]) {
                if (/[-_]/.test(word)) bad.push(`${row.name} → ${word}`);
            }
        }
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('the two renamed commands are /password and /add', () =>
        CANONICAL_COMMAND_NAMES.includes('password')
        && CANONICAL_COMMAND_NAMES.includes('add')
        && !CANONICAL_COMMAND_NAMES.includes('reset_password')
        && !CANONICAL_COMMAND_NAMES.includes('add_to_cart'));

    /**
     * ⚠ The rename is the CHAT vocabulary and nothing else. `POST /api/auth/reset-password`
     * is an HTTP endpoint a browser calls, and most repo hits for that string are it. A
     * rename that followed the command into the URL would break every emailed reset link
     * in flight.
     */
    assert('⚠ the HTTP reset-password route is UNTOUCHED by the rename', () => {
        const routes = read('modules/auth/auth.routes.ts');
        return routes.includes('reset-password');
    });

    assert('the internal bus name stays `reset_password` — nobody types it', () =>
        read('modules/messaging-login/commands/reset-password.command.ts')
            .includes("command_name = 'reset_password'"));

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The registry guards — what refuses the boot');

    assert('the registry validates as declared', () => {
        assertCommandRegistryValid();
        return true;
    });

    assert('a word claimed by two commands is refused', () => {
        try {
            assertCommandRegistryValid([
                { name: 'alpha', aliases: ['x'], args: [], requiresIdentity: false, requiresCustomerRole: false, handler: null },
                { name: 'beta', aliases: ['x'], args: [], requiresIdentity: false, requiresCustomerRole: false, handler: null },
            ]);
            return false;
        } catch {
            return true;
        }
    });

    assert('a hyphenated canonical name is refused', () => {
        try {
            assertCommandRegistryValid([
                { name: 'reset-password', aliases: [], args: [], requiresIdentity: false, requiresCustomerRole: false, handler: null },
            ]);
            return false;
        } catch {
            return true;
        }
    });

    /**
     * ⚠ A free-text argument that is not last silently swallows every argument after it —
     * `/cancel <reason> <ref>` would put the whole tail in `reason` and leave `ref` empty,
     * which reads as "the customer did not name an order" rather than as a bug.
     */
    assert('⚠ a free-text argument that is not LAST is refused', () => {
        try {
            assertCommandRegistryValid([
                {
                    name: 'alpha',
                    aliases: [],
                    args: [
                        { name: 'a', type: 'free_text', required: false },
                        { name: 'b', type: 'identifier', required: false },
                    ],
                    requiresIdentity: false,
                    requiresCustomerRole: false,
                    handler: null,
                },
            ]);
            return false;
        } catch {
            return true;
        }
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The grammar');

    const parse = (text: string) => parseCommand(text, COMMANDS);

    assert('a message not starting with / is NEVER a command', () =>
        parse('where is my order').kind === 'not_a_command'
        && parse('  hello  ').kind === 'not_a_command');

    assert('a lone / is not a command either', () => parse('/').kind === 'not_a_command');

    assert('the command name is case-insensitive', () => {
        const a = parse('/HELP');
        return a.kind === 'matched' && a.name === 'help';
    });

    assert('the command name is diacritic-insensitive', () => {
        const a = parse('/catégorie');
        return a.kind === 'matched' && a.name === 'category';
    });

    /**
     * ⚠ The other half of that rule, and the one that would be easy to get wrong: folding
     * the whole message would change what the customer asked for. `/search café` must
     * search for `café`.
     */
    assert('⚠ ARGUMENTS keep their accents', () => {
        const a = parse('/search café crème');
        return a.kind === 'matched' && a.args.query === 'café crème';
    });

    assert('a trailing @botname is stripped (Telegram group chats)', () => {
        const a = parse('/help@wi_mall_bot');
        return a.kind === 'matched' && a.name === 'help';
    });

    assert('the colon form binds the FIRST argument only', () => {
        const a = parse('/support:vendor');
        return a.kind === 'matched' && a.name === 'support' && a.args.scope === 'vendor';
    });

    assert('a trailing colon with no argument is the bare command', () => {
        const a = parse('/profile:');
        return a.kind === 'matched' && a.name === 'profile' && Object.keys(a.args).length === 0;
    });

    assert('free-text arguments are JOINED', () => {
        const a = parse('/search red summer dress');
        return a.kind === 'matched' && a.args.query === 'red summer dress';
    });

    assert('identifier arguments are SPLIT', () => {
        const a = parse('/cart qty ABC123 3');
        return a.kind === 'matched'
            && a.args.action === 'qty'
            && a.args.ref === 'ABC123'
            && a.args.quantity === '3';
    });

    assert('a quoted argument holds together', () =>
        JSON.stringify(tokenizeArguments('"red dress" small')) === JSON.stringify(['red dress', 'small']));

    assert('an unterminated quote runs to the end rather than failing', () =>
        JSON.stringify(tokenizeArguments('"red dress')) === JSON.stringify(['red dress']));

    assert('multilingual aliases resolve', () =>
        (parse('/chercher robe') as { name?: string }).name === 'search'
        && (parse('/annuler') as { name?: string }).name === 'cancel'
        && (parse('/panier') as { name?: string }).name === 'cart');

    assert('foldCommandName leaves ASCII lowercase alone', () =>
        foldCommandName('password') === 'password');

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · ⛔ An unknown command NEVER reaches the model');

    /**
     * ⛔ The rule `commands.json` states in one line, and the whole reason the parser is
     * deterministic: *"a typo'd /cancel must not become a cancellation."* A model reading
     * `/cancle ORD-2026-000123` charitably is behaving correctly and doing the wrong thing.
     */
    assert('⛔ an unrecognised /word is `unknown`, never `not_a_command`', () => {
        const a = parse('/frobnicate');
        return a.kind === 'unknown' && a.typed === 'frobnicate';
    });

    assert('⛔ a removed hyphenated form is UNKNOWN, not silently accepted', () =>
        parse('/reset-password').kind === 'unknown'
        && parse('/add-to-cart').kind === 'unknown'
        && parse('/my-orders').kind === 'unknown');

    assert('a one-edit typo suggests the canonical name', () =>
        suggestCommand('passwrd', CANONICAL_COMMAND_NAMES) === 'password');

    /**
     * ⚠ Damerau rather than plain Levenshtein: a transposition is ONE edit here and TWO
     * under Levenshtein, and swapped adjacent letters are the commonest phone typo. Under
     * the plain metric `/cnacel` sits at the threshold beside unrelated words.
     */
    assert('⚠ a TRANSPOSITION is one edit (Damerau, not Levenshtein)', () =>
        editDistance('cnacel', 'cancel') === 1 && suggestCommand('cnacel', CANONICAL_COMMAND_NAMES) === 'cancel');

    assert('nothing within two edits yields no suggestion', () =>
        suggestCommand('zzzzzzzz', CANONICAL_COMMAND_NAMES) === null);

    /**
     * ⚠ A tie yields NOTHING. The spec fixes a threshold and never states a tie-break, so
     * inventing one (alphabetical, declaration order) would make the suggestion depend on
     * something the customer cannot see and nobody chose.
     */
    assert('⚠ two equally-close candidates yield NO suggestion', () =>
        suggestCommand('bost', ['best', 'bost1', 'cost']) === null
        || suggestCommand('xay', ['pay', 'say']) === null);

    assert('suggestions are drawn from CANONICAL names only, never aliases', () => {
        const source = fs.readFileSync(
            path.join(SRC, 'modules/bot-commands/services/command-router.service.ts'),
            'utf8',
        );
        return source.includes('CANONICAL_COMMAND_NAMES') && !/suggestCommand\([^)]*alias/i.test(source);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · What is live, and what still reaches the model');

    assert('the five live commands are start, help, login, password, connect', () => {
        const live = LIVE_COMMANDS.map((c) => c.name).sort();
        return JSON.stringify(live) === JSON.stringify(['connect', 'help', 'login', 'password', 'start']);
    });

    /**
     * ⚠ A DECLARED command with no handler falls through to the model, and that is NOT the
     * same case as an unknown one. `/cart` names something real this phase has not built,
     * and the model already handles it today — answering "coming soon" would be a
     * regression on behaviour customers already have.
     */
    assert('⚠ a declared-but-unimplemented command still parses (it reaches the model)', () => {
        const a = parse('/cart');
        return a.kind === 'matched' && a.name === 'cart';
    });

    assert('every live command has a menu description in all five languages', () => {
        assertCommandCopyComplete();
        return true;
    });

    assert('a command with no handler has NO menu description', () =>
        LIVE_COMMANDS.length === COMMANDS.filter((c) => commandDescription(c.name, 'en') !== null).length);

    assert('the help text names every live command and nothing else', () => {
        const help = commandSentence('helpIntro', 'en');
        return help.length > 0 && LIVE_COMMANDS.every((c) => CANONICAL_NAME_PATTERN.test(c.name));
    });

    /**
     * ⚠ `/help` is built FROM the registry, never from a hand-kept list. A help text
     * maintained by hand is wrong the first time somebody adds a command and forgets it,
     * and a customer reading a stale list concludes the missing one does not exist.
     */
    assert('⚠ /help is rendered from the registry, not a literal list', () => {
        const source = fs.readFileSync(
            path.join(SRC, 'modules/bot-commands/services/command-router.service.ts'),
            'utf8',
        );
        return source.includes('LIVE_COMMANDS.map');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · Source scans — what nothing behavioural can see');

    /**
     * ⚠ The whole reason the parser is here rather than in n8n. If the automation layer
     * ever regains a command list, the five-language alias table lives in the one layer
     * with no copy table — which is the argument `bot-surface.md` § 14.6 already makes
     * about parsing a typed answer.
     */
    assert('⚠ the route takes RAW TEXT and no parsed command name', () => {
        const validators = read('modules/bot-surface/validators/bot.validators.ts');
        const schema = validators.slice(validators.indexOf('BotCommandDispatchSchema'));
        const body = schema.slice(0, schema.indexOf('.strict()'));
        return body.includes('text:') && !body.includes('command:') && !body.includes('args');
    });

    assert('the parser is pure — it imports nothing', () => {
        const parser = read('modules/bot-commands/domain/command-parser.ts');
        return !/^\s*import\s/m.test(parser);
    });

    assert('the registry imports only the parser (no I/O, no models)', () => {
        const registry = read('modules/bot-commands/domain/command-registry.ts');
        const imports = registry.match(/^import .*$/gm) ?? [];
        return imports.every((line) => line.includes('./command-parser'));
    });

    /**
     * ⚠ `commands.json` must NOT be imported at runtime. `tsc` emits no JSON from outside
     * `rootDir`, so `dist/` would not carry it and `npm run dev` and `npm start` would
     * silently disagree — the exact failure that left every Handlebars mail template
     * missing from every compiled image.
     */
    assert('⛔ nothing in src/ imports commands.json at runtime', () => {
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts')) {
                    /**
                     * An IMPORT of the file, not a mention of it. Several of these modules
                     * name `commands.json` in a docstring precisely to say it is the doc
                     * mirror and must not be imported — a scan that matched the prose would
                     * fail on the comment explaining the rule.
                     */
                    const body = fs.readFileSync(full, 'utf8');
                    if (/(?:from\s+|require\()\s*['"][^'"]*commands\.json['"]/.test(body)) {
                        hits.push(path.relative(SRC, full));
                    }
                }
            }
        };
        walk(SRC);
        if (hits.length) console.error('     ↳', hits.join(', '));
        return hits.length === 0;
    });

    assert('the command bus singleton is a leaf both sides can import', () => {
        const instance = read('modules/command-bus/instance.ts');
        const api = fs.readFileSync(path.join(SRC, 'api/index.ts'), 'utf8');
        return instance.includes('new CommandBus()')
            && instance.includes('register_all_commands')
            && api.includes("from '../modules/command-bus/instance'")
            && !api.includes('new CommandBus()');
    });

    // ═════════════════════════════════════════════════════════════════════════
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(72)}\n`);

    if (failed > 0) process.exit(1);
}

main();
