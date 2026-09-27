# The Bargain button — opening a haggle in the chat

For the storefront (`wi-mall.com`, landing app). This page covers the **Bargain** button on a product
whose selected variant has `negotiable === true` (`catalog.md`). Pressing it opens the WhatsApp or
Telegram bot, and the first message starts a bargain on that exact product and variant, the same way
a `bargain:<productId>:<variantId>` button inside the chat does.

This is not an HTTP endpoint. The contract is **the text of a link**. You call nothing: the chat
delivers that text to the bot, and the backend reads it.

Backend: `src/modules/bot-commands/domain/bargain-entry.ts` (grammar) ·
`src/modules/bot-surface/services/bargain-entry.service.ts` (behaviour) ·
`npm run test:bargain-entry`.

---

## 1 · The two links

| Channel | Link | What the bot receives |
|---|---|---|
| **WhatsApp** | `https://wa.me/237652705926?text=<url-encoded message>` | the message, after the customer presses Send |
| **Telegram** | `https://t.me/WiMallBot?start=bargain_<productId>_<variantId>` | the text `/start bargain_<productId>_<variantId>` |

Both ids are 24-hex MongoDB ObjectIds, taken from the product detail you already load. **Never put a
price in either link.** The bot reads the price live.

### WhatsApp message

```
/bargain <productId> <variantId>
<one sentence in the page's language>
```

- **The first line is the machine part and must come first.** n8n sends a message to the backend's
  command parser only when its first character is `/`. Keep `/bargain` in English in every language;
  it is a command name, not copy.
- **The second line is optional and is only for the human.** It is shown in the customer's compose box
  before they send. The backend ignores everything after the second id, so translate it freely,
  for example *"I'd like to negotiate the price of this item."* / *« Je voudrais négocier le prix de
  cet article. »*
- URL-encode the whole message, newline included (`%0A`).
- The customer can edit the text before sending. That is fine. An edited or deleted id is refused in
  words (§ 4). It is never guessed at.

### Telegram payload

`bargain_<productId>_<variantId>` is **57 characters**, within Telegram's limit of 64 characters from
`[A-Za-z0-9_-]`. There is no colon (Telegram refuses one) and nothing else goes in it. When the user
presses **Start**, Telegram sends `/start bargain_…` as an ordinary message.

### The variant

**Send the variant the visitor selected.** Negotiability is set per variant, so the product alone
is ambiguous. The links also accept the product id alone (`/bargain <productId>`,
`bargain_<productId>`), which means "the product's default variant". Use that form only for a
product with a single variant. If you name a variant that no longer exists, the link is refused.
The bot does not switch to a different variant.

**Quantity is always 1.** If the customer then says "I'll take three", the bargaining agent handles
it in the conversation.

---

## 2 · The visitor's state does not change the link

Build the same link whether the visitor is signed out, signed in on the web with no chat connected,
or fully connected. The bot knows the customer by their **chat identity** (WhatsApp number,
Telegram chat), not by the web session, and the flows below cover every chat state.

**Language:** the bot answers in the chat account's language, or in the device language for a new
chat. The page's language (`en/fr/pt/es/ar`) only chooses the wording of the WhatsApp second line.
It is not sent to the bot, and nothing needs it.

---

## 3 · What the customer sees

| Chat state | First reply | Then |
|---|---|---|
| Known customer, setup finished | **Product title + "Make me an offer — what would you like to pay for this?"** | The customer's answer goes to the bargaining agent. |
| New on **WhatsApp** (the account is created on their first message) | Product title + *"Happy to talk price on this. First, a quick question so I can set you up — then we'll haggle."* + the first setup question, with its own button | Once the last setup question is answered, the price question is asked instead of the usual welcome. |
| Known but setup unfinished | Same as the row above | Same |
| New on **Telegram** (no account until they share their contact) | The **Share contact** request | The product is kept. After setup, the price question is asked, as above. |

The product is kept for **30 minutes** (the same lifetime as a bargain session). Past that, setup ends
with the ordinary welcome and the product is forgotten. The customer can press the button again.

---

## 4 · Refusals

Every refusal is answered **in the customer's language** and never reaches the AI.

| Situation | What the bot says |
|---|---|
| **No longer negotiable** (the vendor closed the price window) | Title + *"This one has a fixed price now, so there is nothing to haggle. Would you like it anyway?"* with **one** button: **Add to cart** (a digital product gets **Buy now**, a service gets **Book**). **Nothing is added until they press it.** |
| **Out of stock**, or the variant is gone | *"That one is sold out just now. Pick another option, or ask me for something similar."* |
| Product **removed**, unpublished or suspended | The catalogue's "not found" sentence |
| An id that is **malformed or was edited** | The same "I didn't recognise that" answer a broken chat button gets |

⚠ This differs from a bargain button inside the chat. A chat button whose product became fixed-price
adds the item to the basket. The website link only **offers** it (owner decision, 2026-09-27): the
visitor asked to haggle, not to buy.

---

## 5 · Deploy order

**The backend must be live before the button.** Until it is:

- WhatsApp `/bargain …` gets *"unknown command"*, and the product is lost.
- Telegram `/start bargain_…` gets the plain welcome, and the payload is ignored.

No n8n change is needed. n8n already forwards every `/`-message to the backend, and it already routes
the answer to the bargaining agent from the hand-off the backend records (`pendingBargain` on
`/identity/sync`, `../n8n/bot-surface.md`).

**Test on a phone, on both channels, before switching the button on.** The offline suite pins the
grammar and the wiring. Only a real chat proves that the offer reaches the bargaining agent.

---

## 6 · Known edges

- **A fixed-price answer arriving mid-setup.** If the product became fixed-price and the customer is
  still in setup, pressing **Add to cart** on that message during setup brings the setup question
  back rather than adding the item. They can ask again once setup is done. This is rare (two
  unlikely conditions together) and left as is.
- **Two Bargain presses before replying:** the later one wins, the same as the in-app screen.
