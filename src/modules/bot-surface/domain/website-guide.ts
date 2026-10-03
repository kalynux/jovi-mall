import { storefrontUrl } from '../../../core/utils/storefront-link.util';

/**
 * The website guide — every customer action on wi-mall.com, written for the chat assistant
 * (owner, 2026-10-03: "have the AI agent redirect the user to the platform for actions he can't
 * perform in the chat … a book that contains all actions that can be performed on the website").
 *
 * ── WHO READS IT ─────────────────────────────────────────────────────────────
 * The MODEL, through the `Read-Website-Guide` tool in `wi-mall-core`, never the customer
 * directly. So each topic is plain text with exact button labels: the assistant retells the
 * steps in its own short words and hands over the link. A customer asking "how do I change my
 * address?" gets *where* and *what to tap*, rather than "I can't do that from here".
 *
 * ── WHERE THE CONTENT CAME FROM ──────────────────────────────────────────────
 * Read from `frontend/landing` itself on 2026-10-03: every route under `/shop`, `(auth)` and
 * `pay`, its components and `messages/{en,fr}.json`. **The labels are quoted, not paraphrased**
 * — "Make default" / "Définir par défaut" is what the button says, and a guide that names a
 * button the customer cannot find is worse than no guide. When the landing app changes a label,
 * this file is stale; nothing checks the WORDS. The PATHS are checked: `verify:landing-routes`
 * resolves every `path` below against that repository's routes.
 *
 * ── LANGUAGES ────────────────────────────────────────────────────────────────
 * English and French only, the two the chat offers (`CHAT_LANGUAGES`, Cameroon). A customer on
 * another language reads English text — but the LINK still carries their locale prefix, because
 * the website does serve all five.
 *
 * ── IMPORTS ONE UTILITY, NO MODEL ────────────────────────────────────────────
 * Pure apart from `storefrontUrl`, the one implementation of the website's `as-needed` locale
 * rule (English bare, others prefixed). Hand-joining the base and a path here would be the third
 * copy of that rule, and the second copy is the one that 404'd every notification button.
 */

export type GuideLanguage = 'en' | 'fr';

interface GuideCopy {
    title: string;
    /** One line, for the topic list the tool shows when it is asked for something unknown. */
    summary: string;
    steps: readonly string[];
    /** What the website will refuse, or what the customer should know first. */
    notes: readonly string[];
}

export interface GuideTopic {
    key: string;
    /** Storefront path WITHOUT a locale prefix. Checked by `verify:landing-routes`. */
    path: string;
    /** Does the page need a signed-in customer? (`/shop/account/**`, `/shop/checkout/**`). */
    signIn: boolean;
    copy: Readonly<Record<GuideLanguage, GuideCopy>>;
}

const T = (topic: GuideTopic): GuideTopic => Object.freeze(topic);

