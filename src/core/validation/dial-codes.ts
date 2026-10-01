import { normalizePhoneNumber } from './phone';

/**
 * Country calling codes — what a COUNTRY PICKER beside a phone field offers, and the one rule
 * that turns "a country + what the customer typed" into E.164.
 *
 * ── WHY THIS EXISTS (owner's request, 2026-10-01) ───────────────────────────
 * Every checkout door asked the customer to type their mobile-money number "including the country
 * code, for example +237", and customers typed `672745831` anyway — the bot then had to ask again.
 * A picker defaulting to the customer's own country lets them type only the national number.
 *
 * ── ⚠ THIS DOES NOT LOOSEN `phone.ts` ───────────────────────────────────────
 * `phone.ts` refuses a national number because there is no per-request default country to resolve
 * it against. A picker IS that country, stated by the customer on the request, so composing here
 * is not guessing. Everything still ends in `PhoneNumberSchema`: this module only builds the
 * string the platform's one validator then judges.
 *
 * ⚠ **The ISO code is the option id, never the dial code** — the US and Canada share `+1`, and a
 * dropdown whose ids collide cannot be answered.
 */

export interface DialCountry {
    /** ISO 3166-1 alpha-2. The option id. */
    iso: string;
    /** Digits only, no `+`. */
    dial: string;
}

/** The platform's home country, and the default when nothing on the account says otherwise. */
export const DEFAULT_DIAL_COUNTRY = 'CM';

/**
 * Every African country, then the diaspora destinations customers most often hold a number in.
 * Cameroon is first; the rest are sorted by their localized name at render time.
 *
 * ⚠ **Offering a country is not the same as being able to charge it.** Mobile money is routed by
 * the number's operator (`cm-operator.ts`), and a number no network can be worked out for is
 * refused BEFORE the spend with `PAYMENT_OPERATOR_UNDETERMINED`. So a wrong pick costs a retry,
 * never a charge to a stranger.
 */
export const DIAL_COUNTRIES: readonly DialCountry[] = Object.freeze([
    { iso: 'CM', dial: '237' },
    { iso: 'DZ', dial: '213' }, { iso: 'AO', dial: '244' }, { iso: 'BJ', dial: '229' },
    { iso: 'BW', dial: '267' }, { iso: 'BF', dial: '226' }, { iso: 'BI', dial: '257' },
    { iso: 'CV', dial: '238' }, { iso: 'CF', dial: '236' }, { iso: 'TD', dial: '235' },
    { iso: 'KM', dial: '269' }, { iso: 'CG', dial: '242' }, { iso: 'CD', dial: '243' },
    { iso: 'CI', dial: '225' }, { iso: 'DJ', dial: '253' }, { iso: 'EG', dial: '20' },
    { iso: 'GQ', dial: '240' }, { iso: 'ER', dial: '291' }, { iso: 'SZ', dial: '268' },
    { iso: 'ET', dial: '251' }, { iso: 'GA', dial: '241' }, { iso: 'GM', dial: '220' },
    { iso: 'GH', dial: '233' }, { iso: 'GN', dial: '224' }, { iso: 'GW', dial: '245' },
    { iso: 'KE', dial: '254' }, { iso: 'LS', dial: '266' }, { iso: 'LR', dial: '231' },
    { iso: 'LY', dial: '218' }, { iso: 'MG', dial: '261' }, { iso: 'MW', dial: '265' },
    { iso: 'ML', dial: '223' }, { iso: 'MR', dial: '222' }, { iso: 'MU', dial: '230' },
    { iso: 'MA', dial: '212' }, { iso: 'MZ', dial: '258' }, { iso: 'NA', dial: '264' },
    { iso: 'NE', dial: '227' }, { iso: 'NG', dial: '234' }, { iso: 'RW', dial: '250' },
    { iso: 'ST', dial: '239' }, { iso: 'SN', dial: '221' }, { iso: 'SC', dial: '248' },
    { iso: 'SL', dial: '232' }, { iso: 'SO', dial: '252' }, { iso: 'ZA', dial: '27' },
    { iso: 'SS', dial: '211' }, { iso: 'SD', dial: '249' }, { iso: 'TZ', dial: '255' },
    { iso: 'TG', dial: '228' }, { iso: 'TN', dial: '216' }, { iso: 'UG', dial: '256' },
    { iso: 'ZM', dial: '260' }, { iso: 'ZW', dial: '263' },
    { iso: 'FR', dial: '33' }, { iso: 'BE', dial: '32' }, { iso: 'CH', dial: '41' },
    { iso: 'DE', dial: '49' }, { iso: 'GB', dial: '44' }, { iso: 'IT', dial: '39' },
    { iso: 'ES', dial: '34' }, { iso: 'PT', dial: '351' }, { iso: 'NL', dial: '31' },
    { iso: 'US', dial: '1' }, { iso: 'CA', dial: '1' }, { iso: 'BR', dial: '55' },
    { iso: 'CN', dial: '86' }, { iso: 'IN', dial: '91' }, { iso: 'AE', dial: '971' },
    { iso: 'SA', dial: '966' }, { iso: 'TR', dial: '90' }, { iso: 'LB', dial: '961' },
]);

