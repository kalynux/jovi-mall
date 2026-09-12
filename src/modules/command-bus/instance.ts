import { CommandBus } from './command-bus';
import { register_all_commands } from '../commands';

/**
 * The one command bus, and the four handlers registered on it.
 *
 * ── WHY THIS MOVED OUT OF `api/index.ts` ────────────────────────────────────
 * It was constructed there and handed to the two webhook routers as a parameter, which was
 * fine while the webhooks were its only callers. The typed-command router is a third, and it
 * is mounted on the bot surface — so importing the bus from `api/index.ts` would mean
 * `api/index` → `bot.routes` → `bot-commands` → `api/index`, a require cycle whose symptom in
 * this codebase is a constructor that is `undefined` at boot ("AuthService is not a
 * constructor", `modules/agents/index.ts`).
 *
 * A leaf module both sides can import closes it by construction rather than by import order.
 * `api/index.ts` re-exports `commandBus` so nothing that referenced it there had to change.
 *
 * ⚠ **Registration happens once, at import.** `CommandBus.register` throws
 * `COMMAND_ALREADY_REGISTERED` on a second call for the same name, so this module must never
 * be constructed twice — which is exactly what a module-level singleton guarantees and what
 * a `new CommandBus()` at two call sites would not.
 */
export const commandBus = new CommandBus();
register_all_commands(commandBus);
