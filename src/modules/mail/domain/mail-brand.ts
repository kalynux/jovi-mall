/**
 * The brand context every email template receives, whether its caller knows about it or not.
 *
 * ── Why this is injected rather than passed ──────────────────────────────────
 *
 * There are eight `mailService.send()` call sites and they are spread across auth, password
 * reset, contact change, admin credential delivery and four notification handlers. Asking each
 * to pass `brandName`, `brandColor`, `supportEmail` and `year` means eight places to forget, and
 * the forgetting is SILENT: Handlebars renders an unknown variable as the empty string, so a
 * missed `brandName` produces "Welcome to ." and a missed `brandColor` produces
 * `background:;` — a button with no colour. That is the same class of defect
 * `test:booking-notification` exists for, where an empty string IS the designed rendering of a
 * missing value and the result reads as a wording choice rather than a bug.
 *
 * `MailService.renderTemplate` merges this UNDER the caller's variables, so a caller can still
 * override any of it, and no caller has to.
 *
 * ⚠ **`year` is computed per render, never cached.** A process that stays up across New Year
 * would otherwise put last year in every footer until somebody restarted it — which is exactly
 * the kind of thing nobody notices for eleven months.
 */
export interface MailBrand {
    brandName: string;
    brandColor: string;
    /** Empty string means "no image" — the templates fall back to a typographic wordmark. */
    logoUrl: string;
    supportEmail: string;
    storefrontUrl: string;
    year: number;
}

/**
 * ⚠ **Not a constant, and not memoised.** Reading `process.env` per render is free at this
 * volume, and it keeps `year` honest (see above). It also means a test can set a variable and
 * see the effect without resetting a module singleton.
 */
export function mailBrand(): MailBrand {
    return {
        brandName: process.env.BRAND_NAME || 'Wi-Mall',
        /**
         * Indigo. Chosen for contrast rather than taste: white text on this passes WCAG AA at
         * ~6.4:1, which matters because it is the button label on every transactional email the
         * platform sends. A lighter brand colour would need dark button text, and the templates
         * hardcode white.
         */
        brandColor: process.env.BRAND_COLOR || '#4F46E5',
        /**
         * ⚠ Must be a PUBLICLY reachable https URL. A mail client fetches images from the
         * RECIPIENT's network, so a LAN or Tailscale address renders as a broken image in every
         * inbox — the same trap as `STORAGE_LOCAL_URL` pointing at `100.64/10`, which is why
         * the bot product cards have `isReachableByPlatformServers`. Unset is safe: the
         * templates render the wordmark instead, which cannot fail to load.
         */
        logoUrl: process.env.BRAND_LOGO_URL || '',
        supportEmail: process.env.MAIL_SUPPORT_EMAIL
            || process.env.MAIL_FROM_DEFAULT
            || 'support@wi-mall.com',
        storefrontUrl: process.env.STOREFRONT_URL || 'https://wi-mall.com',
        year: new Date().getFullYear(),
    };
}
