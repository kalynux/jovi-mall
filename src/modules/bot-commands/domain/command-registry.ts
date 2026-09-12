import { CommandArgSpec, CommandGrammarSpec, foldCommandName } from './command-parser';

/**
 * Every customer command, canonical name and aliases alike.
 *
 * ── THIS FILE IS THE SOURCE OF TRUTH; `commands.json` IS ITS MIRROR ─────────
 * The doc lives at `api-doc/n8n/tools/commands.json` and `test:bot-commands` asserts the two
 * agree row for row, which is the same relationship `BOT_ROUTES` already has with
 * `catalog.json`. It is deliberately NOT imported at runtime: `tsc` emits no JSON from
 * outside `rootDir`, so a `dist/` build would not carry it and `npm run dev` and `npm start`
 * would silently disagree — the exact failure that left every Handlebars mail template
 * missing from every compiled image (see `scripts/copy-build-assets.ts`).
 *
 * ── ⭐ ONE WORD, NO HYPHEN, NO UNDERSCORE ───────────────────────────────────
 * Canonical names match `^[a-z][a-z0-9]{0,31}$`. Telegram's `bot_command` entity accepts
 * only letters, digits and underscore, so `/reset-password` is read as `/reset` followed by
 * the text `-password` **and cannot be registered with BotFather at all** — it never
 * autocompletes and never appears in the command menu. Underscores would be legal and are
 * excluded anyway: the owner's decision (2026-09-08) is that a command is one word.
 *
 * Two canonical names changed with that decision and nothing else did:
 *
 *   `reset_password` → **`password`**      `add_to_cart` → **`add`**
 *
 * ⚠ **The hyphenated forms are GONE, not hidden.** They are not kept as unadvertised
 * aliases. That is safe precisely because no typed command has ever worked: the
 * `detect command` branch in `wi-mall-core` was staged and never published, so
 * `/reset-password` reached the model like any other sentence. Nobody has a working command
 * to lose. ⛔ **`POST /api/auth/reset-password` is a URL and is untouched** — most repo hits
 * for that string are the HTTP endpoint, which no rename here may follow.
 *
 * ⚠ **Internal names are NOT the typed names and must not be renamed to match.**
 * `command_name = 'reset_password'` on the bus, and the tool `auth_send_login_link`, are
 * never typed by anybody. Renaming them would touch registration, the catalogue and three
 * test suites to change a string no customer sees.
 */

/** What the router does with a matched command. `null` means the phase has not landed. */
export type CommandHandlerKey =
    | 'help'
    | 'start'
    /**
     * `bus:*` dispatches to the pre-existing `CommandBus` — the four handlers that have been
     * live since 2026-08-16 and that nothing typed could reach. The router builds the same
     * context `telegram.controller.ts` builds, so the handler cannot tell which door it came
     * through.
     */
    | 'bus:login'
    | 'bus:reset_password'
    | 'bus:connect';

export interface CommandSpec extends CommandGrammarSpec {
    name: string;
    aliases: readonly string[];
    args: readonly CommandArgSpec[];
    /** Contract metadata, pinned to `commands.json`. */
    requiresIdentity: boolean;
    requiresCustomerRole: boolean;
    /**
     * `null` until the phase that implements it lands.
     *
     * ⚠ **A declared-but-unimplemented command falls through to the model**, exactly as it
     * does today, and is deliberately NOT the same case as an unknown one. The spec's
     * *"a typo'd /cancel must not become a cancellation"* is about a word that names
     * nothing; `/cart` names something real that this phase has not built, and answering
     * "coming soon" would be a regression on behaviour customers already have.
     */
    handler: CommandHandlerKey | null;
}

