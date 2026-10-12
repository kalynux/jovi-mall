/**
 * The shapes the website guide is written in — shared by the storefront topics
 * (`website-guide.ts`) and the three business apps (`website-guide-{vendor,agency,agent}.ts`).
 *
 * A separate file only so the four topic files can import the types without importing each
 * other; nothing here does anything.
 */

export type GuideLanguage = 'en' | 'fr';

/**
 * Which Wi-Mall app a topic happens in. Decides where its LINK points and what "sign-in" means:
 *
 * - `shop`   — wi-mall.com, the customer storefront. Customers sign in with a link or code.
 * - `vendor` — the seller dashboard (`VENDOR_APP_URL`, vendor.wi-mall.com, also an Android app).
 * - `agency` — the delivery-agency dashboard (`AGENCY_APP_URL`, agency.wi-mall.com, also Android).
 * - `agent`  — the Wi-Mall Agent phone app. It has NO web address, so its topics carry no link.
 *
 * ⚠ The admin dashboard is deliberately absent (owner, 2026-10-09): nobody who talks to the bot
 * is an administrator, and this text is served on a public route.
 */
export type GuideApp = 'shop' | 'vendor' | 'agency' | 'agent';

export interface GuideCopy {
    title: string;
    /** One line, for the topic list the tool shows when it is asked for an app or an unknown key. */
    summary: string;
    steps: readonly string[];
    /** What the app will refuse, or what the user should know first. */
    notes: readonly string[];
}

export interface GuideTopic {
    /** `[a-z]`, max 20 — the n8n tool reduces whatever the model passes to exactly that. */
    key: string;
    app: GuideApp;
    /**
     * The page, WITHOUT host or locale prefix. `shop` paths are checked by
     * `verify:landing-routes`, `vendor`/`agency` paths by `verify:dashboard-routes`.
     * `null` only for the agent app, which has screens rather than addresses.
     */
    path: string | null;
    /** Does the page need the user signed in to that app? */
    signIn: boolean;
    copy: Readonly<Record<GuideLanguage, GuideCopy>>;
}

export const T = (topic: GuideTopic): GuideTopic => Object.freeze(topic);
