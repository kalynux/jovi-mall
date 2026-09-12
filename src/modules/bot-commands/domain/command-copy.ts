import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from '../../bot-surface/domain/bot-error-copy';
import { COMMANDS, CommandSpec } from './command-registry';

/**
 * What each command is CALLED, in the customer's language.
 *
 * ── A FOURTH COPY TABLE, AND THE REASON IT IS NOT A GROWTH OF THE OTHER THREE ─
 * `bot-error-copy.ts` words a failure, `bot-onboarding-copy.ts` words a question, and
 * `bot-chrome-copy.ts` words a control. What is here is a **menu entry**: it is rendered by
 * Telegram itself, in a list the customer opens by typing `/`, and it is the one string in
 * this codebase that leaves the platform entirely — `setMyCommands` uploads it to Telegram,
 * which then serves it without asking again.
 *
 * That is why it cannot live in `bot-chrome-copy.ts`: a chrome string is chosen per request
 * from `req.bot.language`, and this one is chosen per *upload*, once, per language Telegram
 * knows about. The two have different lifetimes and different caps.
 *
 * ⚠ **The description is what makes a short name safe.** `/password` reads as "show me my
 * password" until Telegram prints *"Get a link to set a new password"* beside it, which it
 * does everywhere the command appears. That pairing is why the owner's one-word decision
 * costs no clarity — and it means a command added without a description here is a command
 * whose name is the only thing explaining it.
 */

type Copy = Record<BotCopyLanguage, string>;

/**
 * Telegram's own limits on `setMyCommands`: a command is 1–32 characters of `[a-z0-9_]`
 * (already enforced by `CANONICAL_NAME_PATTERN`) and a description is **1–256**. An
 * over-long description is refused by the Bot API for the whole batch, so one bad string
 * means no menu at all rather than one missing row — which is exactly the silent-failure
 * shape `assertBotChromeCopyFits` exists for.
 */
const DESCRIPTION_CAP = 256;

const START: Copy = {
    en: 'Start here',
    fr: 'Commencer ici',
    pt: 'Começar aqui',
    es: 'Empezar aquí',
    ar: 'ابدأ من هنا',
};

const HELP: Copy = {
    en: 'What I can do',
    fr: 'Ce que je peux faire',
    pt: 'O que posso fazer',
    es: 'Lo que puedo hacer',
    ar: 'ما يمكنني فعله',
};

const LOGIN: Copy = {
    en: 'Sign in on the website, no password',
    fr: 'Se connecter au site, sans mot de passe',
    pt: 'Entrar no site, sem palavra-passe',
    es: 'Entrar en el sitio, sin contraseña',
    ar: 'تسجيل الدخول إلى الموقع بدون كلمة مرور',
};

/**
 * ⚠ Names the OUTCOME, not the noun. *"Password"* alone reads as an offer to show one —
 * which is the objection to the short name, answered here rather than in the name.
 */
const PASSWORD: Copy = {
    en: 'Get a link to set a new password',
    fr: 'Recevoir un lien pour choisir un nouveau mot de passe',
    pt: 'Receber um link para definir uma nova palavra-passe',
    es: 'Recibir un enlace para elegir una nueva contraseña',
    ar: 'احصل على رابط لتعيين كلمة مرور جديدة',
};

const CONNECT: Copy = {
    en: 'Link this chat to your account',
    fr: 'Relier cette discussion à votre compte',
    pt: 'Ligar esta conversa à sua conta',
    es: 'Vincular este chat con tu cuenta',
    ar: 'اربط هذه المحادثة بحسابك',
};

/** The sentence above the list in `/help`. */
const HELP_INTRO: Copy = {
    en: 'Here is what you can type:',
    fr: 'Voici ce que vous pouvez taper :',
    pt: 'Eis o que pode escrever:',
    es: 'Esto es lo que puedes escribir:',
    ar: 'إليك ما يمكنك كتابته:',
};

/**
 * The sentence under it. ⚠ It says that ordinary words work too, because the whole point of
 * the command layer is that it is a **shortcut past the model, not a replacement for it** —
 * a customer who reads a command list and concludes those are the only things the bot
 * understands has been made worse off by the list.
 */
const HELP_OUTRO: Copy = {
    en: 'You can also just tell me what you need, in your own words.',
    fr: 'Vous pouvez aussi simplement me dire ce dont vous avez besoin, avec vos mots.',
    pt: 'Também pode simplesmente dizer-me o que precisa, por palavras suas.',
    es: 'También puedes decirme lo que necesitas, con tus propias palabras.',
    ar: 'يمكنك أيضًا أن تخبرني بما تحتاجه بكلماتك الخاصة.',
};

