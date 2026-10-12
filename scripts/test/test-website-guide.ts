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
import { GUIDE_APPS, renderWebsiteGuide, WEBSITE_GUIDE, WEBSITE_GUIDE_KEYS } from '../../src/modules/bot-surface/domain/website-guide';

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

const SHOP = WEBSITE_GUIDE.filter((t) => t.app === 'shop');

assert('every storefront path is a bare storefront path — no locale prefix, no host', () =>
    SHOP.every((t) => t.path !== null && t.path.startsWith('/') && !/^\/(en|fr|pt|es|ar)(\/|$)/.test(t.path) && !t.path.includes('://')));

assert('every storefront account and checkout page is marked as needing sign-in, and nothing else is', () =>
    SHOP.every((t) => t.signIn === /^\/shop\/(account|checkout)(\/|$)/.test(t.path ?? '')));

console.log('\n── The business apps (2026-10-09) ──');

assert('⛔ an app key is never also a topic key — it would shadow the topic for ever', () =>
    GUIDE_APPS.every((a) => !WEBSITE_GUIDE_KEYS.includes(a)));

assert('every business topic is named after its app, so the model can tell them apart in a list', () =>
    WEBSITE_GUIDE.filter((t) => t.app !== 'shop').every((t) => t.key.startsWith(t.app)));

assert('dashboard paths are bare dashboard paths (no host, no locale); agent-app topics have none', () =>
    WEBSITE_GUIDE.every((t) => {
        if (t.app === 'agent') return t.path === null;
        if (t.app === 'shop') return true;
        return t.path !== null && /^\/[a-z]/.test(t.path) && !t.path.includes('://') && !/^\/(en|fr|pt|es|ar)(\/|$)/.test(t.path);
    }));

/**
 * ⭐ The owner's question that started this round: can the assistant help with notification
 * settings? On the dashboards and the agent app the chat can only GUIDE, so each must have a
 * notification topic — and the storefront keeps its own.
 */
assert('⭐ every app has a notification-settings topic', () =>
    ['notifications', 'vendornotifications', 'agencynotifications', 'agentnotifications']
        .every((k) => WEBSITE_GUIDE_KEYS.includes(k)));

assert('every topic named in the guide\'s own text exists (no "see topic X" that answers the list)', () => {
    const mentioned = new Set<string>();
    const scan = (s: string): void => {
        for (const m of s.matchAll(/\b(?:topic|sujet) ([a-z]{3,20})\b/g)) mentioned.add(m[1]);
    };
    for (const t of WEBSITE_GUIDE) for (const l of ['en', 'fr'] as const) {
        [...t.copy[l].steps, ...t.copy[l].notes].forEach(scan);
    }
    for (const app of GUIDE_APPS) for (const l of ['en', 'fr']) scan(renderWebsiteGuide(app, l, BASE));
    // The fixed lines every topic of an app carries (sign-in, no-link) name topics too.
    for (const k of ['vendornotifications', 'agencynotifications', 'agentnotifications']) {
        for (const l of ['en', 'fr']) scan(renderWebsiteGuide(k, l, BASE));
    }
    const missing = [...mentioned].filter((k) => !WEBSITE_GUIDE_KEYS.includes(k) && !(GUIDE_APPS as readonly string[]).includes(k));
    if (missing.length) console.error(`     ↳ named but missing: ${missing.join(', ')}`);
    return missing.length === 0;
});

/**
 * ⚠ The n8n tool cuts what it reads at 6000 characters. A list cut in half is a list whose
 * second half the model never learns exists, so every answer must fit — with room to spare,
 * because the cap counts characters the way n8n counts them.
 */
const CAP = 5800;
assert('⛔ every answer the tool can get fits under its 6000-character cut', () => {
    const answers = [
        ...['en', 'fr'].flatMap((l) => [renderWebsiteGuide(null, l, BASE), ...GUIDE_APPS.map((a) => renderWebsiteGuide(a, l, BASE))]),
        ...WEBSITE_GUIDE_KEYS.flatMap((k) => ['en', 'fr'].map((l) => renderWebsiteGuide(k, l, BASE))),
    ];
    const over = answers.filter((a) => a.length > CAP);
    if (over.length) console.error(`     ↳ ${over.length} over ${CAP}: ${over.map((a) => `${a.split('\n')[0].slice(0, 40)}… (${a.length})`).join('; ')}`);
    return over.length === 0;
});

const DASH = { shop: BASE, vendor: 'https://vendor.wi-mall.com', agency: 'https://agency.wi-mall.com/' };

assert('a vendor topic links to the vendor dashboard, with NO locale prefix even in French', () => {
    const v = renderWebsiteGuide('vendornotifications', 'fr', DASH);
    return v.includes('LIEN: https://vendor.wi-mall.com/dashboard/settings/notifications') && v.includes('TABLEAU DE BORD VENDEUR');
});

assert('an agency topic links to the agency dashboard, joined with exactly one slash', () =>
    renderWebsiteGuide('agencynotifications', 'en', DASH).includes('LINK: https://agency.wi-mall.com/dashboard/settings/notifications'));

assert('an agent-app topic says there is no link and never offers the customer sign-in link', () => {
    const a = renderWebsiteGuide('agentnotifications', 'en', DASH);
    return a.includes('LINK: none') && !a.includes('auth_send_login_link');
});

assert('a dashboard topic never offers the CUSTOMER sign-in link (it cannot sign anyone into a dashboard)', () =>
    WEBSITE_GUIDE.filter((t) => t.app === 'vendor' || t.app === 'agency')
        .every((t) => !renderWebsiteGuide(t.key, 'en', DASH).includes('auth_send_login_link')));

assert('with no dashboard address configured, a vendor topic says so instead of printing "null"', () => {
    const bare = renderWebsiteGuide('vendornotifications', 'en', { shop: BASE });
    return !bare.includes('null') && bare.includes('not configured');
});

assert('each app key answers that app\'s topics and nothing else', () =>
    GUIDE_APPS.every((app) => {
        const list = renderWebsiteGuide(app, 'en', BASE);
        return WEBSITE_GUIDE.every((t) => list.includes(`- ${t.key}:`) === (t.app === app));
    }));

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

assert('an unknown topic answers the storefront LIST plus the other app keys, so the next call can pick right', () => {
    const list = renderWebsiteGuide('nonsense', 'en', BASE);
    return list.includes('No topic by that name.')
        && SHOP.every((t) => list.includes(`- ${t.key}:`))
        && ['vendor', 'agency', 'agent'].every((a) => list.includes(`- ${a}:`));
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