export const WEBSITE_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'signin',
        path: '/login',
        signIn: false,
        copy: {
            en: {
                title: 'Signing in to the website',
                summary: 'How a customer signs in (there is no password)',
                steps: [
                    'Customers have no password. In this chat, send /login (or ask me to send a sign-in link).',
                    'Tap the link that arrives: it signs you in by itself.',
                    'Or open the sign-in page, choose Phone or Email, enter the number you use with this chat and the 8-character "Sign-in code", then tap "Sign in".',
                ],
                notes: [
                    'The link and the code last 10 minutes and work once; using one cancels the other.',
                    'There is no sign-up form for customers: the account was created in this chat.',
                ],
            },
            fr: {
                title: 'Se connecter au site',
                summary: 'Comment un client se connecte (il n’y a pas de mot de passe)',
                steps: [
                    'Les clients n’ont pas de mot de passe. Dans ce chat, envoyez /login (ou demandez-moi un lien de connexion).',
                    'Ouvrez le lien reçu : il vous connecte automatiquement.',
                    'Ou ouvrez la page de connexion, choisissez Téléphone ou E-mail, saisissez le numéro utilisé avec ce chat et le « Code de connexion » à 8 caractères, puis appuyez sur « Se connecter ».',
                ],
                notes: [
                    'Le lien et le code durent 10 minutes et ne servent qu’une fois ; utiliser l’un annule l’autre.',
                    'Il n’y a pas de formulaire d’inscription pour les clients : le compte a été créé dans ce chat.',
                ],
            },
        },
    }),
    T({
        key: 'addresses',
        path: '/shop/account/addresses',
        signIn: true,
        copy: {
            en: {
                title: 'Delivery addresses: add, set default, remove, change',
                summary: 'Add, remove or change a saved delivery address, or pick the default',
                steps: [
                    'Open Account → "Addresses".',
                    'To add one: tap "Add", type at least 3 letters in "Search for your address" and PICK a result, check the fields, optionally tick "Use as my default delivery address", then tap "Save address".',
                    'To make one the default: tap "Make default" on it.',
                    'To remove one: tap "Remove" on it, then confirm.',
                    'To CHANGE an address: there is no edit button — add the correct address first (as default), then remove the wrong one.',
                ],
                notes: [
                    'Always pick the address from the search results: a typed address has no map position and is refused at checkout.',
                    'Removing an address does not affect orders already on their way.',
                ],
            },
            fr: {
                title: 'Adresses de livraison : ajouter, définir par défaut, retirer, modifier',
                summary: 'Ajouter, retirer ou modifier une adresse, ou choisir celle par défaut',
                steps: [
                    'Ouvrez Compte → « Adresses ».',
                    'Pour en ajouter une : appuyez sur « Ajouter », tapez au moins 3 lettres dans la recherche d’adresse et CHOISISSEZ un résultat, vérifiez les champs, cochez si besoin l’option « par défaut », puis appuyez sur « Enregistrer l’adresse ».',
                    'Pour en faire l’adresse par défaut : appuyez sur « Définir par défaut ».',
                    'Pour en retirer une : appuyez sur « Retirer », puis confirmez.',
                    'Pour MODIFIER une adresse : il n’y a pas de bouton modifier — ajoutez d’abord la bonne adresse (par défaut), puis retirez l’ancienne.',
                ],
                notes: [
                    'Choisissez toujours l’adresse dans les résultats de recherche : une adresse tapée n’a pas de position sur la carte et est refusée au paiement.',
                    'Retirer une adresse ne change rien aux commandes déjà en route.',
                ],
            },
        },
    }),
    T({
        key: 'paymentmethods',
        path: '/shop/account/payment-methods',
        signIn: true,
        copy: {
            en: {
                title: 'Saved payment methods (mobile money)',
                summary: 'Save, remove or choose the default mobile-money number',
                steps: [
                    'Open Account → "Payment methods".',
                    'To add one: tap "Add", choose the "Provider" (MTN Mobile Money, Orange Money or Moov Money), enter the "Wallet number" with the country code, optionally make it the default, then tap "Save method".',
                    'Use "Make default" or "Remove" on a saved method.',
                ],
                notes: [
                    'Only mobile-money wallets can be saved; cards are never stored.',
                    'Up to 10 methods, and the same number cannot be saved twice on one network.',
                ],
            },
            fr: {
                title: 'Moyens de paiement enregistrés (mobile money)',
                summary: 'Enregistrer, retirer ou choisir le numéro mobile money par défaut',
                steps: [
                    'Ouvrez Compte → « Moyens de paiement ».',
                    'Pour en ajouter un : appuyez sur « Ajouter », choisissez l’« Opérateur » (MTN Mobile Money, Orange Money ou Moov Money), saisissez le « Numéro mobile money » avec l’indicatif, mettez-le par défaut si vous voulez, puis enregistrez.',
                    'Utilisez « Définir par défaut » ou « Retirer » sur un moyen enregistré.',
                ],
                notes: [
                    'Seuls les portefeuilles mobile money s’enregistrent ; aucune carte n’est conservée.',
                    '10 moyens au maximum, et un même numéro ne peut pas être enregistré deux fois sur un réseau.',
                ],
            },
        },
    }),
    T({
        key: 'orders',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Orders: see, pay, cancel, confirm delivery',
                summary: 'See an order, pay an unpaid one, cancel, confirm delivery, cash-on-delivery code',
                steps: [
                    'Open Account → "My orders" and tap the order (one entry per checkout, with one card per seller).',
                    'Unpaid: tap "Pay {amount}", choose a method and confirm. "Already paid? Check now" re-checks a payment.',
                    'To cancel: tap "Cancel order" on the seller\'s card, then confirm.',
                    'To confirm you received it: tap "I received this parcel" on the parcel, or "Confirm delivery" on the order.',
                    'Cash on delivery: the code card is on the order. Give the code to the courier only AFTER you have the parcel and have paid. "Send a new code" if needed.',
                ],
                notes: [
                    'Cancel is only offered while the order is unpaid and not yet shipped. A paid or shipped order goes through the seller\'s refund process: open a support request of type "Refund".',
                    'Orders from several sellers ship separately and can arrive on different days.',
                ],
            },
            fr: {
                title: 'Commandes : voir, payer, annuler, confirmer la livraison',
                summary: 'Voir une commande, payer, annuler, confirmer la livraison, code de paiement à la livraison',
                steps: [
                    'Ouvrez Compte → « Mes commandes » et appuyez sur la commande (une entrée par paiement, une carte par vendeur).',
                    'Non payée : appuyez sur « Payer {montant} », choisissez un moyen et confirmez. « Déjà payé ? Vérifier maintenant » revérifie un paiement.',
                    'Pour annuler : appuyez sur « Annuler la commande » sur la carte du vendeur, puis confirmez.',
                    'Pour confirmer la réception : appuyez sur « J’ai reçu ce colis » sur le colis, ou « Confirmer la livraison » sur la commande.',
                    'Paiement à la livraison : la carte du code est sur la commande. Donnez le code au livreur seulement APRÈS avoir reçu le colis et payé. « Envoyer un nouveau code » si besoin.',
                ],
                notes: [
                    'L’annulation n’est proposée que si la commande n’est ni payée ni expédiée. Une commande payée ou expédiée passe par le remboursement du vendeur : ouvrez une demande d’assistance de type « Remboursement ».',
                    'Les commandes de plusieurs vendeurs sont expédiées séparément et peuvent arriver à des jours différents.',
                ],
            },
        },
    }),
    T({
        key: 'tracking',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Tracking a delivery on the map',
                summary: 'Follow a parcel live on the map',
                steps: [
                    'Open Account → "My orders" → tap the order.',
                    'Each parcel on its way shows a live map with the arrival time; "Open in maps" opens it in your maps app.',
                    'The delivery company\'s Call / WhatsApp buttons are on the parcel.',
                ],
                notes: ['Nothing shows until the parcel has left: "Nothing on the road yet". Downloads have nothing to track.'],
            },
            fr: {
                title: 'Suivre une livraison sur la carte',
                summary: 'Suivre un colis en direct sur la carte',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → appuyez sur la commande.',
                    'Chaque colis en route affiche une carte en direct avec l’heure d’arrivée ; « Ouvrir dans Maps » l’ouvre dans votre application de cartes.',
                    'Les boutons Appeler / WhatsApp de la société de livraison sont sur le colis.',
                ],
                notes: ['Rien ne s’affiche tant que le colis n’est pas parti. Les téléchargements n’ont rien à suivre.'],
            },
        },
    }),
    T({
        key: 'paylink',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Letting someone else pay (payment link)',
                summary: 'Send a card payment link so someone else pays an order',
                steps: [
                    'Open Account → "My orders" → the order → "Pay {amount}".',
                    'Under "Someone else paying?" tap "Send a payment link" and share it. They pay by card, with no account.',
                    '"Send a new link" replaces it; the old link then stops working.',
                ],
                notes: ['Card only, and not for cash-on-delivery orders or while a mobile-money prompt is still waiting.'],
            },
            fr: {
                title: 'Faire payer quelqu’un d’autre (lien de paiement)',
                summary: 'Envoyer un lien de paiement par carte pour qu’une autre personne paie',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande → « Payer {montant} ».',
                    'Sous « Quelqu’un d’autre paie ? » appuyez sur « Envoyer un lien de paiement » et partagez-le. La personne paie par carte, sans compte.',
                    '« Envoyer un nouveau lien » le remplace ; l’ancien ne marche plus.',
                ],
                notes: ['Carte uniquement, et pas pour un paiement à la livraison ni pendant qu’une demande mobile money attend.'],
            },
        },
    }),
    T({
        key: 'bookings',
        path: '/shop/account/bookings',
        signIn: true,
        copy: {
            en: {
                title: 'Bookings: book, pay, move, cancel',
                summary: 'Book a service, pay for a booking, move it to another time or cancel it',
                steps: [
                    'To book: open the service, pick a time, add a note if you want, then tap "Book · {price}". The time is held for about 15 minutes.',
                    'Open Account → "My bookings" and tap the booking.',
                    '"Pay now" — available once the seller has accepted. Unpaid bookings are released after a while.',
                    '"Move to another time" → pick a new time → "Move my booking".',
                    '"Cancel booking" → "Cancel it".',
                    '"Pay the balance" appears if the final price ended up higher than quoted.',
                ],
                notes: [
                    'Move and cancel are only possible while the booking is awaiting the seller or confirmed, and within the seller\'s cancellation window.',
                    'Refunds follow the seller\'s policy.',
                ],
            },
            fr: {
                title: 'Réservations : réserver, payer, déplacer, annuler',
                summary: 'Réserver un service, payer, déplacer à un autre moment ou annuler',
                steps: [
                    'Pour réserver : ouvrez le service, choisissez un horaire, ajoutez une note si vous voulez, puis « Réserver · {prix} ». L’horaire est retenu environ 15 minutes.',
                    'Ouvrez Compte → « Mes réservations » et appuyez sur la réservation.',
                    '« Payer maintenant » — possible une fois que le vendeur a accepté. Les réservations non payées sont libérées au bout d’un moment.',
                    '« Déplacer à un autre moment » → choisissez un horaire → « Déplacer ma réservation ».',
                    '« Annuler la réservation » → « L’annuler ».',
                    '« Payer le solde » apparaît si le prix final est plus élevé que prévu.',
                ],
                notes: [
                    'Déplacer ou annuler n’est possible que si la réservation attend le vendeur ou est confirmée, et dans le délai d’annulation du vendeur.',
                    'Les remboursements suivent la politique du vendeur.',
                ],
            },
        },
    }),
    T({
        key: 'downloads',
        path: '/shop/account/downloads',
        signIn: true,
        copy: {
            en: {
                title: 'Downloading a digital purchase',
                summary: 'Download a digital product that was bought',
                steps: ['Open Account → "My downloads" and tap "Download" on the item.'],
                notes: [
                    'Items appear as soon as payment clears. Each one shows how many downloads are left and until when.',
                    'An expired or revoked item can no longer be downloaded.',
                ],
            },
            fr: {
                title: 'Télécharger un achat numérique',
                summary: 'Télécharger un produit numérique acheté',
                steps: ['Ouvrez Compte → « Mes téléchargements » et appuyez sur « Télécharger ».'],
                notes: [
                    'Les articles apparaissent dès que le paiement est confirmé, avec le nombre de téléchargements restants et la date limite.',
                    'Un article expiré ou révoqué ne peut plus être téléchargé.',
                ],
            },
        },
    }),
    T({
        key: 'reviews',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Rating a product or a delivery',
                summary: 'Write a review of a product, a booking or a delivery',
                steps: [
                    'Open Account → "My orders" → the completed order (or the completed booking).',
                    'Tap "Rate this" on the item, or "Rate the delivery" on the parcel.',
                    'Choose 1 to 5 stars, optionally add a title and a few words, then tap "Submit".',
                    'Your reviews are listed under Account → "My reviews".',
                ],
                notes: ['Only once the order is complete, one review per item, and a review cannot be edited later. Reviews with text are checked before they appear.'],
            },
            fr: {
                title: 'Noter un produit ou une livraison',
                summary: 'Laisser un avis sur un produit, une réservation ou une livraison',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande terminée (ou la réservation terminée).',
                    'Appuyez sur « Donner un avis » sur l’article, ou « Noter la livraison » sur le colis.',
                    'Choisissez de 1 à 5 étoiles, ajoutez si vous voulez un titre et un texte, puis « Valider ».',
                    'Vos avis sont listés dans Compte → « Mes avis ».',
                ],
                notes: ['Seulement une fois la commande terminée, un avis par article, et un avis ne peut pas être modifié. Les avis avec texte sont vérifiés avant publication.'],
            },
        },
    }),
    T({
        key: 'saved',
        path: '/shop/saved',
        signIn: false,
        copy: {
            en: {
                title: 'Saved products (favourites) and recently viewed',
                summary: 'See saved products and recently viewed ones',
                steps: [
                    'Tap the heart on any product to save it.',
                    'Open the "Saved" tab: "Saved" shows your favourites, "Recently viewed" what you looked at ("Clear history" empties it).',
                ],
                notes: ['Signed out, favourites stay on that device only; sign in to keep them on your account.'],
            },
            fr: {
                title: 'Produits favoris et vus récemment',
                summary: 'Voir les produits favoris et ceux vus récemment',
                steps: [
                    'Appuyez sur le cœur d’un produit pour l’ajouter aux favoris.',
                    'Ouvrez l’onglet « Favoris » : « Favoris » montre vos produits, « Vus récemment » ce que vous avez consulté (« Effacer l’historique » le vide).',
                ],
                notes: ['Sans connexion, les favoris restent sur cet appareil ; connectez-vous pour les garder sur votre compte.'],
            },
        },
    }),
    T({
        key: 'notifications',
        path: '/shop/account/notifications/settings',
        signIn: true,
        copy: {
            en: {
                title: 'Notification settings and connecting WhatsApp / Telegram',
                summary: 'Choose which messages arrive and where; connect WhatsApp or Telegram',
                steps: [
                    'Tap the bell at the top of the shop, then the gear icon.',
                    'Under "Delivery channel" pick ONE extra channel (Email, Telegram or WhatsApp); turning one on turns the others off.',
                    'Under "What you hear about" switch Order updates, Booking updates, Booking reminders or Offers & news on or off.',
                    'To connect a chat app: under "Chat channels" tap "Connect", send /connect to that app\'s Wi-Mall chat, type the 6-character code, then tap "Connect".',
                ],
                notes: [
                    'Payments & refunds and cancellations are always sent.',
                    'A channel must be connected or verified before it can be chosen. The /connect code lasts 10 minutes.',
                ],
            },
            fr: {
                title: 'Réglages des notifications et connexion WhatsApp / Telegram',
                summary: 'Choisir quels messages arrivent et où ; connecter WhatsApp ou Telegram',
                steps: [
                    'Appuyez sur la cloche en haut de la boutique, puis sur l’engrenage.',
                    'Sous « Canal de réception », choisissez UN canal en plus (E-mail, Telegram ou WhatsApp) ; en activer un désactive les autres.',
                    'Sous les sujets, activez ou désactivez les mises à jour de commandes, de réservations, les rappels et les offres.',
                    'Pour connecter une messagerie : sous « Messageries », appuyez sur « Connecter », envoyez /connect au chat Wi-Mall de cette application, saisissez le code à 6 caractères, puis « Connecter ».',
                ],
                notes: [
                    'Les paiements, remboursements et annulations sont toujours envoyés.',
                    'Un canal doit être connecté ou vérifié avant de pouvoir être choisi. Le code /connect dure 10 minutes.',
                ],
            },
        },
    }),
    T({
        key: 'emailphone',
        path: '/shop/account/security',
        signIn: true,
        copy: {
            en: {
                title: 'Changing the sign-in email or phone number',
                summary: 'Change the email or phone number the account signs in with',
                steps: [
                    'Open Account → "Sign-in details".',
                    'Email: type the "New email address", tap "Change", then open the confirmation link sent to that new address.',
                    'Phone: type the new number (+237…), tap "Change", then type the 6-digit code that arrives on WhatsApp and tap "Confirm".',
                ],
                notes: [
                    'The old email or number keeps working until the change is confirmed; "Cancel this change" abandons it.',
                    'If the phone code never arrives, contact support from that page.',
                ],
            },
            fr: {
                title: 'Changer l’e-mail ou le numéro de connexion',
                summary: 'Changer l’e-mail ou le numéro de téléphone du compte',
                steps: [
                    'Ouvrez Compte → « Identifiants de connexion ».',
                    'E-mail : saisissez la nouvelle adresse, appuyez sur « Modifier », puis ouvrez le lien de confirmation envoyé à cette nouvelle adresse.',
                    'Téléphone : saisissez le nouveau numéro (+237…), appuyez sur « Modifier », puis saisissez le code à 6 chiffres reçu sur WhatsApp et « Confirmer ».',
                ],
                notes: [
                    'L’ancien e-mail ou numéro reste valable jusqu’à la confirmation ; « Annuler ce changement » l’abandonne.',
                    'Si le code n’arrive jamais, contactez l’assistance depuis cette page.',
                ],
            },
        },
    }),
    T({
        key: 'support',
        path: '/shop/account/support/new',
        signIn: true,
        copy: {
            en: {
                title: 'Opening a support request (ticket)',
                summary: 'Open a support request, reply to one, or close it',
                steps: [
                    'Open Account → "Support" → "New".',
                    'Choose what it is about (an order, a product or something else) and pick the order or product.',
                    'Choose the "Type" (e.g. Refund, Late delivery) and how urgent it is.',
                    'Write a subject and what happened, add photos or a video if useful, then tap "Open ticket".',
                    'Open tickets are under Account → "Support": reply there, or tap "Close ticket".',
                ],
                notes: [
                    'Urgency cannot be changed later. Some sellers require a photo, video or tracking number.',
                    'A closed ticket cannot be replied to — open a new one.',
                ],
            },
            fr: {
                title: 'Ouvrir une demande d’assistance (ticket)',
                summary: 'Ouvrir une demande d’assistance, y répondre ou la fermer',
                steps: [
                    'Ouvrez Compte → « Assistance » → « Nouveau ».',
                    'Choisissez le sujet (une commande, un produit ou autre chose) puis la commande ou le produit.',
                    'Choisissez le « Type » (ex. Remboursement, Livraison en retard) et l’urgence.',
                    'Écrivez un sujet et ce qui s’est passé, ajoutez des photos ou une vidéo si utile, puis « Ouvrir le ticket ».',
                    'Les tickets ouverts sont dans Compte → « Assistance » : répondez-y, ou « Fermer le ticket ».',
                ],
                notes: [
                    'L’urgence ne peut pas être modifiée ensuite. Certains vendeurs exigent une photo, une vidéo ou un numéro de suivi.',
                    'Un ticket fermé ne peut plus recevoir de réponse — ouvrez-en un nouveau.',
                ],
            },
        },
    }),
    T({
        key: 'checkout',
        path: '/shop/cart',
        signIn: false,
        copy: {
            en: {
                title: 'Buying on the website: cart and checkout',
                summary: 'Pay for the cart on the website instead of in the chat',
                steps: [
                    'Open the "Cart" tab, adjust quantities, then tap "Checkout".',
                    'Pick a "Delivery address" (or "Add an address").',
                    'Pick a "Payment method": MTN Mobile Money, Orange Money, Moov Money, Card or Cash on delivery; for mobile money enter the number.',
                    'Tap "Pay {amount}" (or "Place order" for cash on delivery) and approve the prompt on your phone.',
                ],
                notes: [
                    'A cart holds either physical items or a single digital product; services are booked, not added to a cart.',
                    'Each seller may require a minimum order. Cash on delivery is not offered for digital products or above the cash limit.',
                    'The cart is the same in this chat and on the website once you are signed in.',
                ],
            },
            fr: {
                title: 'Acheter sur le site : panier et paiement',
                summary: 'Payer le panier sur le site plutôt que dans le chat',
                steps: [
                    'Ouvrez l’onglet « Panier », ajustez les quantités, puis appuyez sur « Commander ».',
                    'Choisissez une « Adresse de livraison » (ou « Ajouter une adresse »).',
                    'Choisissez un « Moyen de paiement » : MTN Mobile Money, Orange Money, Moov Money, Carte bancaire ou Paiement à la livraison ; pour le mobile money, saisissez le numéro.',
                    'Appuyez sur « Payer {montant} » (ou « Passer la commande » pour le paiement à la livraison) et validez sur votre téléphone.',
                ],
                notes: [
                    'Un panier contient soit des articles physiques, soit un seul produit numérique ; les services se réservent, ils ne vont pas au panier.',
                    'Chaque vendeur peut exiger un minimum de commande. Le paiement à la livraison n’est pas proposé pour le numérique ni au-delà du plafond.',
                    'Une fois connecté, le panier est le même dans ce chat et sur le site.',
                ],
            },
        },
    }),
    T({
        key: 'closeaccount',
        path: '/shop/account/close',
        signIn: true,
        copy: {
            en: {
                title: 'Closing the account',
                summary: 'Close the customer account for good',
                steps: [
                    'Open Account → the ⋮ menu at the top right → "Close account".',
                    'Type CLOSE MY ACCOUNT exactly (in English, whatever the language), then tap "Close my account".',
                ],
                notes: [
                    'It cannot be undone, and downloads stop being available. Past orders are kept anonymously.',
                    'Refused while orders are still in progress, or if the account also sells or delivers (then only support can close it).',
                ],
            },
            fr: {
                title: 'Fermer le compte',
                summary: 'Fermer définitivement le compte client',
                steps: [
                    'Ouvrez Compte → le menu ⋮ en haut à droite → « Fermer le compte ».',
                    'Tapez exactement CLOSE MY ACCOUNT (en anglais, quelle que soit la langue), puis « Fermer mon compte ».',
                ],
                notes: [
                    'C’est définitif, et les téléchargements ne sont plus disponibles. Les commandes passées sont conservées de façon anonyme.',
                    'Refusé tant que des commandes sont en cours, ou si le compte vend ou livre aussi (seule l’assistance peut alors le fermer).',
                ],
            },
        },
    }),
    T({
        key: 'browse',
        path: '/shop',
        signIn: false,
        copy: {
            en: {
                title: 'Browsing and searching the shop',
                summary: 'Search the catalogue with filters, visit a store',
                steps: [
                    'Open the "Shop" tab and type in the search box, then submit.',
                    'Tap "Filters" to narrow by category, product type (Physical, Digital, Service), maximum price or "In stock only", and choose a sort order.',
                    'Tap a store name, or "View store", to see everything one seller offers.',
                ],
                notes: ['Search matches whole words. Product text is written by the seller and is not translated.'],
            },
            fr: {
                title: 'Parcourir et rechercher dans la boutique',
                summary: 'Chercher avec des filtres, visiter une boutique',
                steps: [
                    'Ouvrez l’onglet « Boutique », tapez dans la recherche, puis validez.',
                    'Appuyez sur « Filtres » pour trier par catégorie, type (Physique, Numérique, Service), prix maximum ou « En stock uniquement », et choisissez un ordre.',
                    'Appuyez sur le nom d’une boutique, ou « Voir la boutique », pour voir tout ce qu’un vendeur propose.',
                ],
                notes: ['La recherche porte sur des mots entiers. Les textes des produits sont écrits par le vendeur et ne sont pas traduits.'],
            },
        },
    }),
    T({
        key: 'help',
        path: '/faq',
        signIn: false,
        copy: {
            en: {
                title: 'Help, FAQ and contacting the team',
                summary: 'Frequently asked questions and the contact form',
                steps: [
                    'The FAQ answers common questions (Account → "Help & FAQ").',
                    'To write to the team, use the contact page: https://wi-mall.com/contact — or email support@wi-mall.com.',
                    'For a problem with an order, a support request (topic support) is faster.',
                ],
                notes: [],
            },
            fr: {
                title: 'Aide, FAQ et contacter l’équipe',
                summary: 'Questions fréquentes et formulaire de contact',
                steps: [
                    'La FAQ répond aux questions courantes (Compte → « Aide & FAQ »).',
                    'Pour écrire à l’équipe, utilisez la page contact : https://wi-mall.com/fr/contact — ou support@wi-mall.com.',
                    'Pour un problème de commande, une demande d’assistance (sujet support) est plus rapide.',
                ],
                notes: [],
            },
        },
    }),
]);

