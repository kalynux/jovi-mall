import { GuideTopic, T } from '../../bot-surface/domain/website-guide-types';

/**
 * The referral program's guide topics, served through `WEBSITE_GUIDE` since the storefront and the
 * two dashboards shipped their pages (2026-11-03). This is the owner's R-11: the bot guides people
 * to the website.
 *
 * ⚠ A link to a page that does not exist turns `verify:landing-routes` and `verify:dashboard-routes`
 * red, which is what happened on 260fc60.
 */
export const REFERRAL_GUIDE_TOPICS: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'referrals',
        app: 'shop',
        path: '/shop/account/referrals',
        signIn: true,
        copy: {
            en: {
                title: "The referral program",
                summary: "Apply to become a partner, share your link, follow and withdraw your rewards",
                steps: [
                    "Open Account → \"Referrals\". If the program is open, read the terms, tick the box and send the application. Wi-Mall reviews it.",
                    "Once approved, the page shows your code and link, what you earned, and the accounts you referred. Share the link.",
                    "To withdraw: when \"available\" reaches the minimum shown there, tap withdraw. Wi-Mall reviews and pays it.",
                ],
                notes: [
                    "Rewards come from the commission Wi-Mall earns on a sale, never from the order value. The page shows the rate and how long each referral earns. Never quote a figure from memory.",
                    "A reward can be withdrawn after a wait, and goes down if the sale is refunded. Only a brand-new account can be referred, and a forgotten code cannot be added later: the person should ask whoever referred them for the link before registering.",
                    "A customer gives a mobile-money number on that page before the first withdrawal. Applying and withdrawing happen on the website, never in this chat.",
                ],
            },
            fr: {
                title: "Le programme de parrainage",
                summary: "Devenir partenaire, partager votre lien, suivre et retirer vos récompenses",
                steps: [
                    "Ouvrez Compte → « Parrainage ». Si le programme est ouvert, lisez les conditions, cochez la case et envoyez la candidature. Wi-Mall l’examine.",
                    "Une fois approuvé, la page montre votre code et votre lien, vos gains et les comptes parrainés. Partagez le lien.",
                    "Pour retirer : quand le « disponible » atteint le minimum indiqué, appuyez sur retirer. Wi-Mall examine et paie.",
                ],
                notes: [
                    "Les récompenses viennent de la commission que Wi-Mall perçoit sur une vente, jamais de la valeur de la commande. La page indique le taux et la durée de chaque parrainage. Ne citez jamais un chiffre de mémoire.",
                    "Une récompense se retire après un délai d’attente et diminue si la vente est remboursée. Seul un nouveau compte peut être parrainé, et un code oublié ne peut pas être ajouté ensuite : la personne doit demander le lien à son parrain avant de s’inscrire.",
                    "Un client indique un numéro mobile money sur cette page avant le premier retrait. La candidature et les retraits se font sur le site, jamais dans cette discussion.",
                ],
            },
        },
    }),
    T({
        key: 'vendorreferrals',
        app: 'vendor',
        path: '/dashboard/account/referrals',
        signIn: true,
        copy: {
            en: {
                title: "Vendor dashboard: the referral program",
                summary: "Apply to become a partner, share your link, follow and withdraw your rewards",
                steps: [
                    "Open Account → \"Referrals\". If the program is open, read the terms, tick the box and send the application. Wi-Mall reviews it.",
                    "Once approved, the page shows your code and link, what you earned, and the accounts you referred. Share the link.",
                    "To withdraw: when \"available\" reaches the minimum shown there, tap withdraw. Wi-Mall reviews and pays it.",
                ],
                notes: [
                    "Rewards come from the commission Wi-Mall earns on a sale, never from the order value. The page shows the rate and how long each referral earns. Never quote a figure from memory.",
                    "A reward can be withdrawn after a wait, and goes down if the sale is refunded. Only a brand-new account can be referred, and a forgotten code cannot be added later: the person should ask whoever referred them for the link before registering.",
                    "Referral money is separate from sales earnings, with its own lower minimum. It is paid to the number under \"Payout Setup\".",
                ],
            },
            fr: {
                title: "Tableau de bord vendeur : le programme de parrainage",
                summary: "Devenir partenaire, partager votre lien, suivre et retirer vos récompenses",
                steps: [
                    "Ouvrez Compte → « Parrainage ». Si le programme est ouvert, lisez les conditions, cochez la case et envoyez la candidature. Wi-Mall l’examine.",
                    "Une fois approuvé, la page montre votre code et votre lien, vos gains et les comptes parrainés. Partagez le lien.",
                    "Pour retirer : quand le « disponible » atteint le minimum indiqué, appuyez sur retirer. Wi-Mall examine et paie.",
                ],
                notes: [
                    "Les récompenses viennent de la commission que Wi-Mall perçoit sur une vente, jamais de la valeur de la commande. La page indique le taux et la durée de chaque parrainage. Ne citez jamais un chiffre de mémoire.",
                    "Une récompense se retire après un délai d’attente et diminue si la vente est remboursée. Seul un nouveau compte peut être parrainé, et un code oublié ne peut pas être ajouté ensuite : la personne doit demander le lien à son parrain avant de s’inscrire.",
                    "L’argent du parrainage est séparé des gains de vente, avec un minimum plus bas. Il est versé au numéro indiqué dans « Versements ».",
                ],
            },
        },
    }),
    T({
        key: 'agencyreferrals',
        app: 'agency',
        path: '/dashboard/account/referrals',
        signIn: true,
        copy: {
            en: {
                title: "Agency dashboard: the referral program",
                summary: "Apply to become a partner, share your link, follow and withdraw your rewards",
                steps: [
                    "Open Account → \"Referrals\". If the program is open, read the terms, tick the box and send the application. Wi-Mall reviews it.",
                    "Once approved, the page shows your code and link, what you earned, and the accounts you referred. Share the link.",
                    "To withdraw: when \"available\" reaches the minimum shown there, tap withdraw. Wi-Mall reviews and pays it.",
                ],
                notes: [
                    "Rewards come from the commission Wi-Mall earns on a sale, never from the order value. The page shows the rate and how long each referral earns. Never quote a figure from memory.",
                    "A reward can be withdrawn after a wait, and goes down if the sale is refunded. Only a brand-new account can be referred, and a forgotten code cannot be added later: the person should ask whoever referred them for the link before registering.",
                    "Referral money is separate from delivery earnings, with its own lower minimum. It is paid to the number on the payout page.",
                ],
            },
            fr: {
                title: "Tableau de bord agence : le programme de parrainage",
                summary: "Devenir partenaire, partager votre lien, suivre et retirer vos récompenses",
                steps: [
                    "Ouvrez Compte → « Parrainage ». Si le programme est ouvert, lisez les conditions, cochez la case et envoyez la candidature. Wi-Mall l’examine.",
                    "Une fois approuvé, la page montre votre code et votre lien, vos gains et les comptes parrainés. Partagez le lien.",
                    "Pour retirer : quand le « disponible » atteint le minimum indiqué, appuyez sur retirer. Wi-Mall examine et paie.",
                ],
                notes: [
                    "Les récompenses viennent de la commission que Wi-Mall perçoit sur une vente, jamais de la valeur de la commande. La page indique le taux et la durée de chaque parrainage. Ne citez jamais un chiffre de mémoire.",
                    "Une récompense se retire après un délai d’attente et diminue si la vente est remboursée. Seul un nouveau compte peut être parrainé, et un code oublié ne peut pas être ajouté ensuite : la personne doit demander le lien à son parrain avant de s’inscrire.",
                    "L’argent du parrainage est séparé des gains de livraison, avec un minimum plus bas. Il est versé au numéro de la page des versements.",
                ],
            },
        },
    }),
]);

