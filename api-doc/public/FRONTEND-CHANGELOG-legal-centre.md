# FRONTEND CHANGELOG — the Legal Centre (2026-10-05)

**Audience:** the landing site (website + shop + customer area). **No API changed.** The legal
documents were rewritten and expanded into a **Legal Centre** of seven documents plus a hub, in
English and French, published on the CDN. Today the site links only Terms and Privacy and keeps
its own copy of the cookie text. This changelog lists every document and where it must be linked.

## The documents

All are published at `https://cdn.wi-mall.com/legal/<slug>-<lang>.html`, with a PDF at the same
path ending in `.pdf`. `<lang>` is `fr` for a French UI and `en` for every other language (es, pt
and ar included), the rule `src/lib/legal.ts` already applies. **Link the `.html` page**: it has
its own language switch, "Download PDF" and print buttons.

| Slug | Document | Who it is for |
|---|---|---|
| `legal-centre` | **Legal Centre** — the hub that links all the others | everyone |
| `terms-of-service` | Terms of Service (v2.0) | everyone |
| `privacy-policy` | Privacy Policy (v1.1) | everyone |
| `returns-refunds-policy` | Returns, Refunds & Cancellations Policy | customers, sellers |
| `cookie-policy` | Cookie Policy | everyone |
| `prohibited-items-policy` | Prohibited & Restricted Items Policy | sellers, everyone |
| `seller-agreement` | Seller Agreement | sellers |
| `delivery-partner-agreement` | Delivery Partner Agreement | agencies, couriers |

The two existing slugs (`terms-of-service`, `privacy-policy`) keep their URLs, so nothing linked
today breaks.

## Where each must be linked

| Place | Today | Change |
|---|---|---|
| **Footer → Legal** | Privacy, Terms, Cookie Policy → `/cookies` | **Legal Centre** first, then Terms, Privacy, **Returns & Refunds**, **Cookie Policy → the CDN page** |
| **Sign-up, seller** | "I agree to the Terms and Privacy Policy" | "I agree to the Terms of Service, the **Seller Agreement** and the Privacy Policy" — same `terms_accepted: true` |
| **Sign-up, agency or courier** | same | "… the Terms of Service, the **Delivery Partner Agreement** and the Privacy Policy" |
| **Add a role** (`/add-role`) | same as sign-up | the agreement for the role being added, as above |
| **Sign-up, customer** (WhatsApp CTA line) | Terms + Privacy | unchanged |
| **Checkout**, under the pay button | Terms only | "By placing this order, you agree to our Terms of Service and **Returns & Refunds Policy**." |
| **Product page → policies tab** | the seller's own return and cancellation terms | add one line under them: "Your rights under Wi-Mall's **Returns & Refunds Policy** apply whatever the seller's terms." |
| **Customer refund panel** (`RefundPanel`) | no link | a "How refunds work" link to the Returns & Refunds Policy |
| **Customer account → Legal** | Terms, Privacy | add **Legal Centre**, Returns & Refunds, Cookie Policy |
| **Cookie notice → "Learn more"** | `/cookies` | the CDN Cookie Policy |
| **Marketing `/vendors`** | none | links to the **Seller Agreement** and the **Prohibited Items Policy** |
| **Marketing `/agencies`, `/agents`** | none | link to the **Delivery Partner Agreement** |

## Retire the site's own `/cookies` page

`/[locale]/(marketing)/cookies` holds its own text (dated 2026-09-28). The Cookie Policy on the CDN is
now the record, and two texts will drift. Replace the page with a permanent redirect, as already done
for `/privacy` and `/terms` in `next.config.ts`: `/cookies` → `cookie-policy-en.html` and
`/fr/cookies` → `cookie-policy-fr.html`. Remove `/cookies` from the sitemap (`src/lib/marketing/routes.ts`).
Add `/legal` → `legal-centre-en.html` and `/fr/legal` → `legal-centre-fr.html` the same way.

## Notes

- The backend records only **that** a business user accepted, never which document versions, so changing
  the checkbox wording needs no API change. The field is still `terms_accepted: true`.
- Keep opening links outside the native WebView in the Capacitor build (`LegalLink` already does), so the
  page's PDF download works.