export const WEBSITE_GUIDE_KEYS: readonly string[] = Object.freeze(WEBSITE_GUIDE.map((t) => t.key));

function guideLanguage(language: string | null | undefined): GuideLanguage {
    return String(language ?? '').slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
}

const LABELS: Readonly<Record<GuideLanguage, { link: string; steps: string; notes: string; signIn: string; noSignIn: string; topics: string; unknown: string }>> = Object.freeze({
    en: {
        link: 'LINK',
        steps: 'STEPS',
        notes: 'GOOD TO KNOW',
        signIn: 'SIGN-IN: needed. If they are not signed in on the website, offer to send them a sign-in link (auth_send_login_link) first.',
        noSignIn: 'SIGN-IN: not needed.',
        topics: 'WEBSITE GUIDE — topics (call again with one of these keys):',
        unknown: 'No topic by that name.',
    },
    fr: {
        link: 'LIEN',
        steps: 'ÉTAPES',
        notes: 'BON À SAVOIR',
        signIn: 'CONNEXION : nécessaire. S’ils ne sont pas connectés sur le site, proposez d’abord de leur envoyer un lien de connexion (auth_send_login_link).',
        noSignIn: 'CONNEXION : pas nécessaire.',
        topics: 'GUIDE DU SITE — sujets (rappelez avec une de ces clés) :',
        unknown: 'Aucun sujet de ce nom.',
    },
});

