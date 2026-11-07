import { GuideTopic, T } from './website-guide-types';

/**
 * The website guide — the AGENCY DASHBOARD ("Wi-Agency": agency.wi-mall.com, and the same app on
 * Android).
 *
 * Read from `frontend/agency-dash` itself on 2026-10-09: `App.tsx`, the sidebar and mobile bar,
 * every page and `i18n/locales/{en,fr}`. Labels are QUOTED, as in the storefront topics — see the
 * header of `website-guide.ts`. Paths are checked against that repository by
 * `verify:dashboard-routes`.
 *
 * ⚠ Two layouts, as on the vendor dashboard: a left sidebar on a computer, a bottom bar ending in
 * "More" («Plus») on a phone or in the Android app. Steps name both where they differ.
 */
export const AGENCY_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'agencymenu',
        app: 'agency',
        path: '/dashboard',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: the map — where every page is',
                summary: 'Where things are: sidebar, phone bar, Quick Actions, search, avatar menu',
                steps: [
                    'COMPUTER — left sidebar, top to bottom: "Overview", "Shipments", "Live Tracking", "Inventory" ("Stored SKUs", "Stock requests", "Storage statements"), "Media", "Transactions", "Analytics", "Cash Management" ("Summary", "Deposits", "Remittances", "Discrepancies"), "Notifications", "Tickets", "Agents" ("Connections", "Browse", "History", "Reviews"), "Vendors" ("Connections", "Browse", "Products").',
                    'At the bottom: "Account" ("Profile", "Store", "Locations", "Verification", "Security", "Billing", "Payout") and "Settings" ("Policies", "Notifications", "Preferences").',
                    'Header: "Search..." (Ctrl K) finds pages and shipments by order number, tracking number or customer; "Quick Actions" has "New Ticket", "View Shipments", "View Earnings", "Cash Management", "Update Coverage Areas"; the bell; the avatar menu with "Profile" and "Logout".',
                    'PHONE or APP — bottom bar: "Overview", "Shipments", a round "+" (Quick Actions), "Payout", "More". "More" holds everything else, including Account and Settings.',
                ],
                notes: [
                    'Red numbers on "Shipments", "Agents", "Vendors" and "Inventory" count things waiting for the agency.',
                    'Language: Account → "Profile". Theme: Settings → "Preferences". Signing out on a phone: Account → "Profile" → "Logout".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : le plan — où se trouve chaque page',
                summary: 'Où sont les choses : barre latérale, barre du téléphone, Actions rapides, recherche, menu',
                steps: [
                    'ORDINATEUR — barre latérale gauche, de haut en bas : « Vue d’ensemble », « Expéditions », « Suivi en direct », « Stock » (« SKU entreposés », « Demandes de stock », « Relevés de stockage »), « Médias », « Transactions », « Statistiques », « Gestion des espèces » (« Synthèse », « Dépôts », « Reversements », « Écarts »), « Notifications », « Tickets », « Livreurs » (« Contrats », « Annuaire », « Historique », « Évaluations »), « Vendeurs » (« Connexions », « Annuaire », « Produits »).',
                    'En bas : « Compte » (« Profil », « Boutique », « Sites », « Vérification », « Sécurité », « Facturation », « Versements ») et « Paramètres » (« Conditions », « Notifications », « Préférences »).',
                    'En-tête : « Rechercher… » (Ctrl K) trouve pages et expéditions par numéro de commande, de suivi ou client ; « Actions rapides » contient « Nouveau ticket », « Voir les expéditions », « Voir les revenus », « Gestion des espèces », « Modifier les zones couvertes » ; la cloche ; le menu avec « Profil » et « Déconnexion ».',
                    'TÉLÉPHONE ou APP — barre du bas : « Vue d’ensemble », « Expéditions », un « + » rond (Actions rapides), « Versements », « Plus ». « Plus » contient tout le reste, dont Compte et Paramètres.',
                ],
                notes: [
                    'Les chiffres rouges sur « Expéditions », « Livreurs », « Vendeurs » et « Stock » comptent ce qui attend l’agence.',
                    'Langue : Compte → « Profil ». Thème : Paramètres → « Préférences ». Se déconnecter sur téléphone : Compte → « Profil » → « Déconnexion ».',
                ],
            },
        },
    }),
    T({
        key: 'agencysignin',
        app: 'agency',
        path: '/login',
        signIn: false,
        copy: {
            en: {
                title: 'Agency dashboard: signing in, creating an agency account, forgotten password',
                summary: 'How a delivery agency signs in or signs up',
                steps: [
                    'Open agency.wi-mall.com (or the Wi-Agency app). Choose "Phone" or "Email", type the number or email they signed up with and the "Password", then "Sign in".',
                    'New agency: "Create an agency account" → "Your name", "Agency name", "Phone number" (used to sign in), optional "Email", "Password" (at least 6 characters) twice, tick the Terms box → "Create account". The set-up steps follow (topic agencyonboarding).',
                    'Forgotten password: "Forgot your password?" → "Phone number or email address" → "Send reset link", then choose the new password on the page the link opens.',
                ],
                notes: [
                    '"This account doesn\'t have the Agency role yet": they already have a Wi-Mall account — sign in on the Wi-Mall website and add the Agency role there. The same applies if the phone or email is "already linked to a Wi-Mall account".',
                    'An email is optional but is how a forgotten password is recovered.',
                    'This chat cannot sign anyone in to the dashboard.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : se connecter, créer un compte agence, mot de passe oublié',
                summary: 'Comment une agence de livraison se connecte ou s’inscrit',
                steps: [
                    'Ouvrez agency.wi-mall.com (ou l’app Wi-Agency). Choisissez « Téléphone » ou « E-mail », saisissez le numéro ou l’e-mail de l’inscription et le « Mot de passe », puis « Se connecter ».',
                    'Nouvelle agence : « Créer un compte agence » → « Votre nom », « Nom de l’agence », « Numéro de téléphone » (sert à se connecter), « E-mail » facultatif, « Mot de passe » (au moins 6 caractères) deux fois, cochez les Conditions → « Créer le compte ». Les étapes de configuration suivent (sujet agencyonboarding).',
                    'Mot de passe oublié : « Mot de passe oublié ? » → « Numéro de téléphone ou adresse e-mail » → « Envoyer le lien », puis choisissez le nouveau mot de passe sur la page ouverte par le lien.',
                ],
                notes: [
                    '« Ce compte n’a pas encore le rôle Agence » : ils ont déjà un compte Wi-Mall — connectez-vous sur le site Wi-Mall et ajoutez-y le rôle Agence. Pareil si le téléphone ou l’e-mail est « déjà lié à un compte Wi-Mall ».',
                    'L’e-mail est facultatif mais permet de récupérer un mot de passe oublié.',
                    'Ce chat ne peut connecter personne au tableau de bord.',
                ],
            },
        },
    }),
    T({
        key: 'agencyonboarding',
        app: 'agency',
        path: '/onboarding',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: the 4 set-up steps of a new agency',
                summary: 'The set-up a new agency must finish before the dashboard opens',
                steps: [
                    '"Logistics": tick every region under "Coverage Regions", then add the "Headquarters" address — search it in "Find this location" and PICK a result, give it a "Label", "Street Address" and contact. "Add address" adds branches. "Continue".',
                    '"Payout": add 1 to 3 payout methods (the first is the preferred one). "Continue".',
                    '"Branding" (optional): "Agency Logo" and "Operating Timezone". "Save & Finish" or "Skip for now".',
                    '"Policies": delivery pricing, cash on delivery, returns and damage rules (topic agencypricing). "Save & Finish" opens the dashboard.',
                ],
                notes: [
                    'The dashboard stays closed until set-up is finished. The operating country chosen here can never be changed.',
                    'An address must be picked from the search results: auto-assignment measures distance from it.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : les 4 étapes de configuration d’une nouvelle agence',
                summary: 'La configuration qu’une nouvelle agence doit finir avant que le tableau de bord s’ouvre',
                steps: [
                    '« Logistique » : cochez chaque région sous « Régions couvertes », puis ajoutez l’adresse du « Siège » — cherchez-la dans « Rechercher ce site » et CHOISISSEZ un résultat, donnez un « Libellé », l’« Adresse » et un contact. « Ajouter une adresse » ajoute des succursales. « Continuer ».',
                    '« Versements » : ajoutez 1 à 3 moyens de versement (le premier est le préféré). « Continuer ».',
                    '« Identité » (facultatif) : « Logo de l’agence » et « Fuseau horaire d’exploitation ». « Enregistrer et terminer » ou « Passer pour l’instant ».',
                    '« Conditions » : tarifs de livraison, paiement à la livraison, retours et dommages (sujet agencypricing). « Enregistrer et terminer » ouvre le tableau de bord.',
                ],
                notes: [
                    'Le tableau de bord reste fermé tant que la configuration n’est pas finie. Le pays d’exploitation choisi ici ne peut jamais être changé.',
                    'Une adresse doit être choisie dans les résultats : l’affectation automatique mesure les distances depuis elle.',
                ],
            },
        },
    }),
    T({
        key: 'agencypricing',
        app: 'agency',
        path: '/dashboard/settings/policies',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: delivery prices, cash on delivery, returns and damage rules',
                summary: 'Set delivery fees, the maximum fee, cash on delivery, returns and damage policies',
                steps: [
                    'Open Settings → "Policies" (phone: More → Settings → Policies).',
                    '"Pricing": switch on "Storage-based fees" and/or "Pickup-based fees" (at least one) and fill the rates ("Base rate — first kg", "Additional per kg", "Out-of-region surcharge", or the storage, pick & pack and delivery fees). "Additional fees": COD handling fee, "Failed delivery fee", "RTO fee", "Peak season surcharge".',
                    '"Maximum fee and cash payment": "Maximum delivery fee per shipment" (empty = no maximum) and the switch "Let customers pay the delivery fee in cash to your rider".',
                    '"Cash on Delivery": "Accept cash-on-delivery orders" and an optional "Max COD order amount". Then "Returns Policy", "Damage Policy" and up to 2 PDF "Supporting Documents".',
                    'Tap "Save changes" at the bottom. They see "Policies saved!".',
                ],
                notes: [
                    'Cash-on-delivery orders only reach the agency once Wi-Mall has verified it ("Get verified" → Account → Verification).',
                    'These rules apply to every vendor and customer the agency delivers for. Each fee is worked out at checkout from weight and region, then capped at the maximum.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : tarifs de livraison, paiement à la livraison, retours et dommages',
                summary: 'Régler les frais de livraison, le maximum, le paiement à la livraison, les retours et dommages',
                steps: [
                    'Ouvrez Paramètres → « Conditions » (téléphone : Plus → Paramètres → Conditions).',
                    '« Tarifs » : activez « Tarifs avec stockage » et/ou « Tarifs à l’enlèvement » (au moins un) et remplissez les tarifs (« Tarif de base — premier kg », « Supplément par kg », « Supplément hors région », ou les frais de stockage, préparation et livraison). « Frais supplémentaires » : frais de gestion COD, « Frais de livraison échouée », « Frais de retour à l’expéditeur », « Supplément haute saison ».',
                    '« Frais maximum et paiement en espèces » : « Frais de livraison maximum par expédition » (vide = pas de maximum) et l’interrupteur « Permettre aux clients de payer la livraison en espèces à votre livreur ».',
                    '« Paiement à la livraison » : « Accepter les commandes payées à la livraison » et un « Montant COD maximum par commande » facultatif. Puis « Politique de retour », « Politique en cas de dommage » et jusqu’à 2 PDF « Documents justificatifs ».',
                    'Touchez « Enregistrer les modifications » en bas. Ils voient « Conditions enregistrées ! ».',
                ],
                notes: [
                    'Les commandes payées à la livraison n’arrivent qu’une fois l’agence vérifiée par Wi-Mall (« Faire vérifier mon agence » → Compte → Vérification).',
                    'Ces règles valent pour tous les vendeurs et clients livrés. Chaque frais est calculé au paiement selon le poids et la région, puis plafonné au maximum.',
                ],
            },
        },
    }),
    T({
        key: 'agencypreferences',
        app: 'agency',
        path: '/dashboard/settings/preferences',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: auto-assignment, agents proposing fees, theme',
                summary: 'Offer new shipments to the nearest agent automatically; let agents propose fees; theme',
                steps: [
                    'Open Settings → "Preferences" (phone: More → Settings → Preferences).',
                    '"Auto-assign shipments to agents": on = every new shipment is offered to the nearest eligible agent; the first to accept takes it. Off = the agency assigns each one.',
                    '"Let my agents propose delivery fees": on = the agent who accepted a shipment may ask for a different fee before pickup.',
                    '"Theme": "Light", "Dark" or "System".',
                ],
                notes: [
                    'These switches save at once — there is no Save button.',
                    'If nobody accepts after two rounds of auto-assignment, the agency is told and assigns it itself. Shipments already waiting are not affected.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : affectation automatique, frais proposés par les livreurs, thème',
                summary: 'Proposer les nouvelles expéditions au livreur le plus proche ; laisser les livreurs proposer des frais ; thème',
                steps: [
                    'Ouvrez Paramètres → « Préférences » (téléphone : Plus → Paramètres → Préférences).',
                    '« Affecter automatiquement les expéditions aux livreurs » : activé = chaque nouvelle expédition est proposée au livreur éligible le plus proche ; le premier qui accepte la prend. Coupé = l’agence affecte chacune.',
                    '« Autoriser mes livreurs à proposer des frais de livraison » : activé = le livreur qui a accepté peut demander d’autres frais avant l’enlèvement.',
                    '« Thème » : « Clair », « Sombre » ou « Système ».',
                ],
                notes: [
                    'Ces interrupteurs s’enregistrent tout de suite — il n’y a pas de bouton Enregistrer.',
                    'Si personne n’accepte après deux tours d’affectation automatique, l’agence est prévenue et affecte elle-même. Les expéditions déjà en attente ne changent pas.',
                ],
            },
        },
    }),
    T({
        key: 'agencyshipments',
        app: 'agency',
        path: '/dashboard/shipments',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: handling shipments and changing their status',
                summary: 'Find a shipment, open it, move it on: picked up, in transit, delivered, failed, returned',
                steps: [
                    'Open "Shipments". Search by order number, customer, product or tracking number; "Filters" → "Status". Click a shipment to open its details (items, money, vendor, customer, agent, history).',
                    'Status buttons (in the details, or ⋯ → "Update status"): "Assigned" → "Mark Picked Up"; "Picked Up" → "Mark In Transit"; "In Transit" → "Mark Delivered" or "Mark Failed"; "Failed" → "Retry Delivery" or "Mark Returned"; "Handing Over" → "Confirm the handover pickup" or "Mark Returned".',
                    '"Mark Delivered" puts it in "Awaiting Confirmation" until the delivery is confirmed.',
                ],
                notes: [
                    'Status changes apply at once, with no confirmation.',
                    '"Mark Picked Up" stays greyed out until an agent has accepted the shipment, and while a delivery-fee change waits for an answer.',
                    'The proof photo is under "Delivery proof" → "Show the proof photo".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : gérer les expéditions et changer leur statut',
                summary: 'Trouver une expédition, l’ouvrir, la faire avancer : récupérée, en transit, livrée, échouée, retournée',
                steps: [
                    'Ouvrez « Expéditions ». Cherchez par numéro de commande, client, produit ou numéro de suivi ; « Filtres » → « Statut ». Cliquez une expédition pour ouvrir son détail (articles, montants, vendeur, client, livreur, historique).',
                    'Boutons de statut (dans le détail, ou ⋯ → « Changer le statut ») : « Affectée » → « Marquer récupérée » ; « Récupérée » → « Marquer en transit » ; « En transit » → « Marquer livrée » ou « Marquer échouée » ; « Échouée » → « Relancer la livraison » ou « Marquer retournée » ; « Passation en cours » → « Confirmer la prise en charge » ou « Marquer retournée ».',
                    '« Marquer livrée » la met « En attente de confirmation » jusqu’à la confirmation de la livraison.',
                ],
                notes: [
                    'Les changements de statut s’appliquent tout de suite, sans confirmation.',
                    '« Marquer récupérée » reste grisé tant qu’aucun livreur n’a accepté, et tant qu’un changement de frais attend une réponse.',
                    'La photo de preuve est sous « Preuve de livraison » → « Afficher la photo de preuve ».',
                ],
            },
        },
    }),
    T({
        key: 'agencyreject',
        app: 'agency',
        path: '/dashboard/shipments',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: refusing a shipment',
                summary: 'Decline a shipment before pickup so the vendor can send it elsewhere',
                steps: [
                    'Open "Shipments", then the shipment\'s ⋯ menu → "Reject shipment" (or "Reject" at the bottom of its details).',
                    'Choose a "Reason": "Out of coverage area", "Capacity exceeded", "Invalid address", "Vendor item not ready" or "Other" (then a "Message" is required, max 200 characters).',
                    'Tap "Reject shipment".',
                ],
                notes: [
                    'Only possible while the shipment is "Assigned" (before pickup).',
                    'An agent who had accepted it is released, a pending fee change is withdrawn, and the vendor is told the reason.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : refuser une expédition',
                summary: 'Refuser une expédition avant l’enlèvement pour que le vendeur l’envoie ailleurs',
                steps: [
                    'Ouvrez « Expéditions », puis le menu ⋯ de l’expédition → « Refuser l’expédition » (ou « Refuser » en bas de son détail).',
                    'Choisissez un « Motif » : « Hors zone de couverture », « Capacité dépassée », « Adresse invalide », « Article vendeur non prêt » ou « Autre » (un « Message » est alors obligatoire, 200 caractères max).',
                    'Touchez « Refuser l’expédition ».',
                ],
                notes: [
                    'Possible seulement quand l’expédition est « Affectée » (avant l’enlèvement).',
                    'Un livreur qui l’avait acceptée est libéré, un changement de frais en attente est retiré, et le vendeur reçoit le motif.',
                ],
            },
        },
    }),
    T({
        key: 'agencybulkassign',
        app: 'agency',
        path: '/dashboard/shipments',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: offering several shipments to one agent at once',
                summary: 'Select up to 10 shipments and offer them all to one agent',
                steps: [
                    'Open "Shipments" and tick the shipments (phone: long-press a card). Only "Assigned" or "Handing Over" shipments with no agent can be ticked.',
                    'Tap "Assign to agent" in the bar at the bottom.',
                    'Choose the "Agent", check the list, then tap "Offer N shipments". Each one becomes an offer the agent accepts.',
                ],
                notes: [
                    'At most 10 per batch. The result shows which were offered and why any were not.',
                    'If the agent does not have enough free slots, nothing is sent: remove some, or tap "Keep only the first N".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : proposer plusieurs expéditions à un livreur d’un coup',
                summary: 'Sélectionner jusqu’à 10 expéditions et les proposer à un seul livreur',
                steps: [
                    'Ouvrez « Expéditions » et cochez les expéditions (téléphone : appui long sur une carte). Seules les expéditions « Affectée » ou « Passation en cours » sans livreur se cochent.',
                    'Touchez « Proposer à un livreur » dans la barre du bas.',
                    'Choisissez le « Livreur », vérifiez la liste, puis touchez « Proposer N expéditions ». Chacune devient une proposition que le livreur accepte.',
                ],
                notes: [
                    '10 au maximum par lot. Le résultat indique lesquelles ont été proposées et pourquoi certaines non.',
                    'Si le livreur n’a pas assez de places libres, rien n’est envoyé : retirez-en, ou utilisez le bouton qui ne garde que les premières.',
                ],
            },
        },
    }),
    T({
        key: 'agencycombined',
        app: 'agency',
        path: '/dashboard/shipments/combined-requests',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: answering a customer\'s combined-price request',
                summary: 'A customer asks one lower price for several parcels: lower the fees or decline',
                steps: [
                    'Open "Shipments" → "Combined requests" at the top. Open requests are the ones waiting for an answer.',
                    '"Lower the fees": type a lower "New fee" for each parcel to discount (leave empty to keep), optionally a note, then "Apply the lower fees".',
                    'Or "Decline" → optional note → "Decline request".',
                ],
                notes: [
                    'A lower fee applies at once: an online order is refunded the difference, a cash order\'s amount to collect drops. The customer is told either way.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : répondre à une demande de prix groupé',
                summary: 'Un client demande un prix réduit pour plusieurs colis : baisser les frais ou refuser',
                steps: [
                    'Ouvrez « Expéditions » → « Demandes groupées » en haut. Les demandes ouvertes attendent une réponse.',
                    '« Baisser les frais » : saisissez un « Nouveau frais » plus bas pour chaque colis à réduire (vide = inchangé), une note si besoin, puis « Appliquer les baisses ».',
                    'Ou « Refuser » → note facultative → « Refuser la demande ».',
                ],
                notes: [
                    'Une baisse s’applique tout de suite : une commande en ligne est remboursée de la différence, le montant à encaisser d’une commande en espèces baisse. Le client est prévenu dans tous les cas.',
                ],
            },
        },
    }),
    T({
        key: 'agencyfindagent',
        app: 'agency',
        path: '/dashboard/agents/browse',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: finding an agent and offering a contract',
                summary: 'Browse the agent directory and send an agent a contract offer',
                steps: [
                    'Open "Agents" → "Browse" (or "Find an agent" on Overview). Search, or filter by "Vehicle", "Availability", "Trust".',
                    'Tap "Offer a contract". Fill "Fee split" ("Percentage", "Flat fee" or "Monthly salary"), "COD remittance" (how often the agent hands cash back, "Grace hours"), and optionally "Coverage regions" and "Shipment value ceiling".',
                    'Tap "Send offer". The agent accepts, declines or counters; their answer appears in "Agents" → "Connections".',
                ],
                notes: [
                    'Only contracted agents can take the agency\'s shipments. The agent\'s cut comes out of the delivery fee, never on top.',
                    'Phone, email and live position are shown only once there is a contract. A monthly salary is paid by the agency outside Wi-Mall.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : trouver un livreur et lui proposer un contrat',
                summary: 'Parcourir l’annuaire des livreurs et envoyer une offre de contrat',
                steps: [
                    'Ouvrez « Livreurs » → « Annuaire » (ou « Trouver un agent » sur la Vue d’ensemble). Cherchez, ou filtrez par « Véhicule », « Disponibilité », « Confiance ».',
                    'Touchez « Proposer un contrat ». Remplissez « Partage des frais » (« Pourcentage », « Forfait » ou « Salaire mensuel »), « Reversement des espèces » (fréquence de remise des espèces), et si besoin « Régions couvertes » et « Plafond par expédition ».',
                    'Touchez « Envoyer l’offre ». Le livreur accepte, refuse ou fait une contre-offre ; sa réponse apparaît dans « Livreurs » → « Contrats ».',
                ],
                notes: [
                    'Seuls les livreurs sous contrat peuvent prendre les expéditions de l’agence. La part du livreur est prise sur les frais de livraison, jamais en plus.',
                    'Téléphone, e-mail et position ne sont visibles qu’avec un contrat. Un salaire mensuel est payé par l’agence hors de Wi-Mall.',
                ],
            },
        },
    }),
    T({
        key: 'agencyagents',
        app: 'agency',
        path: '/dashboard/agents/connections',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: managing agent contracts',
                summary: 'Answer applications, change terms or the cash cap, pause, suspend, reinstate or remove an agent',
                steps: [
                    'Open "Agents" → "Connections". Filter by "Offers", "Active", "Change requested", "Terms proposed", "Paused", "Suspended".',
                    'An application or counter-offer: "Accept" or "Decline". Your own offer still waiting: "Withdraw". An applicant without terms: "Propose terms".',
                    'Requests from an agent ("Wants to pause", "Wants to resume", "Wants to leave"): "Approve" or "Reject".',
                    'On an active agent tap "Manage": change the cash limit ("Change the cap" → "Set"), propose new terms ("Propose to agent"), or "Pause", "Suspend", "Remove". A paused or suspended agent: "Reinstate".',
                ],
                notes: [
                    'Paused or suspended agents keep their current shipments but get no new ones. "Remove" ends the contract only once the agent agrees and cash and earnings are settled.',
                    'A cash cap of 0 means no cash-on-delivery runs; an unverified agent cannot carry cash at all. "Assignment eligibility" in "Manage" says why an agent gets no offers.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : gérer les contrats des livreurs',
                summary: 'Répondre aux candidatures, changer les conditions ou le plafond, mettre en pause, suspendre, réintégrer, retirer',
                steps: [
                    'Ouvrez « Livreurs » → « Contrats ». Filtrez par « Offres », « Actifs », « Changement demandé », « Conditions proposées », « En pause », « Suspendus ».',
                    'Une candidature ou contre-offre : « Accepter » ou « Refuser ». Votre offre en attente : « Retirer ». Un candidat sans conditions : « Proposer des conditions ».',
                    'Demandes d’un livreur (« Souhaite se mettre en pause », « Souhaite reprendre », « Souhaite partir ») : « Approuver » ou « Refuser ».',
                    'Sur un livreur actif, touchez « Gérer » : changer le plafond d’espèces (« Modifier le plafond » → « Définir »), proposer de nouvelles conditions (« Proposer au livreur »), ou « Mettre en pause », « Suspendre », « Retirer ». En pause ou suspendu : « Réintégrer ».',
                ],
                notes: [
                    'En pause ou suspendu, le livreur garde ses expéditions en cours mais n’en reçoit pas de nouvelles. « Retirer » ne met fin au contrat qu’avec son accord et une fois espèces et gains réglés.',
                    'Un plafond de 0 = aucune course en espèces ; un livreur non vérifié ne peut pas transporter d’espèces. « Éligibilité aux affectations » dans « Gérer » dit pourquoi il ne reçoit pas d’offres.',
                ],
            },
        },
    }),
    T({
        key: 'agencyassign',
        app: 'agency',
        path: '/dashboard/shipments',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: assigning or reassigning an agent to a shipment',
                summary: 'Offer a shipment to an agent, auto-assign it, or move it to another agent',
                steps: [
                    'Open "Shipments" → the shipment → section "Agent Assignment".',
                    'Pick one agent in "Choose an agent to offer…" → "Offer". Or "Auto-assign": it is offered nearest-first and the first to accept takes it ("Stop" withdraws it). "Preview candidates" shows the order.',
                    'A waiting offer can be withdrawn with "Cancel". Once accepted: "Track on map" or "Reassign".',
                    '"Reassign": optional "Replacement agent" (empty = auto), a required "Reason", then "Reassign". Once the parcel has left the agency, the replacement must be named.',
                ],
                notes: [
                    'Only contracted, active agents can be offered a shipment; the agent accepts in their app, and pickup waits for that.',
                    'Outside the agent\'s contract regions or above their cash limit, the dashboard asks first ("Send anyway" / "Assign anyway").',
                    'For every new shipment at once: Settings → Preferences → "Auto-assign shipments to agents" (topic agencypreferences).',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : affecter ou réaffecter un livreur à une expédition',
                summary: 'Proposer une expédition à un livreur, l’affecter automatiquement, ou la confier à un autre',
                steps: [
                    'Ouvrez « Expéditions » → l’expédition → section « Affectation d’un livreur ».',
                    'Choisissez un livreur dans « Choisir un livreur à qui proposer… » → « Proposer ». Ou « Affectation auto » : proposée au plus proche d’abord, le premier qui accepte la prend (« Arrêter » la retire). « Aperçu des candidats » montre l’ordre.',
                    'Une offre en attente se retire avec « Annuler ». Acceptée : « Suivre sur la carte » ou « Réaffecter ».',
                    '« Réaffecter » : « Livreur remplaçant » facultatif (vide = automatique), un « Motif » obligatoire, puis valider. Une fois le colis sorti de l’agence, le remplaçant doit être nommé.',
                ],
                notes: [
                    'Seuls les livreurs sous contrat et actifs peuvent recevoir une offre ; le livreur accepte dans son app, et l’enlèvement attend cela.',
                    'Hors des régions du contrat ou au-delà de sa limite d’espèces, le tableau de bord demande d’abord (« Envoyer quand même » / « Assigner quand même »).',
                    'Pour toutes les nouvelles expéditions : Paramètres → Préférences → affectation automatique (sujet agencypreferences).',
                ],
            },
        },
    }),
    T({
        key: 'agencyfee',
        app: 'agency',
        path: '/dashboard/shipments',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: changing a shipment\'s delivery fee',
                summary: 'Propose a different delivery fee on a shipment before pickup; edit or withdraw it',
                steps: [
                    'Open "Shipments" → the shipment (status Assigned or Handing Over) → "Delivery fee" → "Propose a different fee".',
                    'Type the "New fee" and a "Reason" (whoever pays delivery sees it), then "Send proposal".',
                    'While it waits: "Edit" or "Withdraw". After a rejection: "Propose again", or "Decline delivery".',
                ],
                notes: [
                    'If the shop pays delivery, the vendor must approve and pickup is blocked until they answer. If the customer pays, a lower fee applies at once and a higher one waits for the customer.',
                    'At most 2 proposals per shipment (the agency\'s and its agents\' together).',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : changer les frais de livraison d’une expédition',
                summary: 'Proposer d’autres frais avant l’enlèvement ; modifier ou retirer la proposition',
                steps: [
                    'Ouvrez « Expéditions » → l’expédition (Affectée ou Passation en cours) → « Frais de livraison » → « Proposer d’autres frais ».',
                    'Saisissez les nouveaux frais et un motif (vu par celui qui paie la livraison), puis « Envoyer la proposition ».',
                    'En attendant : « Modifier » ou « Retirer ». Après un refus : proposer de nouveau, ou « Refuser la livraison ».',
                ],
                notes: [
                    'Si la boutique paie la livraison, le vendeur doit accepter et l’enlèvement est bloqué jusqu’à sa réponse. Si le client paie, une baisse s’applique tout de suite et une hausse attend le client.',
                    '2 propositions au maximum par expédition (agence et livreurs confondus).',
                ],
            },
        },
    }),
    T({
        key: 'agencyrating',
        app: 'agency',
        path: '/dashboard/agents/reviews',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: rating an agent\'s delivery',
                summary: 'Rate the agent who carried a delivered shipment; see the ratings given',
                steps: [
                    'Open "Shipments", filter "Delivered", open the shipment → "Rate this delivery".',
                    'Choose the stars, optionally a "Headline" and "Comments", then "Submit rating".',
                    'All ratings given are in "Agents" → "Reviews".',
                ],
                notes: [
                    'One rating per delivery, never edited or withdrawn. Stars alone count at once; written comments are checked by a moderator first. It feeds the agent\'s trust score.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : noter la livraison d’un livreur',
                summary: 'Noter le livreur d’une expédition livrée ; voir les notes données',
                steps: [
                    'Ouvrez « Expéditions », filtrez « Livrée », ouvrez l’expédition → « Évaluer cette livraison ».',
                    'Choisissez les étoiles, ajoutez si besoin un titre et des commentaires, puis « Envoyer la note ».',
                    'Toutes les notes données sont dans « Livreurs » → « Évaluations ».',
                ],
                notes: [
                    'Une note par livraison, jamais modifiée ni retirée. Les étoiles seules comptent tout de suite ; un commentaire est vérifié d’abord. Cela nourrit le score de confiance du livreur.',
                ],
            },
        },
    }),
    T({
        key: 'agencyvendors',
        app: 'agency',
        path: '/dashboard/vendors/connections',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: working with vendors (connection requests)',
                summary: 'Approve a vendor\'s request, ask a vendor to connect, reapprove, end a connection',
                steps: [
                    'Open "Vendors" → "Connections". A vendor\'s request: "Approve" or "Reject". Your own request: "Withdraw".',
                    '"Reapproval needed" (the vendor changed its policies): "Reapprove". Active: "Terminate". Ended: "Request Again".',
                    'To ask a new vendor: "Vendors" → "Browse" → "Request". "Vendors" → "Products" lists the products routed to the agency (read-only).',
                ],
                notes: [
                    'The agency only receives orders from connected vendors. When a vendor changes its policies, the connection pauses until the agency reapproves.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : travailler avec les vendeurs (demandes de connexion)',
                summary: 'Approuver une demande de vendeur, demander à un vendeur, réapprouver, mettre fin',
                steps: [
                    'Ouvrez « Vendeurs » → « Connexions ». Une demande de vendeur : « Approuver » ou « Refuser ». Votre demande : « Retirer ».',
                    '« Réapprobation requise » (le vendeur a changé ses politiques) : « Réapprouver ». Active : « Résilier ». Terminée : « Redemander ».',
                    'Pour un nouveau vendeur : « Vendeurs » → « Annuaire » → « Demander ». « Vendeurs » → « Produits » liste les produits confiés à l’agence (lecture seule).',
                ],
                notes: [
                    'L’agence ne reçoit des commandes que des vendeurs connectés. Quand un vendeur change ses politiques, la connexion est suspendue jusqu’à la réapprobation.',
                ],
            },
        },
    }),
    T({
        key: 'agencycash',
        app: 'agency',
        path: '/dashboard/cash/summary',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: cash on delivery — agents\' hand-overs, paying Wi-Mall, problems',
                summary: 'Confirm cash agents hand over, record a deposit, send cash to Wi-Mall, raise a discrepancy',
                steps: [
                    '"Cash Management" → "Summary": what is "Owed to Platform", what agents hold, and the agency\'s "COD cash limit".',
                    '"Deposits": an agent\'s declared hand-over → "Confirm" or "Reject" (with a reason) within 2 days. Cash received at the desk: "Record Deposit" → agent, amount.',
                    'Paying Wi-Mall: "Declare a remittance" (or "Remittances" → "Declare remittance") → amount, the REQUIRED transfer receipt, reference → "Declare". Wi-Mall confirms it.',
                    'An agent short of cash: "Discrepancies" → "Raise discrepancy" → agent, "Cash shortfall" or "Other", amount → "Raise".',
                ],
                notes: [
                    'An unanswered agent declaration opens a discrepancy that freezes the agency\'s reserve releases.',
                    'Above the COD limit, vendors cannot send cash-on-delivery orders until the agency remits. The limit is set by Wi-Mall.',
                    'A cash shortfall blocks new cash jobs for that agent until an administrator resolves it.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : paiement à la livraison — remises des livreurs, reversements, écarts',
                summary: 'Confirmer les remises des livreurs, enregistrer un dépôt, reverser à Wi-Mall, signaler un écart',
                steps: [
                    '« Gestion des espèces » → « Synthèse » : ce qui est « Dû à la plateforme », ce que détiennent les livreurs, et le « Plafond d’espèces COD ».',
                    '« Dépôts » : une remise déclarée par un livreur → « Confirmer » ou « Refuser » (avec motif) sous 2 jours. Argent reçu au guichet : « Enregistrer le dépôt » → livreur, montant.',
                    'Payer Wi-Mall : « Déclarer un reversement » → montant, le « Reçu du virement » OBLIGATOIRE, référence → « Déclarer ». Wi-Mall confirme.',
                    'Un livreur à qui il manque de l’argent : « Écarts » → « Signaler un écart » → livreur, « Manquant de caisse » ou « Autre », montant → « Signaler ».',
                ],
                notes: [
                    'Une déclaration sans réponse ouvre un écart qui gèle les libérations de réserve de l’agence.',
                    'Au-delà du plafond COD, les vendeurs ne peuvent plus envoyer de commandes en espèces tant que l’agence n’a pas reversé. Le plafond est fixé par Wi-Mall.',
                    'Un manquant de caisse bloque les nouvelles courses en espèces de ce livreur jusqu’à résolution par un administrateur.',
                ],
            },
        },
    }),
    T({
        key: 'agencystock',
        app: 'agency',
        path: '/dashboard/inventory/stock',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: warehoused stock, stock requests and storage statements',
                summary: 'Record goods received, counts and returns; answer vendors\' stock changes; storage rent',
                steps: [
                    '"Inventory" → "Stored SKUs": click a product. Under "Record a movement": "Receive", "Return", "Count" (with a required reason) or "Transfer".',
                    'To change the agreed quantity: "Propose a change" → "New quantity" → "Send proposal"; the vendor must approve.',
                    '"Inventory" → "Stock requests": a vendor\'s request → "Approve" or "Reject" (with a reason); your own → "Withdraw".',
                    '"Inventory" → "Storage statements": an open statement → "Mark as paid" (records a payment made outside Wi-Mall) or "Void".',
                ],
                notes: [
                    'Only products vendors set to ship from the agency\'s warehouse appear, which needs "Storage-based fees" on in Settings → Policies.',
                    'Neither side can change a warehoused quantity alone. Statements are issued on the 1st of each month; Wi-Mall moves no money for them.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : stock entreposé, demandes de stock et relevés de stockage',
                summary: 'Enregistrer réceptions, comptages et retours ; répondre aux changements de stock ; loyers',
                steps: [
                    '« Stock » → « SKU entreposés » : cliquez un produit. Sous « Enregistrer un mouvement » : « Réceptionner », « Retourner », « Compter » (motif obligatoire) ou « Transférer ».',
                    'Pour changer la quantité convenue : « Proposer une modification » → nouvelle quantité → « Envoyer la proposition » ; le vendeur doit approuver.',
                    '« Stock » → « Demandes de stock » : une demande du vendeur → « Approuver » ou « Refuser » (avec motif) ; la vôtre → « Retirer ».',
                    '« Stock » → « Relevés de stockage » : un relevé ouvert → « Marquer comme payé » (paiement fait hors de Wi-Mall) ou « Annuler ».',
                ],
                notes: [
                    'Seuls les produits que les vendeurs expédient depuis l’entrepôt de l’agence apparaissent, ce qui demande les « Tarifs avec stockage » dans Paramètres → Conditions.',
                    'Aucun des deux ne peut changer seul une quantité entreposée. Les relevés sont émis le 1er du mois ; Wi-Mall ne transfère pas cet argent.',
                ],
            },
        },
    }),
    T({
        key: 'agencyprofile',
        app: 'agency',
        path: '/dashboard/account/profile',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: profile, language, business name and logo',
                summary: 'Change display name, photo, timezone, language (also for notifications), business identity',
                steps: [
                    'Account → "Profile": photo, "Display Name", "Timezone" and "Language" (English / Français). Tap "Save changes".',
                    'Account → "Store": logo ("Add logo" / "Change logo"), "Business name", "Description", "Support email", "Support phone", "WhatsApp". Tap "Save changes".',
                ],
                notes: [
                    'The language is used for the dashboard AND every notification; it is the only language setting once signed in.',
                    'Email and phone are read-only here — they are changed in Account → "Security". The country cannot be changed.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : profil, langue, nom et logo de l’entreprise',
                summary: 'Changer nom affiché, photo, fuseau, langue (aussi celle des notifications), identité de l’entreprise',
                steps: [
                    'Compte → « Profil » : photo, « Nom affiché », « Fuseau horaire » et « Langue » (English / Français). Touchez « Enregistrer les modifications ».',
                    'Compte → « Boutique » : logo, « Nom de l’entreprise », « Description », « E-mail de support », « Téléphone de support », « WhatsApp ». Touchez « Enregistrer les modifications ».',
                ],
                notes: [
                    'La langue sert au tableau de bord ET à toutes les notifications ; c’est le seul réglage de langue une fois connecté.',
                    'E-mail et téléphone sont en lecture seule ici — ils se changent dans Compte → « Sécurité ». Le pays ne peut pas être changé.',
                ],
            },
        },
    }),
    T({
        key: 'agencylocations',
        app: 'agency',
        path: '/dashboard/account/locations',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: coverage regions and depot addresses',
                summary: 'Change the regions the agency delivers to and its headquarters / branch addresses',
                steps: [
                    'Open Account → "Locations" (or Quick Actions → "Update Coverage Areas").',
                    '"Coverage Regions": tick or untick regions (at least one).',
                    'Addresses: "Add address", search it in "Find address" (or "My location") and pin it, fill "Label" and "Street Address / Landmark". The trash removes one.',
                    'Tap "Save changes".',
                ],
                notes: [
                    'Every address needs a map pin. A location that still stores vendor products cannot be removed until those products are moved.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : régions couvertes et adresses des dépôts',
                summary: 'Changer les régions desservies et les adresses du siège / des succursales',
                steps: [
                    'Ouvrez Compte → « Sites » (ou Actions rapides → « Modifier les zones couvertes »).',
                    '« Régions couvertes » : cochez ou décochez des régions (au moins une).',
                    'Adresses : « Ajouter une adresse », cherchez-la dans « Rechercher l’adresse » (ou « Ma position ») et épinglez-la, remplissez « Libellé » et « Adresse / point de repère ». La corbeille en retire une.',
                    'Touchez « Enregistrer les modifications ».',
                ],
                notes: [
                    'Chaque adresse doit être épinglée sur la carte. Un site qui stocke encore des produits ne peut pas être retiré avant leur déplacement.',
                ],
            },
        },
    }),
    T({
        key: 'agencyverification',
        app: 'agency',
        path: '/dashboard/account/verification',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: identity verification (needed for cash on delivery)',
                summary: 'Upload ID documents and submit the agency for verification',
                steps: [
                    'Open Account → "Verification".',
                    'Fill "National ID number" and the home address; "Upload" the ID card front and back, a selfie with the ID and the location sketches.',
                    'Save, then "Submit for verification" → "Send for review". After a rejection, fix and "Submit again".',
                ],
                notes: [
                    'Verification unlocks cash-on-delivery orders only; everything else works while it is pending.',
                    'Nothing can be changed while it is "Under review".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : vérification d’identité (nécessaire pour le paiement à la livraison)',
                summary: 'Téléverser les pièces d’identité et envoyer l’agence en vérification',
                steps: [
                    'Ouvrez Compte → « Vérification ».',
                    'Remplissez le numéro de carte nationale d’identité et l’adresse personnelle ; « Téléverser » recto et verso de la carte, un selfie avec la carte et les croquis.',
                    'Enregistrez, puis « Envoyer pour vérification » → « Envoyer pour examen ». Après un refus, corrigez et « Renvoyer ».',
                ],
                notes: [
                    'La vérification débloque seulement les commandes payées à la livraison ; tout le reste fonctionne en attendant.',
                    'Rien ne peut être modifié pendant « En cours d’examen ».',
                ],
            },
        },
    }),
    T({
        key: 'agencysecurity',
        app: 'agency',
        path: '/dashboard/account/security',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: password, sign-in email and phone, activating the account',
                summary: 'Change the password or sign-in email/phone; verify the phone to activate the account',
                steps: [
                    'Open Account → "Security".',
                    'Password: current, new (8+ characters with upper case, lower case, number, special character), confirm → "Update Password".',
                    'Email: "Change" → new address → "Send confirmation", then open the link. Phone: "Change" → new number → "Send the code" → six-digit code → "Verify".',
                    'Account not active yet ("Verify my phone" on Overview): "Send a code on WhatsApp" → type the code → "Verify".',
                ],
                notes: [
                    'Changing the password signs out other sessions. Changing email or phone takes effect only once confirmed.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : mot de passe, e-mail et téléphone, activation du compte',
                summary: 'Changer le mot de passe ou l’e-mail/téléphone ; vérifier le téléphone pour activer le compte',
                steps: [
                    'Ouvrez Compte → « Sécurité ».',
                    'Mot de passe : actuel, nouveau (8+ caractères avec majuscule, minuscule, chiffre, caractère spécial), confirmation → « Mettre à jour le mot de passe ».',
                    'E-mail : « Modifier » → nouvelle adresse → « Envoyer la confirmation », puis ouvrez le lien. Téléphone : « Modifier » → nouveau numéro → « Envoyer le code » → code à six chiffres → « Vérifier ».',
                    'Compte pas encore actif (« Vérifier mon téléphone » sur la Vue d’ensemble) : « Envoyer un code sur WhatsApp » → saisissez le code → « Vérifier ».',
                ],
                notes: [
                    'Changer le mot de passe déconnecte les autres sessions. Un changement d’e-mail ou de téléphone ne compte qu’une fois confirmé.',
                ],
            },
        },
    }),
    T({
        key: 'agencyplan',
        app: 'agency',
        path: '/dashboard/account/billing',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: plan, credits and media storage',
                summary: 'See the plan and shipment cap, upgrade, buy credits, expiry reminders',
                steps: [
                    'Open Account → "Billing". The top card shows the plan, "Active shipments" against the cap and whether live tracking is included.',
                    'Upgrade: "Plans" → "Choose plan" → pay with Mobile Money (number → "Pay now", approve on the phone) or "Card payment".',
                    'Credits: "Credit wallet" → "Buy" on a pack. "Expiry reminders" → "Days before expiry" → "Save".',
                ],
                notes: [
                    'A plan bought now starts when the current one ends. At the cap, deliveries keep flowing.',
                    'In the Android app, card payment is done on the web dashboard; mobile money works in the app.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : forfait, crédits et stockage',
                summary: 'Voir le forfait et le plafond d’expéditions, changer de forfait, acheter des crédits, rappels',
                steps: [
                    'Ouvrez Compte → « Facturation ». La carte du haut montre le forfait, les expéditions actives face au plafond et si le suivi en direct est inclus.',
                    'Changer : « Forfaits » → « Choisir ce forfait » → payer par Mobile Money (numéro → payer, valider sur le téléphone) ou par carte.',
                    'Crédits : « Portefeuille de crédits » → « Acheter » sur un pack. « Rappels d’expiration » → nombre de jours → « Enregistrer ».',
                ],
                notes: [
                    'Un forfait acheté maintenant commence à la fin de l’actuel. Au plafond, les livraisons continuent.',
                    'Dans l’app Android, le paiement par carte se fait sur le tableau de bord web ; le mobile money marche dans l’app.',
                ],
            },
        },
    }),
    T({
        key: 'agencypayout',
        app: 'agency',
        path: '/dashboard/account/payout',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: earnings, withdrawing money, payout numbers',
                summary: 'See available, pending and reserve earnings; withdraw; set payout mobile-money numbers',
                steps: [
                    'Open Account → "Payout" (phone: the "Payout" tab in the bottom bar).',
                    '"Earnings" shows "Available", "Pending" (up to 3 days after your parcel is delivered, by your returns and damage-claim terms — none of either: the night after the delivery is confirmed), "Reserve" and "Requested". Tap "Withdraw …" — it takes the whole available balance. Follow it with "View in Tickets".',
                    '"Payout Methods" → "Add payout method" → "Mobile Money", "Provider", "Phone Number", "Account Name" → "Save method", then "Save changes". Up to 3; the first is preferred.',
                ],
                notes: [
                    'Minimum 10,000 XAF; one request at a time. At 2,000,000 XAF available, a payout is requested automatically.',
                    'For cash-on-delivery orders, earnings wait for the customer\'s code and for the cash to reach Wi-Mall. Bank and card payouts are coming later.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : gains, retirer de l’argent, numéros de versement',
                summary: 'Voir les gains disponibles, en attente et en réserve ; retirer ; choisir les numéros de versement',
                steps: [
                    'Ouvrez Compte → « Versements » (téléphone : l’onglet « Versements » de la barre du bas).',
                    '« Revenus » montre « Disponible », « En attente » (jusqu’à 3 jours après la livraison de votre colis, selon vos conditions de retours et de réclamations pour dommages — sans l’un ni l’autre : la nuit après la confirmation de la livraison), « Réserve » et « Demandé ». Touchez « Retirer … » — tout le solde disponible part. Suivez-le avec « Voir dans les tickets ».',
                    '« Moyens de versement » → « Ajouter un moyen de versement » → « Mobile Money », « Opérateur », numéro, « Nom du titulaire » → « Enregistrer le moyen », puis « Enregistrer les modifications ». Jusqu’à 3 ; le premier est préféré.',
                ],
                notes: [
                    'Minimum 10 000 XAF ; une demande à la fois. À 2 000 000 XAF disponibles, un versement est demandé automatiquement.',
                    'Pour les commandes en espèces, les gains attendent le code du client et l’arrivée des espèces chez Wi-Mall. Banque et carte : plus tard.',
                ],
            },
        },
    }),
    T({
        key: 'agencytracking',
        app: 'agency',
        path: '/dashboard/tracking',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: live map of agents',
                summary: 'Watch agents on active shipments on the map, see ETA, find why an agent shows no position',
                steps: [
                    'Open "Live Tracking" (or the agent\'s name on a shipment → "Track this agent on the live map").',
                    'Pick an agent or delivery in the "Agents" list to focus it; "Fit all agents" shows everyone. The selected delivery shows pickup, drop-off and the ETA.',
                ],
                notes: [
                    'Only agents carrying an active shipment for the agency appear. An agent card explains a missing position (location off, sharing off, app not connected).',
                    'Live tracking depends on the plan (Billing shows "Live tracking: Included / Not included").',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : carte en direct des livreurs',
                summary: 'Suivre les livreurs en course sur la carte, voir l’heure d’arrivée, savoir pourquoi une position manque',
                steps: [
                    'Ouvrez « Suivi en direct » (ou le nom du livreur sur une expédition).',
                    'Choisissez un livreur ou une livraison dans la liste pour la centrer ; « Afficher tous les agents » montre tout le monde. La livraison choisie montre enlèvement, dépôt et heure d’arrivée.',
                ],
                notes: [
                    'Seuls les livreurs en course pour l’agence apparaissent. La carte d’un livreur explique une position manquante (localisation coupée, partage coupé, app déconnectée).',
                    'Le suivi en direct dépend du forfait (la Facturation indique s’il est inclus).',
                ],
            },
        },
    }),
    T({
        key: 'agencyreports',
        app: 'agency',
        path: '/dashboard/analytics',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: analytics and transactions',
                summary: 'Earnings, deliveries, cash and payouts over a period; list of money movements',
                steps: [
                    '"Analytics": choose the "Period"; see "Earnings" (net earnings, agents\' shares, COD fees), "Delivery outcomes", "Cash on delivery", "By agent" and "Payouts".',
                    '"Transactions": every plan, credit, earning and payout movement; filter by "Category".',
                ],
                notes: [
                    'Figures are what was actually credited, not estimates. Analytics has no export button.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : statistiques et transactions',
                summary: 'Gains, livraisons, espèces et versements sur une période ; liste des mouvements d’argent',
                steps: [
                    '« Statistiques » : choisissez la « Période » ; voyez « Revenus » (nets, parts des livreurs, frais COD), « Issues des livraisons », « Paiement à la livraison », « Par livreur » et « Versements ».',
                    '« Transactions » : chaque mouvement de forfait, crédit, gain et versement ; filtrez par « Catégorie ».',
                ],
                notes: [
                    'Les chiffres sont ce qui a été réellement crédité, pas des estimations. Pas de bouton d’export dans les statistiques.',
                ],
            },
        },
    }),
    T({
        key: 'agencytickets',
        app: 'agency',
        path: '/dashboard/tickets',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: contacting Wi-Mall support (tickets)',
                summary: 'Open a support ticket, reply, escalate, close it',
                steps: [
                    'Open "Tickets" → "New ticket" (or Quick Actions → "New Ticket").',
                    'Fill "Subject", "Description", "Type", "Importance", "Related to" (a shipment, an order…) and attachments, then "Create ticket".',
                    'In a ticket: write a note → "Send"; "Escalate to support"; "Close ticket" when solved.',
                ],
                notes: [
                    'Importance cannot be changed later. Payout requests are tracked as tickets too.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : contacter le support Wi-Mall (tickets)',
                summary: 'Ouvrir un ticket, répondre, escalader, fermer',
                steps: [
                    'Ouvrez « Tickets » → « Nouveau ticket » (ou Actions rapides → « Nouveau ticket »).',
                    'Remplissez l’objet, la description, le type, l’importance, l’élément concerné (une expédition, une commande…) et des pièces jointes, puis « Créer le ticket ».',
                    'Dans un ticket : écrivez une note → envoyer ; « Escalader à l’assistance » ; « Fermer le ticket » une fois réglé.',
                ],
                notes: [
                    'L’importance ne peut pas être changée ensuite. Les demandes de versement sont aussi suivies en tickets.',
                ],
            },
        },
    }),
    T({
        key: 'agencymedia',
        app: 'agency',
        path: '/dashboard/media',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: media library and freeing storage',
                summary: 'Upload files, see where each is used, delete unused files to free space',
                steps: [
                    'Open "Media". "Upload" (or drag and drop) adds files.',
                    'Click a file for its details and "Where it\'s used"; "Delete file" removes it if nothing uses it.',
                ],
                notes: [
                    'Files in use must be detached first (e.g. clear the logo in Account → Store). Delivery proofs belong to the agent.',
                    'Limits: images 10 MB, PDF 25 MB, video 70 MB.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : médiathèque et libérer du stockage',
                summary: 'Téléverser des fichiers, voir où chacun sert, supprimer les inutiles',
                steps: [
                    'Ouvrez « Médias ». « Téléverser » (ou glisser-déposer) ajoute des fichiers.',
                    'Cliquez un fichier pour ses détails et son utilisation ; « Supprimer le fichier » le retire s’il ne sert à rien.',
                ],
                notes: [
                    'Un fichier utilisé doit d’abord être détaché (ex. retirer le logo dans Compte → Boutique). Les preuves de livraison appartiennent au livreur.',
                    'Limites : images 10 Mo, PDF 25 Mo, vidéo 70 Mo.',
                ],
            },
        },
    }),
    T({
        key: 'agencyclosure',
        app: 'agency',
        path: '/dashboard/account/closure',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: answering a request to close the agency account',
                summary: 'What to do when Wi-Mall asks to close the agency; it cannot be closed alone',
                steps: [
                    'The red banner "An administrator asked to close this agency account" → "Review request".',
                    'Clear everything under "Settle these first" (shipments, COD cash, remittances, payouts, balance, stock…).',
                    '"Close agency account": tick the box and type CLOSE to confirm. Or "Keep my agency account" → optional note → "Decline the request".',
                ],
                notes: [
                    'There is no other close button; closure only starts from an administrator\'s request and nothing changes unless the agency confirms. Doing nothing lets it expire.',
                    'Closing is permanent: agent contracts and vendor connections end. Other Wi-Mall roles keep working.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : répondre à une demande de fermeture du compte agence',
                summary: 'Que faire quand Wi-Mall demande la fermeture ; on ne peut pas fermer seul',
                steps: [
                    'La bannière rouge de demande de fermeture → « Voir la demande ».',
                    'Réglez tout ce qui est sous « À régler d’abord » (expéditions, espèces, reversements, versements, solde, stock…).',
                    '« Fermer le compte agence » : cochez la case et tapez FERMER pour confirmer. Ou « Garder mon compte agence » → note facultative → refuser la demande.',
                ],
                notes: [
                    'Pas d’autre bouton de fermeture ; elle ne part que d’une demande d’un administrateur et rien ne change sans confirmation. Sans réponse, elle expire.',
                    'La fermeture est définitive : contrats de livreurs et connexions vendeurs prennent fin. Les autres rôles Wi-Mall continuent.',
                ],
            },
        },
    }),
    T({
        key: 'agencynotifications',
        app: 'agency',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: notification settings (which events, which channel)',
                summary: 'Turn each agency notification on or off, choose the extra channel, save',
                steps: [
                    'Computer: in the left sidebar, at the bottom, open "Settings", then "Notifications". Phone or app: tap "More" in the bottom bar, then "Settings", then "Notifications". (Also: "Notification settings" on the Notifications page.)',
                    'Under "Events" there is one switch per event: "New shipments", "COD limit alerts", "Delivery fee changes", "Vendor connections", "Agent contracts", "Payout updates", "COD cash updates", "Plan updates", "Stock change requests", "Media storage alerts". Switch off the ones they do not want.',
                    'Under "Delivery channel", tap a connected channel (Telegram, Email or WhatsApp) to select it as the ONE extra channel; tap it again to go back to in-app only. A channel that is not connected shows "Connect" instead (topic agencychannels).',
                    'Nothing is saved yet: tap "Save changes" in the bar at the bottom ("Save" on a phone). "Discard" throws the changes away. They see "Notification settings saved".',
                ],
                notes: [
                    '"In-app" (the bell) is always on and cannot be turned off. Only ONE extra channel at a time.',
                    'A shipment sent past a cash-on-delivery limit arrives under "COD limit alerts", NOT under "New shipments" — turning COD limit alerts off hides those shipments\' alerts.',
                    'Turning off "COD cash updates" does not stop the 2-day clock: an unanswered agent cash declaration still freezes reserve releases. Turning off "Stock change requests" does not remove the vendor\'s request either.',
                    'No per-channel choice per event, no quiet hours. Notification language = the language set in Account → "Profile".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : réglages des notifications (quels événements, quel canal)',
                summary: 'Activer ou couper chaque notification de l’agence, choisir le canal en plus, enregistrer',
                steps: [
                    'Ordinateur : dans la barre latérale gauche, en bas, ouvrez « Paramètres », puis « Notifications ». Téléphone ou app : touchez « Plus » dans la barre du bas, puis « Paramètres », puis « Notifications ». (Aussi : « Paramètres de notification » sur la page Notifications.)',
                    'Sous « Événements », un interrupteur par événement : « Nouvelles expéditions », « Alertes de plafond COD », « Modifications des frais de livraison », « Connexions vendeurs », « Contrats de livreurs », « Mises à jour des versements », « Mises à jour des espèces COD », « Mises à jour du forfait », « Demandes de modification de stock », « Alertes de stockage média ». Coupez ceux dont ils ne veulent pas.',
                    'Sous « Canal de diffusion », touchez un canal connecté (Telegram, E-mail ou WhatsApp) pour en faire LE canal en plus ; touchez-le à nouveau pour revenir à l’application seule. Un canal non connecté affiche « Connecter » (sujet agencychannels).',
                    'Rien n’est encore enregistré : touchez « Enregistrer les modifications » dans la barre du bas (« Enregistrer » sur téléphone). « Abandonner » annule. Ils voient « Paramètres de notification enregistrés ».',
                ],
                notes: [
                    '« Dans l’application » (la cloche) est toujours actif et ne peut pas être coupé. Un seul canal en plus à la fois.',
                    'Une expédition envoyée au-delà d’un plafond COD arrive sous « Alertes de plafond COD », PAS sous « Nouvelles expéditions » — couper les alertes COD masque ces expéditions.',
                    'Couper « Mises à jour des espèces COD » n’arrête pas le délai de 2 jours : une déclaration d’espèces sans réponse gèle toujours les libérations de réserve. Couper « Demandes de modification de stock » ne supprime pas non plus la demande du vendeur.',
                    'Pas de choix de canal par événement, pas d’heures calmes. Langue des notifications = celle réglée dans Compte → « Profil ».',
                ],
            },
        },
    }),
    T({
        key: 'agencychannels',
        app: 'agency',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: connecting Telegram, WhatsApp or email for notifications',
                summary: 'Connect (or disconnect) Telegram, WhatsApp or email so notifications can go there',
                steps: [
                    'Open Settings → "Notifications" (topic agencynotifications) and find the channel under "Delivery channel".',
                    'Telegram or WhatsApp: tap "Connect". Send /connect to the Wi-Mall bot on that app ("Open Telegram" / "Open WhatsApp" opens it; the copy icon copies the command). The bot replies with a 6-character code: type it in the code box and tap "Connect".',
                    'Email: tap "Connect". A verification link is sent to the agency email at once; open it, then tap "I\'ve done this — check". "Resend email" sends another.',
                    'When it says "… connected", tap "Done". Then tap that channel\'s row to select it and tap "Save changes".',
                    'To stop using Telegram or WhatsApp: tap "Disconnect" on its row (immediate). Notifications then fall back to in-app.',
                ],
                notes: [
                    'The code lasts 10 minutes and works once; a wrong or expired code clears the box — ask the bot for a new one.',
                    'Email has no "Disconnect". Connecting once applies to every role on the same Wi-Mall account.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : connecter Telegram, WhatsApp ou l’e-mail aux notifications',
                summary: 'Connecter (ou déconnecter) Telegram, WhatsApp ou l’e-mail pour y recevoir les notifications',
                steps: [
                    'Ouvrez Paramètres → « Notifications » (sujet agencynotifications) et trouvez le canal sous « Canal de diffusion ».',
                    'Telegram ou WhatsApp : touchez « Connecter ». Envoyez /connect au bot Wi-Mall sur cette application (« Ouvrir Telegram » / « Ouvrir WhatsApp » l’ouvre ; l’icône copier copie la commande). Le bot répond avec un code de 6 caractères : saisissez-le et touchez « Connecter ».',
                    'E-mail : touchez « Connecter ». Un lien de vérification part tout de suite vers l’e-mail de l’agence ; ouvrez-le, puis touchez « C’est fait — vérifier ». « Renvoyer l’e-mail » en envoie un autre.',
                    'Quand « … connecté » s’affiche, touchez « Terminé ». Puis touchez la ligne de ce canal pour le sélectionner et « Enregistrer les modifications ».',
                    'Pour arrêter Telegram ou WhatsApp : touchez « Déconnecter » sur sa ligne (immédiat). Les notifications reviennent alors à l’application.',
                ],
                notes: [
                    'Le code dure 10 minutes et ne sert qu’une fois ; un code faux ou expiré vide la case — demandez-en un nouveau au bot.',
                    'L’e-mail n’a pas de « Déconnecter ». Une seule connexion vaut pour tous les rôles du même compte Wi-Mall.',
                ],
            },
        },
    }),
    T({
        key: 'agencypush',
        app: 'agency',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: push notifications on a phone or browser',
                summary: 'Get pop-up alerts on this phone or computer even when the dashboard is closed',
                steps: [
                    'Open Settings → "Notifications". In the "Push notifications" block, on the row "This device", tap "Enable".',
                    'Allow notifications when the browser or phone asks. They see "Push notifications enabled on this device." The button becomes "Disable".',
                ],
                notes: [
                    'Per device: each browser or phone is enabled separately. Enable/Disable acts at once — no Save needed.',
                    'If it says "Notifications are blocked in your browser settings.", they must allow notifications for agency.wi-mall.com (or for the app in the phone settings) first.',
                    'On Android the alerts appear under "Agency alerts".',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : notifications push sur un téléphone ou un navigateur',
                summary: 'Recevoir des alertes sur ce téléphone ou cet ordinateur même tableau de bord fermé',
                steps: [
                    'Ouvrez Paramètres → « Notifications ». Dans le bloc « Notifications push », sur la ligne « Cet appareil », touchez « Activer ».',
                    'Autorisez les notifications quand le navigateur ou le téléphone le demande. Ils voient « Notifications push activées sur cet appareil. » Le bouton devient « Désactiver ».',
                ],
                notes: [
                    'Par appareil : chaque navigateur ou téléphone s’active séparément. Activer/Désactiver agit tout de suite — pas besoin d’enregistrer.',
                    'Si c’est écrit « Les notifications sont bloquées dans les réglages de votre navigateur. », il faut d’abord autoriser les notifications pour agency.wi-mall.com (ou pour l’app dans les réglages du téléphone).',
                    'Sur Android, les alertes apparaissent sous « Alertes de l’agence ».',
                ],
            },
        },
    }),
    T({
        key: 'agencyinbox',
        app: 'agency',
        path: '/dashboard/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Agency dashboard: reading notifications (the bell and the Notifications page)',
                summary: 'See, search, filter and mark notifications read; open what they are about',
                steps: [
                    'Computer: click the bell at the top for the 5 latest unread, or "View all notifications". Phone: tap "More" (it shows the unread count), then "Notifications". The sidebar also has "Notifications".',
                    'On the page: "Mark all as read", or the ✓ "Mark as read" on one row. Search with "Search notifications…"; filter by "Read status" ("All", "Unread", "Read"). 20 per page, with ‹ › to change page.',
                    'Tap a notification to open what it is about: the shipment, the vendor connection, the cash deposit, the stock request, the agent, the plan, and so on.',
                ],
                notes: [
                    'Notifications cannot be deleted. Search and filters apply to the page being shown.',
                ],
            },
            fr: {
                title: 'Tableau de bord agence : lire les notifications (la cloche et la page Notifications)',
                summary: 'Voir, chercher, filtrer, marquer comme lues ; ouvrir ce qu’elles concernent',
                steps: [
                    'Ordinateur : cliquez sur la cloche en haut pour les 5 dernières non lues, ou « Voir toutes les notifications ». Téléphone : touchez « Plus » (il affiche le nombre de non lues), puis « Notifications ». La barre latérale a aussi « Notifications ».',
                    'Sur la page : « Tout marquer comme lu », ou le ✓ « Marquer comme lu » sur une ligne. Cherchez avec « Rechercher des notifications… » ; filtrez par « Statut de lecture » (« Toutes », « Non lues », « Lues »). 20 par page, ‹ › pour changer de page.',
                    'Touchez une notification pour ouvrir ce qu’elle concerne : l’expédition, la connexion vendeur, le dépôt d’espèces, la demande de stock, le livreur, le forfait, etc.',
                ],
                notes: [
                    'Les notifications ne peuvent pas être supprimées. La recherche et les filtres portent sur la page affichée.',
                ],
            },
        },
    }),
]);