const IDENT = (name: string, required = false): CommandArgSpec => ({ name, type: 'identifier', required });
const TEXT = (name: string, required = false): CommandArgSpec => ({ name, type: 'free_text', required });
const ENUM = (name: string, values?: readonly string[]): CommandArgSpec =>
    ({ name, type: 'enum', required: false, ...(values ? { values } : {}) });

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
    // ── Onboarding and help ──────────────────────────────────────────────────
    { name: 'start', aliases: [], args: [], requiresIdentity: false, requiresCustomerRole: false, handler: 'start' },
    {
        name: 'help',
        aliases: ['aide', 'menu', 'ayuda', 'ajuda', 'commands', '?'],
        args: [TEXT('topic')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: 'help',
    },

    // ── Account access — live on the bus since 2026-08-16 ────────────────────
    {
        name: 'login',
        aliases: ['signin', 'connexion'],
        args: [],
        requiresIdentity: false,
        requiresCustomerRole: true,
        handler: 'bus:login',
    },
    {
        // ⭐ Renamed from `reset_password`. `/reset-password` is gone entirely.
        name: 'password',
        aliases: ['resetpassword', 'motdepasse', 'forgot'],
        args: [],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: 'bus:reset_password',
    },
    {
        name: 'connect',
        aliases: ['link'],
        args: [],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: 'bus:connect',
    },

    // ── Catalogue (phase 2) ─────────────────────────────────────────────────
    {
        name: 'search',
        aliases: ['find', 'chercher', 'rechercher', 'buscar', 'procurar'],
        args: [TEXT('query', true)],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },
    { name: 'categories', aliases: ['cats'], args: [], requiresIdentity: false, requiresCustomerRole: false, handler: null },
    {
        name: 'category',
        aliases: ['categorie', 'categoria'],
        args: [TEXT('name')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },
    {
        name: 'product',
        aliases: ['p', 'item', 'produit', 'produto', 'producto'],
        args: [IDENT('ref')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },
    {
        name: 'store',
        aliases: ['shop', 'boutique', 'seller', 'vendeur'],
        args: [TEXT('slug')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },
    {
        name: 'similar',
        aliases: ['related', 'similaire'],
        args: [IDENT('ref')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },
    {
        name: 'reviews',
        aliases: ['avis', 'ratings', 'opinions'],
        args: [IDENT('ref')],
        requiresIdentity: false,
        requiresCustomerRole: false,
        handler: null,
    },

    // ── Basket and buying (phases 3–4) ──────────────────────────────────────
    {
        name: 'cart',
        aliases: ['panier', 'viewcart', 'basket', 'carrito', 'carrinho'],
        args: [ENUM('action', ['add', 'remove', 'qty', 'clear']), IDENT('ref'), { name: 'quantity', type: 'quantity', required: false }],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        // ⭐ Renamed from `add_to_cart`. `/add-to-cart` is gone entirely.
        name: 'add',
        aliases: ['addtocart', 'ajouter'],
        args: [IDENT('ref'), { name: 'quantity', type: 'quantity', required: false }],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    { name: 'checkout', aliases: ['commander'], args: [], requiresIdentity: true, requiresCustomerRole: true, handler: null },
    {
        name: 'buy',
        aliases: ['buynow', 'acheter', 'comprar'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'pay',
        aliases: ['payer', 'payment', 'paiement', 'pagar'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },

    // ── Orders and delivery (phase 3) ───────────────────────────────────────
    {
        name: 'orders',
        aliases: ['commandes', 'myorders', 'pedidos'],
        args: [ENUM('status')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    { name: 'order', aliases: ['commande'], args: [IDENT('ref')], requiresIdentity: true, requiresCustomerRole: true, handler: null },
    {
        name: 'track',
        aliases: ['tracking', 'suivi', 'suivre', 'rastrear', 'seguimiento'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'code',
        aliases: ['cod', 'deliverycode'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        /**
         * ⚠ `ref` is declared OPTIONAL here while `commands.json` says `required: true` and
         * also gives it an `on_missing`. Those two cannot both hold. The behaviour both
         * documents actually describe is `explicit_only`: the guard ASKS when it is absent
         * and never resolves one from context (ARCHITECTURE § "the guard asks; it does not
         * resolve"). The doc row is corrected to match in the same change.
         */
        name: 'confirm',
        aliases: ['received', 'recu'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        /** Same `required`/`on_missing` contradiction as `/confirm`; same resolution. */
        name: 'cancel',
        aliases: ['annuler', 'cancelar'],
        args: [IDENT('ref'), TEXT('reason')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'review',
        aliases: ['rate', 'noter'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },

    // ── Account (phase 3) ───────────────────────────────────────────────────
    {
        name: 'address',
        aliases: ['adresse', 'addresses', 'direccion', 'endereco'],
        args: [ENUM('action', ['add', 'default'])],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'language',
        aliases: ['langue', 'lang', 'idioma', 'lingua'],
        args: [IDENT('code')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'profile',
        aliases: ['profil', 'account', 'compte', 'me', 'cuenta'],
        args: [],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'notifications',
        aliases: ['notif', 'alerts', 'alertes'],
        args: [],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'stop',
        aliases: ['unsubscribe', 'desabonner', 'arret'],
        args: [],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },

    // ── Support (phase 3) ───────────────────────────────────────────────────
    {
        name: 'support',
        aliases: ['contact', 'assistance'],
        args: [ENUM('scope', ['vendor', 'agency', 'platform'])],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'ticket',
        aliases: ['tickets', 'billet'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },

    // ── Saved, files and appointments (phase 3) ─────────────────────────────
    {
        name: 'saved',
        aliases: ['wishlist', 'favorites', 'favoris', 'favoritos', 'liste'],
        args: [ENUM('action', ['add', 'remove']), IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'downloads',
        aliases: ['telechargements', 'files', 'fichiers'],
        args: [],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
    {
        name: 'bookings',
        aliases: ['booking', 'rendezvous', 'rdv', 'appointments', 'reservations', 'citas'],
        args: [IDENT('ref')],
        requiresIdentity: true,
        requiresCustomerRole: true,
        handler: null,
    },
]);

/** Canonical names only — the candidate set for a typo suggestion. See `command-suggest.ts`. */
export const CANONICAL_COMMAND_NAMES: readonly string[] = Object.freeze(COMMANDS.map((c) => c.name));

/** The commands a phase has actually implemented. `/help` lists these and nothing else. */
export const LIVE_COMMANDS: readonly CommandSpec[] = Object.freeze(
    COMMANDS.filter((command) => command.handler !== null),
);

export const CANONICAL_NAME_PATTERN = /^[a-z][a-z0-9]{0,31}$/;

/**
 * Refuse the boot on a vocabulary that cannot work, the way `bot-route-table.ts` refuses a
 * shadowed route. Every one of these is silent at runtime rather than loud:
 *
 *   - a name Telegram cannot register never autocompletes, and a hyphenated one is parsed as
 *     a different command;
 *   - a word claimed twice makes `parseCommand`'s `find` return whichever row is declared
 *     first, so one command becomes unreachable with no error anywhere;
 *   - a `free_text` argument that is not last silently swallows every argument after it.
 */
export function assertCommandRegistryValid(commands: readonly CommandSpec[] = COMMANDS): void {
    const problems: string[] = [];
    const claimed = new Map<string, string>();

    for (const command of commands) {
        if (!CANONICAL_NAME_PATTERN.test(command.name)) {
            problems.push(`canonical name "${command.name}" is not one lowercase word`);
        }

        for (const word of [command.name, ...command.aliases]) {
            const folded = foldCommandName(word);
            const owner = claimed.get(folded);
            if (owner && owner !== command.name) {
                problems.push(`"${word}" is claimed by both /${owner} and /${command.name}`);
            } else if (owner === command.name) {
                problems.push(`"${word}" is listed twice on /${command.name}`);
            }
            claimed.set(folded, command.name);
        }

        command.args.forEach((arg, index) => {
            if (arg.type === 'free_text' && index !== command.args.length - 1) {
                problems.push(`/${command.name}: free-text argument "${arg.name}" is not last`);
            }
        });
    }

    if (problems.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- module load, no request in flight
        throw new Error(`[BotCommands] invalid command registry:\n  ${problems.join('\n  ')}`);
    }
}

assertCommandRegistryValid();