/**
 * One topic, as the text the tool returns — or the topic list, for a key it does not know.
 *
 * ⚠ **An unknown key answers the LIST, never an error.** The caller is a model choosing from a
 * description; a refusal would leave it guessing again, while the list lets it pick correctly on
 * the next call. Same reasoning as a stale button answering with the current state.
 */
export function renderWebsiteGuide(
    key: string | null | undefined,
    language: string | null | undefined,
    baseUrl?: string | null,
): string {
    const lang = guideLanguage(language);
    const labels = LABELS[lang];
    const topic = WEBSITE_GUIDE.find((t) => t.key === String(key ?? '').toLowerCase());

    if (!topic) {
        return [
            ...(key ? [labels.unknown, ''] : []),
            labels.topics,
            ...WEBSITE_GUIDE.map((t) => `- ${t.key}: ${t.copy[lang].summary}`),
        ].join('\n');
    }

    const copy = topic.copy[lang];
    // The customer's OWN language for the link, even where the text falls back to English.
    const link = storefrontUrl(topic.path, language ?? lang, baseUrl === undefined ? process.env.STOREFRONT_URL : baseUrl);

    return [
        copy.title.toUpperCase(),
        `${labels.link}: ${link ?? '(the website address is not configured — describe the steps only)'}`,
        topic.signIn ? labels.signIn : labels.noSignIn,
        '',
        `${labels.steps}:`,
        ...copy.steps.map((s, i) => `${i + 1}. ${s}`),
        ...(copy.notes.length ? ['', `${labels.notes}:`, ...copy.notes.map((n) => `- ${n}`)] : []),
    ].join('\n');
}
