/**
 * Test: what the bot says BEFORE it knows the customer's language is in English AND French
 * (owner, 2026-10-26). The phone number is asked before the language, so a French speaker whose
 * phone is set to English was greeted in English only.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework). DB-free.
 *
 * Run: npm run test:bilingual-first-contact
 */
import { BILINGUAL_SEPARATOR, bilingualLabel } from '../../src/modules/bot-surface/domain/bilingual-copy';
import { customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { onboardingPromptFor } from '../../src/modules/bot-surface/domain/bot-onboarding-copy';
import { onboardingReplyIntent } from '../../src/modules/bot-surface/domain/onboarding-reply';
import { renderBotReply } from '../../src/modules/bot-surface/domain/channel-reply';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ERROR_CATEGORIES } from '../../src/core/error-category';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (error) {
        console.error(`  ❌ THROW: ${name} — ${(error as Error).message}`);
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

/** English first, the separator on its own line, then French — and nothing else. */
const isBilingual = (text: string): boolean => {
    const parts = text.split(`\n${BILINGUAL_SEPARATOR}\n`);
    return parts.length === 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0 && parts[0] !== parts[1];
};

function main(): void {
    console.log('\n═══ test:bilingual-first-contact ═══════════════════════════════════════════');

    const needsContact = (lang: string) =>
        customerMessageFor(ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT, ERROR_CATEGORIES.AUTHENTICATION, lang);

    assert('share-your-number refusal: English, a separator line, then French', () => isBilingual(needsContact('en')));
    assert('…the SAME text whatever language was guessed (en, fr, pt, ar)', () =>
        ['fr', 'pt', 'ar', 'xx'].every((l) => needsContact(l) === needsContact('en')));
    assert('…English first: "I need your phone number first", then "J\'ai d\'abord besoin"', () =>
        needsContact('fr').startsWith('I need your phone number first') && needsContact('fr').includes("J'ai d'abord besoin"));
    assert('"that contact is not yours" is bilingual too (same pre-account step)', () =>
        isBilingual(customerMessageFor(ERROR_CODES.MAGIC_CONTACT_UNVERIFIED, ERROR_CATEGORIES.VALIDATION, 'fr')));
    assert('an ordinary refusal is still ONE language (only the pre-language step changed)', () =>
        !customerMessageFor(ERROR_CODES.BOT_REGISTRATION_IDENTITY_TAKEN, ERROR_CATEGORIES.CONFLICT, 'fr').includes(BILINGUAL_SEPARATOR));

    assert('onboarding phone step (Telegram): bilingual, with the share-contact control', () => {
        const p = onboardingPromptFor('phone', 'telegram', 'pt');
        return isBilingual(p.prompt) && p.requestContact === true;
    });
    assert('onboarding phone step (typed): bilingual', () => isBilingual(onboardingPromptFor('phone', 'whatsapp', 'es').prompt));
    assert('the NAME step after it stays in the chosen language only', () =>
        !onboardingPromptFor('name', 'telegram', 'fr').prompt.includes(BILINGUAL_SEPARATOR));

    assert('share button: "📱 Share my number / Partager mon numéro" (the 📱 written once)', () =>
        bilingualLabel('📱 Share my number', '📱 Partager mon numéro') === '📱 Share my number / Partager mon numéro');
    assert('a label with no shared symbol keeps both whole', () => bilingualLabel('Yes', 'Oui') === 'Yes / Oui');

    const intent = onboardingReplyIntent(
        { step: 'phone', field: 'phone', kind: 'contact', skippable: false, ...onboardingPromptFor('phone', 'telegram', 'en') } as never,
        'fr',
    );
    const rendered = intent ? renderBotReply(intent, 'telegram', '12345') : null;
    assert('rendered on Telegram: the bilingual text and the bilingual button', () => {
        const body = rendered?.body as { text?: string; reply_markup?: { keyboard?: Array<Array<{ text: string }>> } } | undefined;
        const button = body?.reply_markup?.keyboard?.[0]?.[0]?.text ?? '';
        return isBilingual(body?.text ?? '') && button.includes('Share my number') && button.includes('Partager mon numéro');
    });

    console.log('\n── What a new Telegram customer sees first ──\n');
    console.log(needsContact('en'));
    console.log(`[ ${bilingualLabel('📱 Share my number', '📱 Partager mon numéro')} ]`);
    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
