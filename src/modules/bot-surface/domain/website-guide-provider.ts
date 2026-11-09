import { GuideTopic, T } from './website-guide-types';

/**
 * The website guide — the vendor dashboard as a SERVICE PROVIDER sees it (2026-11-09, owner RS-4:
 * "written when the vendor-dash provider screens ship, from the real labels").
 *
 * A provider uses the same app as a seller (vendor.wi-mall.com and the Android app) with a
 * different menu: no orders, products, store or search, and three sections of their own —
 * listings, leads and listing settings. So these topics live in the `vendor` app's list, beside
 * the seller topics, and each title starts "Service provider:" so the model can tell them apart.
 *
 * Read from `frontend/vendor-dash` on 2026-11-09 (production `6d2cdeba`): `config/navigation.ts`
 * (`PROVIDER_PRIMARY_NAV`, `PROVIDER_FOOTER_NAV`, `PROVIDER_TAB_PATHS`), `config/quickActions.ts`
 * (`PROVIDER_QUICK_ACTIONS`), the provider route table in `DashboardShell.tsx`, and
 * `i18n/locales/{en,fr}/{nav,listings,billing,auth}.ts`; sign-up on the web from
 * `frontend/landing` `messages/{en,fr}.json` (`auth.vendorKind`). Labels are QUOTED. Credit
 * prices are never written here: the dashboard reads them from the server, and so must the
 * assistant ("costs credits", shown on the button).
 *
 * ⚠ Not described, because the dashboard does not have it yet: a list of a listing's reviews.
 * A review arrives as a notification ("New review"), which is all a provider can see today.
 */