/** `/xyz` matched nothing and one canonical name is within two edits. */
const DID_YOU_MEAN: Copy = {
    en: 'I do not know that command. Did you mean {{suggestion}}?',
    fr: 'Je ne connais pas cette commande. Vouliez-vous dire {{suggestion}} ?',
    pt: 'Não conheço esse comando. Queria dizer {{suggestion}}?',
    es: 'No conozco ese comando. ¿Querías decir {{suggestion}}?',
    ar: 'لا أعرف هذا الأمر. هل تقصد {{suggestion}}؟',
};

/** `/xyz` matched nothing and nothing is close enough. */
const UNKNOWN_COMMAND: Copy = {
    en: 'I do not know that command. Send /help to see what I can do.',
    fr: 'Je ne connais pas cette commande. Envoyez /help pour voir ce que je peux faire.',
    pt: 'Não conheço esse comando. Envie /help para ver o que posso fazer.',
    es: 'No conozco ese comando. Envía /help para ver lo que puedo hacer.',
    ar: 'لا أعرف هذا الأمر. أرسل /help لمعرفة ما يمكنني فعله.',
};

/** `/start`, for somebody the platform has just met. */
const WELCOME: Copy = {
    en: 'Welcome to wi-mall. Tell me what you are looking for, or send /help to see what I can do.',
    fr: 'Bienvenue sur wi-mall. Dites-moi ce que vous cherchez, ou envoyez /help pour voir ce que je peux faire.',
    pt: 'Bem-vindo à wi-mall. Diga-me o que procura, ou envie /help para ver o que posso fazer.',
    es: 'Bienvenido a wi-mall. Dime qué buscas, o envía /help para ver lo que puedo hacer.',
    ar: 'مرحبًا بك في wi-mall. أخبرني بما تبحث عنه، أو أرسل /help لمعرفة ما يمكنني فعله.',
};

/** Command name → its menu description. Only live commands appear. */
const DESCRIPTIONS: Readonly<Record<string, Copy>> = Object.freeze({
    start: START,
    help: HELP,
    login: LOGIN,
    password: PASSWORD,
    connect: CONNECT,
});

const SENTENCES = Object.freeze({
    helpIntro: HELP_INTRO,
    helpOutro: HELP_OUTRO,
    didYouMean: DID_YOU_MEAN,
    unknownCommand: UNKNOWN_COMMAND,
    welcome: WELCOME,
});

export type CommandSentenceKey = keyof typeof SENTENCES;

/** One of this module's sentences, in the customer's language. Never falls back to the key. */
export function commandSentence(key: CommandSentenceKey, language: string | null | undefined): string {
    const copy = SENTENCES[key];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/** A command's menu description. `null` for a command this phase has not implemented. */
export function commandDescription(name: string, language: string | null | undefined): string | null {
    const copy = DESCRIPTIONS[name];
    if (!copy) return null;
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * Refuse the boot on a description that is missing, blank, or longer than Telegram accepts.
 *
 * The length half is the valuable one and it is the same argument `assertBotChromeCopyFits`
 * makes: an over-long description does not truncate, it makes `setMyCommands` reject the
 * **entire batch**, so the customer sees the old menu — or none — with no error anywhere on
 * this side. That is only ever reported as *"the commands did not update"*.
 */
export function assertCommandCopyComplete(commands: readonly CommandSpec[] = COMMANDS): void {
    const problems: string[] = [];

    for (const command of commands) {
        const copy = DESCRIPTIONS[command.name];

        if (command.handler === null) {
            if (copy) problems.push(`/${command.name} has a menu description but no handler`);
            continue;
        }

        if (!copy) {
            problems.push(`/${command.name} is live and has no menu description`);
            continue;
        }

        for (const language of BOT_COPY_LANGUAGES) {
            const value = copy[language];
            if (!value || !value.trim()) {
                problems.push(`/${command.name} has no ${language} description`);
            } else if (value.length > DESCRIPTION_CAP) {
                problems.push(
                    `/${command.name} ${language} description is ${value.length} chars, cap ${DESCRIPTION_CAP}`,
                );
            }
        }
    }

    for (const [key, copy] of Object.entries(SENTENCES)) {
        for (const language of BOT_COPY_LANGUAGES) {
            const value = (copy as Copy)[language];
            if (!value || !value.trim()) problems.push(`sentence "${key}" has no ${language}`);
        }
    }

    if (problems.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- module load, no request in flight
        throw new Error(`[BotCommands] incomplete command copy:\n  ${problems.join('\n  ')}`);
    }
}

export const __DESCRIPTION_CAP = DESCRIPTION_CAP;
