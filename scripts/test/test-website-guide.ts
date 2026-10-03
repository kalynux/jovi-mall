/**
 * test:website-guide — the website guide the customer assistant reads (2026-10-03).
 *
 * Offline. Pins what a model relies on: every topic answers in both chat languages, links carry
 * the customer's locale, sign-in pages say so, an unknown topic answers the list instead of an
 * error, and the keys survive the n8n tool's sanitiser (`[a-z]` only, max 20).
 *
 * The PATHS are checked against the real website by `verify:landing-routes`, not here — that
 * needs the landing repository, and this suite must run without it.
 */
import fs from 'fs';
import path from 'path';
import { renderWebsiteGuide, WEBSITE_GUIDE, WEBSITE_GUIDE_KEYS } from '../../src/modules/bot-surface/domain/website-guide';

let passed = 0;
let failed = 0;

function assert(name: string, check: () => boolean): void {
    let ok = false;
    try {
        ok = check();
    } catch (error) {
        console.error(`     ↳ threw: ${(error as Error).message}`);
    }
    if (ok) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.log(`  ❌ FAIL: ${name}`);
    }
}

const BASE = 'https://wi-mall.com';

console.log('\n── The topics ──');

assert('there are topics, and every key is unique', () =>
    WEBSITE_GUIDE.length >= 15 && new Set(WEBSITE_GUIDE_KEYS).size === WEBSITE_GUIDE_KEYS.length);

/**
 * ⚠ The n8n tool reduces whatever the model passes to `[a-z]`, max 20. A key with a dash or a
 * digit could never be reached — the sanitised value would name no topic.
 */
assert('⛔ every key survives the tool\'s sanitiser ([a-z], max 20)', () =>
    WEBSITE_GUIDE_KEYS.every((k) => /^[a-z]{1,20}$/.test(k)));

assert('every topic is written in English AND French, with steps', () =>
    WEBSITE_GUIDE.every((t) => (['en', 'fr'] as const).every((l) =>
        t.copy[l].title.trim() !== ''
        && t.copy[l].summary.trim() !== ''
        && t.copy[l].steps.length > 0
        && t.copy[l].steps.every((s) => s.trim() !== ''))));

assert('English and French carry the same number of steps (one is not a stale copy)', () =>
    WEBSITE_GUIDE.every((t) => t.copy.en.steps.length === t.copy.fr.steps.length
        && t.copy.en.notes.length === t.copy.fr.notes.length));

assert('every path is a bare storefront path — no locale prefix, no host', () =>
    WEBSITE_GUIDE.every((t) => t.path.startsWith('/') && !/^\/(en|fr|pt|es|ar)(\/|$)/.test(t.path) && !t.path.includes('://')));

assert('every account and checkout page is marked as needing sign-in, and nothing else is', () =>
    WEBSITE_GUIDE.every((t) => t.signIn === /^\/shop\/(account|checkout)(\/|$)/.test(t.path)));

console.log('\n── What the tool returns ──');

const fr = renderWebsiteGuide('addresses', 'fr', BASE);
const en = renderWebsiteGuide('addresses', 'en', BASE);

assert('French gets French, with the French link (/fr/…)', () =>
    fr.includes('Définir par défaut') && fr.includes(`${BASE}/fr/shop/account/addresses`));

assert('English gets English, with the bare link (the website\'s as-needed rule)', () =>
    en.includes('Make default') && en.includes(`${BASE}/shop/account/addresses`) && !en.includes('/en/'));

assert('another language reads English, but its LINK keeps the customer\'s locale', () => {
    const pt = renderWebsiteGuide('addresses', 'pt', BASE);
    return pt.includes('Make default') && pt.includes(`${BASE}/pt/shop/account/addresses`);
});

assert('a sign-in page tells the assistant to offer a sign-in link first', () =>
    en.includes('auth_send_login_link') && !renderWebsiteGuide('browse', 'en', BASE).includes('auth_send_login_link'));

assert('⭐ the address topic says how to CHANGE one — there is no edit button on the website', () =>
    en.includes('there is no edit button') && fr.includes('il n’y a pas de bouton modifier'));

assert('an unknown topic answers the topic LIST, so the next call can pick right', () => {
    const list = renderWebsiteGuide('nonsense', 'en', BASE);
    return list.includes('No topic by that name.') && WEBSITE_GUIDE_KEYS.every((k) => list.includes(`- ${k}:`));
});

assert('no topic at all answers the list too, without the "no topic" line', () => {
    const list = renderWebsiteGuide(null, 'fr', BASE);
    return !list.includes('Aucun sujet') && list.includes('GUIDE DU SITE');
});

assert('the key is matched case-insensitively', () =>
    renderWebsiteGuide('ADDRESSES', 'en', BASE) === en);

assert('with no website address configured, it says so instead of printing "null"', () => {
    const bare = renderWebsiteGuide('orders', 'en', null);
    return !bare.includes('null') && bare.includes('not configured');
});

console.log('\n── The route ──');

const ROUTES = fs.readFileSync(path.join(__dirname, '../../src/modules/bot-surface/website-guide.routes.ts'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '../../src/api/index.ts'), 'utf8');

assert('served as plain text, under /api/public, with and without a topic', () =>
    ROUTES.includes("res.type('text/plain; charset=utf-8')")
    && ROUTES.includes("router.get('/website-guide', send)")
    && ROUTES.includes("router.get('/website-guide/:topic', send)")
    && /router\.use\('\/public', websiteGuideRoutes\)/.test(API));

console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