export const PROVIDER_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'vendorprovidermenu',
        app: 'vendor',
        path: '/dashboard/listings',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: the map of the dashboard',
                summary: 'Where things are for a service provider: sidebar, phone bar, "+" menu',
                steps: [
                    'COMPUTER — left sidebar: "Service listings", "Leads", "Plans & credits", "Credit history", "Photos", "Notifications", "Tickets". At the bottom: "Account" ("Profile", "Verification", "Security") and "Settings" ("Listing settings", "Notifications").',
                    'PHONE or APP — bottom bar: "Listings", "Leads", a round "+", "Credits", "More". "More" holds everything else, including Account and Settings.',
                    'The "+" button ("Create") has "New listing", "Buy credits", "New ticket" and "Upload photos".',
                    'The dashboard opens on "Service listings".',
                ],
                notes: [
                    'A service provider has no orders, products, store, customers list or search: those are for sellers. Seller help about them does not apply.',
                    'A customer\'s review of a listing arrives under "Notifications". There is no reviews page in the dashboard yet.',
                ],
            },
            fr: {
                title: 'Prestataire de services : le plan du tableau de bord',
                summary: 'Où sont les choses pour un prestataire : barre latérale, barre du téléphone, menu « + »',
                steps: [
                    'ORDINATEUR — barre latérale gauche : « Annonces de service », « Contacts reçus », « Forfaits et crédits », « Historique des crédits », « Photos », « Notifications », « Tickets ». En bas : « Compte » (« Profil », « Vérification », « Sécurité ») et « Paramètres » (« Réglages des annonces », « Notifications »).',
                    'TÉLÉPHONE ou APP — barre du bas : « Annonces », « Contacts reçus », un « + » rond, « Crédits », « Plus ». « Plus » contient tout le reste, dont Compte et Paramètres.',
                    'Le bouton « + » (« Créer ») contient « Nouvelle annonce », « Acheter des crédits », « Nouveau ticket » et « Importer des photos ».',
                    'Le tableau de bord s’ouvre sur « Annonces de service ».',
                ],
                notes: [
                    'Un prestataire de services n’a ni commandes, ni produits, ni boutique, ni liste de clients, ni recherche : c’est pour les vendeurs. L’aide vendeur qui en parle ne s’applique pas.',
                    'L’avis d’un client sur une annonce arrive dans « Notifications ». Il n’y a pas encore de page des avis dans le tableau de bord.',
                ],
            },
        },
    }),
    T({
        key: 'vendorprovidersignup',
        app: 'vendor',
        path: '/login',
        signIn: false,
        copy: {
            en: {
                title: 'Service provider: creating an account to advertise a service business',
                summary: 'Sign up as a service provider (plumber, printer, repairer…) instead of a seller',
                steps: [
                    'Sign up as a vendor: on the website at https://wi-mall.com/register?role=vendor, or in the Android app with "Create a vendor account" (the steps are in topic vendorsignin).',
                    'At "What will you do on Wi-Mall?" choose "Advertise a service business": customers find you and unlock your contacts, you pay per contact in credits, no orders and no commission.',
                    'Finish the form and create the account. The dashboard opens on "Service listings", with nothing else to set up first.',
                    'Then create your first listing (topic vendorlistingcreate).',
                ],
                notes: [
                    '"You can’t change this choice later." A business that also wants to sell products needs a separate seller account.',
                    'Your country is set from your phone number when you sign up, and cannot be changed afterwards.',
                ],
            },
            fr: {
                title: 'Prestataire de services : créer un compte pour annoncer une activité de service',
                summary: 'S’inscrire comme prestataire (plombier, imprimeur, réparateur…) au lieu de vendeur',
                steps: [
                    'Inscrivez-vous comme vendeur : sur le site https://wi-mall.com/fr/register?role=vendor, ou dans l’app Android avec « Créer un compte vendeur » (les étapes sont dans le sujet vendorsignin).',
                    'À « Que ferez-vous sur Wi-Mall ? », choisissez « Annoncer une activité de service » : les clients vous trouvent et débloquent vos contacts, vous payez par contact en crédits, sans commandes ni commission.',
                    'Terminez le formulaire et créez le compte. Le tableau de bord s’ouvre sur « Annonces de service », sans autre configuration avant.',
                    'Créez ensuite votre première annonce (sujet vendorlistingcreate).',
                ],
                notes: [
                    '« Ce choix ne pourra plus être modifié ensuite. » Une entreprise qui veut aussi vendre des produits a besoin d’un compte vendeur séparé.',
                    'Votre pays est fixé d’après votre numéro de téléphone à l’inscription, et ne peut plus être modifié ensuite.',
                ],
            },
        },
    }),
    T({
        key: 'vendorlistingcreate',
        app: 'vendor',
        path: '/dashboard/listings/new',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: creating a listing and sending it for review',
                summary: 'Create a service listing, add hidden contacts, submit it for review',
                steps: [
                    '"Service listings" → "New listing" (or "+" → "New listing").',
                    '"What customers see": "Photos", "Title", "Business name", "Description" (at least 20 characters, no phone numbers, emails or links), "Categories"; "Where you work": "Country", "City", "Neighbourhood"; optional "Opening hours".',
                    '"Contact info" (hidden until a customer taps to unlock): "WhatsApp number", "Phone number", "Second phone number", "Email", "Website", "Social pages", "Exact location" (search your address), "Video link" (YouTube "Unlisted" or Google Drive "Anyone with the link"). At least one is needed.',
                    '"Save draft" keeps it unfinished. "Submit for review" sends it to Wi-Mall; the button shows its cost in credits. You are told when it is approved or not.',
                ],
                notes: [
                    'The review cost is returned if the listing is not approved or you withdraw it.',
                    'Customers who unlock "Phone" see both numbers, for one charge.',
                    'A listing goes live only after Wi-Mall approves it. Contacts never appear on the public page.',
                ],
            },
            fr: {
                title: 'Prestataire de services : créer une annonce et l’envoyer pour vérification',
                summary: 'Créer une annonce de service, ajouter les contacts cachés, l’envoyer pour vérification',
                steps: [
                    '« Annonces de service » → « Nouvelle annonce » (ou « + » → « Nouvelle annonce »).',
                    '« Ce que voient les clients » : « Photos », « Titre », « Nom de l’entreprise », « Description » (au moins 20 caractères, sans numéros, e-mails ni liens), « Catégories » ; « Où vous travaillez » : « Pays », « Ville », « Quartier » ; « Horaires d’ouverture » facultatifs.',
                    '« Coordonnées » (cachées jusqu’à ce qu’un client appuie pour les débloquer) : « Numéro WhatsApp », « Numéro de téléphone », « Deuxième numéro de téléphone », « E-mail », « Site web », « Réseaux sociaux », « Emplacement exact » (cherchez votre adresse), « Lien vidéo » (YouTube « Non répertoriée » ou Google Drive « Tous les utilisateurs disposant du lien »). Il en faut au moins une.',
                    '« Enregistrer le brouillon » la garde inachevée. « Envoyer pour vérification » l’envoie à Wi-Mall ; le bouton indique son coût en crédits. Vous êtes prévenu quand elle est approuvée ou refusée.',
                ],
                notes: [
                    'Le coût de la vérification est rendu si l’annonce est refusée ou si vous la retirez.',
                    'Les clients qui débloquent « Téléphone » voient les deux numéros, pour un seul paiement.',
                    'Une annonce n’est en ligne qu’après l’approbation de Wi-Mall. Les coordonnées n’apparaissent jamais sur la page publique.',
                ],
            },
        },
    }),
    T({
        key: 'vendorlistingstatus',
        app: 'vendor',
        path: '/dashboard/listings',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: a listing\'s status, editing a live listing, pausing and archiving',
                summary: 'What Draft, Live, Paused mean; edit, withdraw, archive; search your listings',
                steps: [
                    '"Service listings" shows each listing\'s status: "Draft", "Waiting for review", "Not approved" (open it for "What the reviewer said"), "Live", "Paused", "Archived". Use "Search your listings" and the "Status" filter to find one.',
                    'Editing a live listing: open it, change it, "Save changes", then "Submit for review". It shows "Changes waiting for review" and the approved version stays live meanwhile. "Discard changes" drops them.',
                    'While waiting for review it cannot be edited: "Withdraw from review" first (the credits come back).',
                    '"Archive" closes a listing for good: customers no longer find it, and it cannot be undone.',
                ],
                notes: [
                    '"Paused — out of credits": top up and it comes back on its own. "Paused — over your plan’s limit": upgrade ("See plans") or archive another listing. "Taken offline by Wi-Mall": only Wi-Mall can put it back ("Contact support").',
                ],
            },
            fr: {
                title: 'Prestataire de services : le statut d’une annonce, modifier une annonce en ligne, pause et archivage',
                summary: 'Ce que signifient Brouillon, En ligne, En pause ; modifier, retirer, archiver ; chercher',
                steps: [
                    '« Annonces de service » montre le statut de chaque annonce : « Brouillon », « En attente de vérification », « Refusée » (ouvrez-la pour « Ce qu’a dit le vérificateur »), « En ligne », « En pause », « Archivée ». Utilisez « Rechercher dans vos annonces » et le filtre « Statut » pour en trouver une.',
                    'Modifier une annonce en ligne : ouvrez-la, modifiez, « Enregistrer », puis « Envoyer pour vérification ». Elle indique « Modifications en attente de vérification » et la version approuvée reste en ligne en attendant. « Annuler les modifications » les abandonne.',
                    'Pendant la vérification, elle ne peut pas être modifiée : « Retirer de la vérification » d’abord (les crédits sont rendus).',
                    '« Archiver » ferme une annonce définitivement : les clients ne la trouvent plus, et c’est irréversible.',
                ],
                notes: [
                    '« En pause — plus de crédits » : rechargez et elle revient toute seule. « En pause — au-delà de la limite de votre forfait » : passez à un forfait supérieur (« Voir les forfaits ») ou archivez une autre annonce. « Mise hors ligne par Wi-Mall » : seul Wi-Mall peut la remettre (« Contacter le support »).',
                ],
            },
        },
    }),
    T({
        key: 'vendorleads',
        app: 'vendor',
        path: '/dashboard/leads',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: leads, asking a customer to call, sending a message',
                summary: 'See who unlocked your contacts; "Ask them to call me"; "Send a message"',
                steps: [
                    'Open "Leads": each customer who unlocked a contact, shown as first name, initial and part of the number, with what they unlocked ("Unlocked"), when, and the cost. Filter with "Listing".',
                    '"Ask them to call me" sends the customer your business name and your FIRST phone number. It costs credits, shown before you tap "Send", and they come back if it cannot be delivered.',
                    '"Send a message" writes to the customer through Wi-Mall; they answer you directly on your WhatsApp.',
                    'Each lead shows how many messages are left ("messages left").',
                ],
                notes: [
                    'Both buttons need the customer\'s agreement first ("Needs the customer’s opt-in"). At most 3 messages per customer in 30 days, one of them a call request.',
                    'On WhatsApp a written message is possible only within 24 hours of the customer\'s last message to Wi-Mall ("Messages are closed for now"). That is WhatsApp\'s rule; "Ask them to call me" still works.',
                    'You never get the customer\'s full name or number through Wi-Mall.',
                ],
            },
            fr: {
                title: 'Prestataire de services : contacts reçus, demander à être appelé, envoyer un message',
                summary: 'Voir qui a débloqué vos contacts ; « Lui demander de m’appeler » ; « Envoyer un message »',
                steps: [
                    'Ouvrez « Contacts reçus » : chaque client qui a débloqué un contact, affiché par son prénom, une initiale et une partie du numéro, avec ce qu’il a débloqué (« Débloqué »), quand, et le coût. Filtrez avec « Annonce ».',
                    '« Lui demander de m’appeler » envoie au client le nom de votre entreprise et votre PREMIER numéro de téléphone. Cela coûte des crédits, indiqués avant « Envoyer », rendus si le message n’a pas pu être remis.',
                    '« Envoyer un message » écrit au client via Wi-Mall ; il vous répond directement sur votre WhatsApp.',
                    'Chaque contact indique combien de messages restent (« messages restants »).',
                ],
                notes: [
                    'Les deux boutons demandent d’abord l’accord du client (« Le client doit d’abord accepter vos messages »). Au plus 3 messages par client sur 30 jours, dont une demande d’appel.',
                    'Sur WhatsApp, un message écrit n’est possible que dans les 24 heures suivant le dernier message du client à Wi-Mall (« Messages fermés pour l’instant »). C’est une règle de WhatsApp ; « Lui demander de m’appeler » reste possible.',
                    'Vous n’obtenez jamais le nom complet ni le numéro du client via Wi-Mall.',
                ],
            },
        },
    }),
    T({
        key: 'vendorleadreport',
        app: 'vendor',
        path: '/dashboard/leads',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: reporting a lead, getting unlocks refunded',
                summary: 'Report an abusive or mistaken unlock and ask for a refund in credits',
                steps: [
                    '"Leads" → on the customer → "Report".',
                    'At "What do you need?" choose "Refund these unlocks", "Check this customer", or both.',
                    'For a refund, pick the unlocks at "Which unlocks?". At "What happened?" explain in a few sentences (the box shows the length allowed), then "Send report".',
                    'A support ticket opens and its number is shown. Wi-Mall replies there.',
                ],
                notes: [
                    'One open report per lead at a time ("Report open"). Wi-Mall decides after looking; refunds come back as credits.',
                    'Wi-Mall never limits unlocks automatically, so a real customer is never turned away; reporting is how abuse is stopped.',
                ],
            },
            fr: {
                title: 'Prestataire de services : signaler un contact, se faire rembourser des déblocages',
                summary: 'Signaler un déblocage abusif ou par erreur et demander un remboursement en crédits',
                steps: [
                    '« Contacts reçus » → sur le client → « Signaler ».',
                    'À « De quoi avez-vous besoin ? », choisissez « Rembourser ces déblocages », « Vérifier ce client », ou les deux.',
                    'Pour un remboursement, cochez les déblocages à « Quels déblocages ? ». À « Que s’est-il passé ? », expliquez en quelques phrases (la case indique la longueur permise), puis « Envoyer le signalement ».',
                    'Un ticket de support s’ouvre et son numéro s’affiche. Wi-Mall répond dans ce ticket.',
                ],
                notes: [
                    'Un seul signalement ouvert à la fois par contact (« Signalement en cours »). Wi-Mall décide après examen ; les remboursements reviennent en crédits.',
                    'Wi-Mall ne limite jamais les déblocages automatiquement, pour ne jamais refuser un vrai client ; le signalement est ce qui arrête les abus.',
                ],
            },
        },
    }),
    T({
        key: 'vendorcredits',
        app: 'vendor',
        path: '/dashboard/account/billing',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: credits, what an unlock costs, plans',
                summary: 'Buy credits, read the balance and credit history, change plan',
                steps: [
                    'Open "Plans & credits" (phone: "Credits"). The "Credit wallet" shows the balance; "Top up" → choose a pack → "Buy" and pay.',
                    'The page states the charging rule with today\'s prices: the first contact a customer unlocks costs one price, each further one less, and the same contact again is free for 30 days.',
                    'Plans set how many listings can be live at once and include credits each term; "Choose plan" changes plan.',
                    '"Credit history" lists every charge, refund and top-up.',
                ],
                notes: [
                    'The balance can go below zero, depending on "Listing settings" (topic vendorlistingrules). Below the price of a first unlock, listings pause for new customers until you top up.',
                    'Credits never expire.',
                ],
            },
            fr: {
                title: 'Prestataire de services : crédits, coût d’un déblocage, forfaits',
                summary: 'Acheter des crédits, lire le solde et l’historique, changer de forfait',
                steps: [
                    'Ouvrez « Forfaits et crédits » (téléphone : « Crédits »). Le « Portefeuille de crédits » affiche le solde ; « Recharger » → choisissez un pack → « Acheter » et payez.',
                    'La page indique la règle avec les prix du jour : le premier contact qu’un client débloque coûte un prix, chacun des suivants moins, et le même contact est ensuite gratuit pendant 30 jours.',
                    'Les forfaits fixent combien d’annonces peuvent être en ligne à la fois et incluent des crédits à chaque échéance ; « Choisir cette formule » change de forfait.',
                    '« Historique des crédits » liste chaque prélèvement, remboursement et rechargement.',
                ],
                notes: [
                    'Le solde peut passer sous zéro, selon les « Réglages des annonces » (sujet vendorlistingrules). Sous le prix d’un premier déblocage, les annonces sont en pause pour les nouveaux clients jusqu’au rechargement.',
                    'Les crédits n’expirent jamais.',
                ],
            },
        },
    }),
    T({
        key: 'vendorlistingrules',
        app: 'vendor',
        path: '/dashboard/settings/listings',
        signIn: true,
        copy: {
            en: {
                title: 'Service provider: listing settings — running out of credits, daily limit',
                summary: 'What happens when credits run out; how far below zero; a per-customer daily limit',
                steps: [
                    'Open Settings → "Listing settings".',
                    '"When your credits run out": "Keep serving customers already talking to you" (until their 30 days end; the balance can go below zero) or "Stop for everyone" (no one can unlock until you top up).',
                    '"How far below zero": "Go below zero by at most" a number of credits, or leave it empty for no limit.',
                    '"Most one customer can cost you per day": a number of credits, at least the price of a first unlock, or empty for no limit. Then save.',
                ],
                notes: ['New customers always stop reaching you when the balance drops below the price of a first unlock; these settings only decide what happens to customers already in contact.'],
            },
            fr: {
                title: 'Prestataire de services : réglages des annonces — crédits épuisés, limite par jour',
                summary: 'Ce qui se passe quand les crédits sont épuisés ; jusqu’où sous zéro ; limite par client et par jour',
                steps: [
                    'Ouvrez Paramètres → « Réglages des annonces ».',
                    '« Quand vos crédits sont épuisés » : « Continuer avec les clients déjà en contact » (jusqu’à la fin de leurs 30 jours ; le solde peut passer sous zéro) ou « Arrêter pour tout le monde » (personne ne peut débloquer avant le rechargement).',
                    '« Jusqu’où sous zéro » : « Descendre sous zéro d’au plus » un nombre de crédits, ou laissez vide pour ne pas limiter.',
                    '« Le maximum qu’un client peut vous coûter par jour » : un nombre de crédits, au moins le prix d’un premier déblocage, ou vide pour ne pas limiter. Puis enregistrez.',
                ],
                notes: ['Les nouveaux clients ne vous joignent plus dès que le solde passe sous le prix d’un premier déblocage ; ces réglages décident seulement pour les clients déjà en contact.'],
            },
        },
    }),
]);