const BY_ISO = new Map(DIAL_COUNTRIES.map((c) => [c.iso, c]));

/** The country for an option id, or null for anything not on the list. Case-insensitive. */
export function dialCountryOf(iso: unknown): DialCountry | null {
    return typeof iso === 'string' ? BY_ISO.get(iso.trim().toUpperCase()) ?? null : null;
}

/**
 * The country an E.164 number belongs to, by longest dial-code prefix — what the picker defaults
 * to for a customer whose account already holds a number. Null when nothing on the list matches.
 *
 * A shared code (`+1`) resolves to the first country listed with it; the default only has to be
 * the right CODE, and the customer can still change the name beside it.
 */
export function dialCountryOfNumber(e164: string | null | undefined): string | null {
    if (typeof e164 !== 'string' || !e164.startsWith('+')) return null;
    const digits = e164.slice(1);
    let best: DialCountry | null = null;
    for (const country of DIAL_COUNTRIES) {
        if (digits.startsWith(country.dial) && (!best || country.dial.length > best.dial.length)) {
            best = country;
        }
    }
    return best?.iso ?? null;
}

/**
 * ⭐ THE rule: what the customer typed, read against the country they picked.
 *
 * Returns the input UNCHANGED whenever there is nothing to compose — blank (which still means
 * "use the number on my account"), already international, not digits, or no recognised country —
 * so the caller's own validation sees exactly what it would have seen without a picker, and a
 * refusal stays the refusal it always was.
 *
 *   - `+…` is the customer overriding the picker, and wins.
 *   - `00…` is international dialling, and becomes `+…`.
 *   - **digits that already START with the picked code and are long enough to hold a national
 *     number after it** (≥ 8) are read as "they typed the code anyway" — `237672745831` with
 *     Cameroon picked must not become `+237237672745831`, which is fifteen digits and therefore
 *     VALID E.164 that charges nobody. The bound keeps a national number that merely begins with
 *     the same digits (`33…` in France after dropping the trunk 0) on the national branch.
 *   - otherwise ONE leading trunk `0` is dropped (`0612…` in France), except in Italy, whose
 *     numbers keep it after the country code.
 */
export function composeTypedNumber(typed: unknown, iso: unknown): unknown {
    if (typeof typed !== 'string' || typed.trim().length === 0) return typed;
    const country = dialCountryOf(iso);
    if (!country) return typed;

    const normalized = normalizePhoneNumber(typed.trim());
    if (normalized.startsWith('+')) return typed;
    if (!/^\d+$/.test(normalized)) return typed;
    if (normalized.startsWith('00')) return `+${normalized.slice(2)}`;

    if (normalized.startsWith(country.dial) && normalized.length - country.dial.length >= 8) {
        return `+${normalized}`;
    }
    const national = country.iso !== 'IT' && normalized.startsWith('0') ? normalized.slice(1) : normalized;
    return `+${country.dial}${national}`;
}

/** One picker row: the option id and what the customer reads. */
export interface DialOption {
    id: string;
    title: string;
}

function regionNames(language: string): Intl.DisplayNames | null {
    try {
        return new Intl.DisplayNames([language, 'en'], { type: 'region' });
    } catch {
        return null;
    }
}

/**
 * The picker's rows, in the customer's language: the home country first, the rest by name.
 *
 * Names come from the runtime's own ICU data (`Intl.DisplayNames`), so the five platform languages
 * need no copy table here and a new one costs nothing. The title leads with the code because the
 * code is what the customer is actually choosing, and a long country name is the part that can be
 * clipped.
 *
 * @param maxTitle A cap on the title, for a control that has one (a WhatsApp Flow dropdown row).
 */
export function dialOptions(language: string | null | undefined, maxTitle?: number): DialOption[] {
    const names = regionNames(typeof language === 'string' && language ? language : 'en');
    const rows = DIAL_COUNTRIES.map((c) => {
        const name = names?.of(c.iso) ?? c.iso;
        return { iso: c.iso, name, title: `+${c.dial} ${name}` };
    });
    const [home, ...rest] = rows;
    rest.sort((a, b) => a.name.localeCompare(b.name, language || 'en'));
    return [home, ...rest].map((r) => ({
        id: r.iso,
        title: maxTitle && r.title.length > maxTitle ? `${r.title.slice(0, maxTitle - 1)}…` : r.title,
    }));
}