/**
 * ⚠ **Written and NOT SERVED until the agent app ships its referral screens.** The app has no web
 * path, so no route check can catch this one: served early, the bot would send agents to a menu row
 * their installed app does not have. On 2026-11-03 the published app was still 0.1.9 of 28 October
 * and the screens were uncommitted in `agent_app`.
 *
 * **When a build with them is published:** move this into `REFERRAL_GUIDE_TOPICS`.
 */
export const HELD_REFERRAL_GUIDE_TOPICS: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'agentreferrals',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: "Agent app: the referral program",
                summary: "Apply to become a partner, share your link, follow and withdraw your rewards",
                steps: [
                    "Open \"More\" → \"Referral program\". If the program is open, read the terms, tick the box and send the application. Wi-Mall reviews it.",
                    "Once approved, the page shows your code and link, what you earned, and the accounts you referred. Share the link.",
                    "To withdraw: when \"available\" reaches the minimum shown there, tap withdraw. Wi-Mall reviews and pays it.",
                ],
                notes: [
                    "Rewards come from the commission Wi-Mall earns on a sale, never from the order value. The page shows the rate and how long each referral earns. Never quote a figure from memory.",
                    "A reward can be withdrawn after a wait, and goes down if the sale is refunded. Only a brand-new account can be referred, and a forgotten code cannot be added later: the person should ask whoever referred them for the link before registering.",
                    "An agent earns from the vendors, customers and agencies they refer. An agent's own deliveries earn no reward. Referral money is separate from delivery earnings.",
                ],
            },
            fr: {
                title: "App agent : le programme de parrainage",
                summary: "Devenir partenaire, partager votre lien, suivre et retirer vos récompenses",
                steps: [
                    "Ouvrez « Plus » → « Programme de parrainage ». Si le programme est ouvert, lisez les conditions, cochez la case et envoyez la candidature. Wi-Mall l’examine.",
                    "Une fois approuvé, la page montre votre code et votre lien, vos gains et les comptes parrainés. Partagez le lien.",
                    "Pour retirer : quand le « disponible » atteint le minimum indiqué, appuyez sur retirer. Wi-Mall examine et paie.",
                ],
                notes: [
                    "Les récompenses viennent de la commission que Wi-Mall perçoit sur une vente, jamais de la valeur de la commande. La page indique le taux et la durée de chaque parrainage. Ne citez jamais un chiffre de mémoire.",
                    "Une récompense se retire après un délai d’attente et diminue si la vente est remboursée. Seul un nouveau compte peut être parrainé, et un code oublié ne peut pas être ajouté ensuite : la personne doit demander le lien à son parrain avant de s’inscrire.",
                    "Un livreur gagne sur les vendeurs, clients et agences qu’il parraine. Ses propres livraisons ne rapportent aucune récompense. L’argent du parrainage est séparé des gains de livraison.",
                ],
            },
        },
    }),
]);
