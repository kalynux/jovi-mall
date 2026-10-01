import { workflow, trigger, tool, sticky } from '@n8n/workflow-sdk';

const auth_send_login_link = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "auth_send_login_link",
    position: [40,328],
    parameters: {
      "toolDescription": "Sends the customer a sign-in link and an 8-character code for the WEBSITE, straight to this chat. Both last 10 minutes; using one cancels the other. USE IT WHEN: The customer asks, in their own words, to sign in on the website or for their login code or link. NOT THIS TOOL: Not needed to shop in the chat. Not for a vendor, agency or agent — they use /reset-password. ⚠ The result carries NO code, link or token — say it has been sent and stop.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/auth/login-link",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-auth_send_login_link"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const catalog_search_products = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_search_products",
    position: [240,328],
    parameters: {
      "toolDescription": "Exact FILTERED product search: whole-word text plus filters Search-Products does not have — one shop (storeSlug), a price range with a minimum, product type (physical/digital/service) — and sorting (price_asc, price_desc, newest). USE IT WHEN: Only when the customer needs one of those filters or sorts: \"cheapest first\", \"between 5,000 and 10,000\", \"only from this shop\", \"services only\", \"newest\". NOT THIS TOOL: Not for an ordinary description of what they want, a typo, another language or a photo — that is Search-Products. `q` is whole-word: 'dres' does not find 'dress'. Not for a product code (catalog_resolve_sku) or one known product (catalog_get_product). ⚠ To show more than one result, pass the ids to Show-Products — never list them in your text.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/products",
      "sendQuery": true,
      "specifyQuery": "json",
      "jsonQuery": "={{ JSON.stringify({ q: $fromAI(\"q\", \"Whole-word text search. Searching 'dres' will NOT find 'dress' — pass the customer's words, not a prefix. At most 200 characters.\", \"string\") || undefined, category: $fromAI(\"category\", \"Exact match. Get valid values from catalog_list_categories; do not invent one.\", \"string\") || undefined, type: $fromAI(\"type\", \"One of: physical, digital, service.\", \"string\") || undefined, storeSlug: $fromAI(\"storeSlug\", \"Narrow to one seller, by the slug from a product card's store.slug. Leave empty unless the customer named a shop.\", \"string\") || undefined, minPrice: $fromAI(\"minPrice\", \"Whole units of currency.\", \"number\") || undefined, maxPrice: $fromAI(\"maxPrice\", \"Whole units of currency.\", \"number\") || undefined, inStock: $fromAI(\"inStock\", \"Only 'true' narrows. There is no way to ask for out-of-stock items. One of: true.\", \"string\") || undefined, sort: $fromAI(\"sort\", \"There is no popularity sort and asking for one is a 400, not a silent fallback. One of: newest, price_asc, price_desc, relevance.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_get_product = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_get_product",
    position: [440,328],
    parameters: {
      "toolDescription": "Everything about one product: description, images, options, every variant with its own price and stock, the store, and its return and cancellation policies. USE IT WHEN: Before answering a question about a specific product, and always before adding one to the basket — the variant id comes from here. NOT THIS TOOL: Not for browsing; search results are enough to choose from. ⚠ A service variant's price is a UNIT RATE per durationMinutes — quote priceFrom with priceUnit, or the customer is misquoted.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/products/{{ $fromAI(\"productId\", \"The 24-character product id. Never a SKU and never a slug.\", \"string\") }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_get_product_by_slug = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_get_product_by_slug",
    position: [640,328],
    parameters: {
      "toolDescription": "The same product detail as catalog_get_product, looked up from a shared storefront link (store slug + product slug). USE IT WHEN: The customer pastes a storefront product link. Both slugs are required. NOT THIS TOOL: When you already have the product id — use catalog_get_product.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/stores/{{ $fromAI(\"storeSlug\", \"The seller's slug — the first slug in a storefront product URL, or a product card's store.slug.\", \"string\") }}/products/{{ $fromAI(\"productSlug\", \"The product's slug — the second slug in a storefront product URL, or a product card's slug. Never the 24-character id.\", \"string\") }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_resolve_sku = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_resolve_sku",
    position: [840,328],
    parameters: {
      "toolDescription": "Turns a product code printed on a package, label or advert into the product and variant it identifies. USE IT WHEN: The customer types something that looks like a product code rather than words. NOT THIS TOOL: Not for words — use Search-Products.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/variants/by-sku/{{ $fromAI(\"sku\", \"The code as the customer typed it. Case is forgiven both ways (as-typed, upper and lower are all tried, and the as-typed spelling wins), EXCEPT for a SKU stored in mixed case, which resolves only when typed exactly. Send it unchanged — do not upper-case it first, or the as-typed rule works against you. At most 64 characters.\", \"string\") }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_list_categories = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_list_categories",
    position: [1040,328],
    parameters: {
      "toolDescription": "The categories that currently have products for sale, with a count each. Data only; it draws nothing. USE IT WHEN: To get exact category names before filtering a search by category — the names must come from this list. NOT THIS TOOL: Not to SHOW categories to the customer — that is catalog_browse_categories. Not instead of a search when they already described what they want.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/categories",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_list_related_products = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_list_related_products",
    position: [1240,328],
    parameters: {
      "toolDescription": "Up to eight products related to one product, and which kind of relation it is (meta.source). USE IT WHEN: After showing a product, when the customer asks for alternatives or similar items. To show them, pass their ids to Show-Products. NOT THIS TOOL: Never say 'customers also bought' unless meta.source is co_purchase; same_category means 'more in this category'. ⚠ An empty list is a successful answer.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/products/{{ $fromAI(\"productId\", \"The 24-character id of the product to find alternatives for.\", \"string\") }}/related",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_get_store = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_get_store",
    position: [1440,328],
    parameters: {
      "toolDescription": "A seller's public page: name, description, city, verified, currently open, and the support contacts they published. USE IT WHEN: The customer asks who sells something or how to contact a seller. NOT THIS TOOL: Not for the delivery company's contacts — those come from orders_list_shipments. ⚠ Any contact field may be null. A closed store (isOpen false) still sells — say 'the seller is on holiday', never 'unavailable'.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/stores/{{ $fromAI(\"slug\", \"The seller's slug, from a product card's store.slug.\", \"string\") }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_list_store_products = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_list_store_products",
    position: [40,528],
    parameters: {
      "toolDescription": "What one seller currently has for sale. USE IT WHEN: The customer wants to see more from a seller they have already seen. NOT THIS TOOL: To also filter or sort within that shop, use catalog_search_products with storeSlug instead.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/stores/{{ $fromAI(\"slug\", \"The seller's slug, from a product card's store.slug.\", \"string\") }}/products",
      "sendQuery": true,
      "specifyQuery": "json",
      "jsonQuery": "={{ JSON.stringify({ q: $fromAI(\"q\", \"Whole-word text search inside this seller's products. Searching 'dres' will NOT find 'dress' — pass the customer's words, not a prefix. At most 200 characters.\", \"string\") || undefined, sort: $fromAI(\"sort\", \"One of: newest, price_asc, price_desc, relevance.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const catalog_list_product_reviews = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_list_product_reviews",
    position: [240,528],
    parameters: {
      "toolDescription": "Raw review rows and the star breakdown for one product, for your own reasoning. USE IT WHEN: You need to read what buyers actually wrote to answer a specific question. NOT THIS TOOL: To SHOW reviews to the customer use catalog_product_reviews_summary. Not for delivery reviews — they are internal. ⚠ rating null means nobody has reviewed it — never say zero stars.",
      "method": "GET",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/public/products/{{ $fromAI(\"productId\", \"The 24-character id of the product whose reviews to read.\", \"string\") }}/reviews",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
  },
  output: [{ success: true }],
});

const cart_get = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "cart_get",
    position: [440,528],
    parameters: {
      "toolDescription": "What is in the customer's basket, line by line, with quantities and prices. USE IT WHEN: The customer asks about their basket, and before adding something that may already be there. NOT THIS TOOL: Not for the total with delivery — checkout_review shows that. ⚠ An empty basket is a successful answer (items: []), never an error.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/cart/get",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const cart_add_item = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "cart_add_item",
    position: [640,528],
    parameters: {
      "toolDescription": "Puts a product variant in the basket; if that exact variant is already there, its quantity goes up. USE IT WHEN: The customer asks to add something and you hold the variant id from catalog_get_product. NOT THIS TOOL: Never guess a variant id, and never add a product with more than one variant without asking which one (or open it with inapp_open_product). Never a service — services are booked, not added. ⚠ A basket may hold items from several shops but only ONE product type, and never a service.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/cart/items",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-cart_add_item"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, productId: $fromAI(\"productId\", \"The 24-character product id, from catalog_get_product or a product search result.\", \"string\"), variantId: $fromAI(\"variantId\", \"The sellable unit. Must belong to productId. A 24-character hexadecimal id.\", \"string\"), quantity: $fromAI(\"quantity\", \"This ADDS to any quantity already on the line. To set an exact number use cart_set_item_quantity. Between 1 and 999.\", \"number\") || undefined, negotiationLockRef: $fromAI(\"negotiationLockRef\", \"The agreed-price reference from a price negotiation, when the system prompt has given you one AND this is the exact item and quantity that was negotiated. Pass it so the customer is charged the price they agreed instead of the shelf price. Never show it or mention it to the customer, and never pass it for any other product. If the call is refused because of it, add the item again without it. At most 200 characters.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const cart_set_item_quantity = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "cart_set_item_quantity",
    position: [840,528],
    parameters: {
      "toolDescription": "Sets a basket line to exactly this quantity. USE IT WHEN: The customer names the number they want — 'make it three'. NOT THIS TOOL: Not to remove a line (zero is refused) — use cart_remove_item.",
      "method": "PATCH",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/cart/items/{{ $fromAI(\"variantId\", \"The variant id of the basket line to change, from cart_get items[].variantId. A 24-character hexadecimal id.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-cart_set_item_quantity"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, quantity: $fromAI(\"quantity\", \"Absolute, not a change. Between 1 and 999.\", \"number\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const cart_remove_item = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "cart_remove_item",
    position: [1040,528],
    parameters: {
      "toolDescription": "Takes one variant out of the basket. USE IT WHEN: The customer asks to remove a specific item. NOT THIS TOOL: Not to empty the whole basket — you cannot do that; remove items one by one only if they ask.",
      "method": "DELETE",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/cart/items/{{ $fromAI(\"variantId\", \"The variant id of the basket line to remove, from cart_get items[].variantId. A 24-character hexadecimal id.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-cart_remove_item"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const checkout_review = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "checkout_review",
    position: [1240,528],
    parameters: {
      "toolDescription": "Live order summary for the basket: lines, total (formatted), delivery address (a SAVED one — the default unless deliveryAddressId is given) and the masked mobile-money number. Places nothing. Returns a single-use checkoutRef (10 minutes) for checkout_place. ⚠ When ready is true and payment.phoneMasked is set, THIS TOOL SENDS THE CUSTOMER the summary with Place order / Not now buttons (or one button per address when several are deliverable and none was named): answer [sent] — never repeat it or ask again. With no saved address it sends the website link itself. ⚠ blocker below_delivery_minimum: no checkoutRef; the tool sends how much more to add from each shop — do not repeat it. USE IT WHEN: The customer wants to check out / buy / pay for their basket. Call it again with deliveryAddressId for a different saved address. NOT THIS TOOL: Never ask for an address or phone number the review shows, and never collect an address in the chat. no_saved_address / address_not_deliverable: offer a deliverable saved address or send addAddressUrl. address_not_found: call addresses_list and ask again. below_delivery_minimum: help them add more from THAT shop (another shop's item is a separate order and does not help), then review again; never mention the delivery fee or the seller's commission. ⚠ payment.phoneMasked null: nothing was sent — ask for a number, then pass it as `phone` to checkout_place.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/checkout/chat/review",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-checkout_review"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, deliveryAddressId: $fromAI(\"deliveryAddressId\", \"Optional. The id of one of the customer's saved addresses (from `addresses` or addresses_list). Omit for their default. A 24-character hexadecimal id.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const checkout_place = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "checkout_place",
    position: [1440,528],
    parameters: {
      "toolDescription": "Spends the checkoutRef: creates the orders (prices re-resolved, agreed price locks honoured) and sends a mobile-money prompt to the account's wallet; the result arrives later in the chat. ⚠ On success THIS TOOL SENDS THE CUSTOMER the order numbers and payment instructions with a Check status button — or, if the charge was refused at once (state failed), that no money was taken, with Try again. Do not repeat any of it. USE IT WHEN: Only right after checkout_review returned ready: true AND the customer explicitly confirmed its total, address and masked number in words. NOT THIS TOOL: Never without that confirmation, never twice, never with an invented checkoutRef, never after they tapped Place order (that already placed it). If customer.pendingQuestion.context is 'co', use chat_answer_question instead. Pass deliveryAddressId = the review's delivery.address.id (required for physical goods); pass phone only if the customer typed a different number. On an error whose details.spent is not false, do NOT place again — use checkout_payment_status. ⚠ state 'failed': the orders exist but NO prompt is coming — say so and offer checkout_retry_payment. state 'waiting': tell them to approve on their phone; the result arrives as a message.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/checkout/chat/place",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-checkout_place"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, checkoutRef: $fromAI(\"checkoutRef\", \"Exactly as checkout_review returned it. Single use, ten minutes.\", \"string\"), deliveryAddressId: $fromAI(\"deliveryAddressId\", \"The delivery.address.id from the review. Required for physical goods; omit for downloads. A 24-character hexadecimal id.\", \"string\") || undefined, phone: $fromAI(\"phone\", \"Only a mobile-money number the customer typed, exactly as they typed it (the country code is optional: without one, the account's own country is used). Omit to use the account's.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const checkout_payment_status = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "checkout_payment_status",
    position: [40,728],
    parameters: {
      "toolDescription": "Asks the payment gateway live whether the customer's most recent checkout payment is settled, failed or still waiting. Takes no transaction id. USE IT WHEN: The customer asks whether their payment went through, or says they approved it. NOT THIS TOOL: Never invent a transaction id. waiting is NOT failed: ask them kindly to be patient (it can take a few minutes; a message arrives when it lands) and never offer or send a new request while it waits.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/checkout/payment-status",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const checkout_retry_payment = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "checkout_retry_payment",
    position: [240,728],
    parameters: {
      "toolDescription": "Sends a fresh mobile-money charge for the still-unpaid orders of the most recent checkout, to the account's wallet or a number the customer typed. Creates no new order. USE IT WHEN: A checkout payment failed or was not approved and the customer agrees to try again. NOT THIS TOOL: Never for a new purchase (checkout_review), never while the last payment is still waiting (check checkout_payment_status first). Pass phone only if the customer typed a number.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/checkout/retry-payment",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-checkout_retry_payment"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, phone: $fromAI(\"phone\", \"Only a number the customer typed, exactly as they typed it (the country code is optional: without one, the account's own country is used).\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const payment_get_transaction = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "payment_get_transaction",
    position: [440,728],
    parameters: {
      "toolDescription": "The stored record of one of the customer's own payments, by transactionId. USE IT WHEN: The customer asks what happened to a specific payment and you hold its transactionId. NOT THIS TOOL: Not for the latest checkout payment — checkout_payment_status asks the gateway live.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/payments/{{ $fromAI(\"transactionId\", \"The payment's transaction id, from bookings_payment_status transaction.transactionId or from the payment that was just initiated. Must be one of this customer's own.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const orders_list_groups = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "orders_list_groups",
    position: [640,728],
    parameters: {
      "toolDescription": "Draws the customer's five most recent orders IN THE CHAT as a list they can pick from, with a Load more row — sent automatically. One entry per checkout, however many sellers. USE IT WHEN: Whenever they ask to see or check their orders ('my orders', 'what have I bought', 'did my order go through'), and first when you need an order they have not named. NOT THIS TOOL: Not for 'where is my parcel' — that is orders_list_shipments. Never type the orders out yourself. ⚠ paymentStatus is an aggregate: paid, awaiting_payment, partially_paid, refunded, failed, disputed, unknown or mixed.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/orders/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, status: $fromAI(\"status\", \"One of: pending, processing, partially_shipped, shipped, partially_delivered, delivered, fulfilled, cancelled, returned.\", \"string\") || undefined, paymentStatus: $fromAI(\"paymentStatus\", \"One of: pending, AWAITING_PAYMENT, partially_paid, paid, disputed, failed, refunded.\", \"string\") || undefined, q: $fromAI(\"q\", \"Substring over the order number and the line titles. At most 200 characters.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const orders_get_group = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "orders_get_group",
    position: [840,728],
    parameters: {
      "toolDescription": "Everything bought in one checkout, across every seller, with line items — and for cash orders, what each shipment is waiting to collect. USE IT WHEN: The customer wants the detail of one purchase that spanned several sellers. NOT THIS TOOL: Not for a single seller's order when you hold its id — use orders_get_order. ⚠ Never reveal a deliveryCode from this result — it is the customer's proof of payment and is never given out here.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/orders/groups/{{ $fromAI(\"cartId\", \"The order-group id, from orders_list_groups cartId. One checkout, not one seller’s order.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const orders_get_order = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "orders_get_order",
    position: [1040,728],
    parameters: {
      "toolDescription": "One seller's order in full: what was bought, what it cost, where it is going, and how each line is delivered. USE IT WHEN: The customer names an order number or follows up on one order from a list. NOT THIS TOOL: For a delivery question, pair it with orders_list_shipments.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/orders/{{ $fromAI(\"orderId\", \"The order id, or the order number the customer quoted — the bot surface accepts either.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const orders_list_shipments = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "orders_list_shipments",
    position: [1240,728],
    parameters: {
      "toolDescription": "Each parcel on an order: its stage, its history, the delivery company and its support contacts, and — while it is moving — the carrier's first name. USE IT WHEN: The answer to 'where is my order': every tracking, delivery-timing or delivery-problem question, and the delivery company's contacts. NOT THIS TOOL: There is no live map in chat — describe the stage, never a position. ⚠ Stages: preparing, shipped, out_for_delivery, delivered, delivery_failed. `agent` is often null — that is normal. Never give an agent's phone or full name; questions go to the delivery company. estimatedDelivery is always null — never invent a date.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/orders/{{ $fromAI(\"orderId\", \"One seller's order id, from orders_list_groups orders[].id. NOT the group's cartId.\", \"string\") }}/shipments",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const orders_record_cancellation_reason = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "orders_record_cancellation_reason",
    position: [1440,728],
    parameters: {
      "toolDescription": "Attaches the customer's own words about why they cancelled to that order's history, for the shop and support to read. USE IT WHEN: Right after a cancellation, when the customer tells you why. Send their words, not a summary. NOT THIS TOOL: It cancels nothing. Not for a complaint about a live order (that is a support request). Not twice for one order. ⚠ No `reply` comes back — acknowledge it briefly and kindly in your own words.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/orders/{{ $fromAI(\"orderId\", \"The order they cancelled, as the catalogue returned it. At most 64 characters.\", \"string\") }}/cancellation-reason",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-orders_record_cancellation_reason"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, reason: $fromAI(\"reason\", \"The customer's own words, relayed rather than summarised. At most 500 characters.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const profile_get_summary = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "profile_get_summary",
    position: [40,928],
    parameters: {
      "toolDescription": "The customer's profile in brief: name, language, currency, whether contacts are verified, and how many addresses are saved. Contact details come back masked. USE IT WHEN: The customer asks what the platform knows about them, or before a settings change. NOT THIS TOOL: Not for addresses — use addresses_list.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/profile",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const profile_update = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "profile_update",
    position: [240,928],
    parameters: {
      "toolDescription": "Changes the name the customer is called. The only profile field this tool can change. USE IT WHEN: They ask to be called something else, or correct their name. NOT THIS TOOL: Not for language (profile_set_language), phone, email or address. ⚠ The answer is the profile summary with contacts masked — confirm the new name, never read the number aloud.",
      "method": "PATCH",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/profile",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-profile_update"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, name: $fromAI(\"name\", \"The name the customer wants to be called, exactly as they gave it. Do not translate it or capitalise it differently. At most 100 characters.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const profile_set_language = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "profile_set_language",
    position: [440,928],
    parameters: {
      "toolDescription": "Sets the language the platform writes to this customer in — chat, notifications and email. USE IT WHEN: The customer asks to change language, or keeps writing in another language and confirms the switch. NOT THIS TOOL: Never on a single message in another language — people mix languages, and this also changes their emails. ⚠ Product text is NOT translated — it stays in the seller's language. Say so rather than appearing to translate it.",
      "method": "PATCH",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/profile/language",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-profile_set_language"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, language: $fromAI(\"language\", \"The five languages the platform's copy is written in. One of: en, fr, pt, es, ar.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const addresses_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "addresses_list",
    position: [640,928],
    parameters: {
      "toolDescription": "The customer's saved addresses, which one is the default, and whether each can actually be delivered to. USE IT WHEN: For checkout's address step, and when the customer asks where their orders go. NOT THIS TOOL: Not to add a new address — new addresses are added on the website. ⚠ An address with deliverable false is refused at checkout — present it as needing to be re-picked, never as a choice.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/addresses/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const support_resolve_contacts = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "support_resolve_contacts",
    position: [840,928],
    parameters: {
      "toolDescription": "For what the customer most recently dealt with, who to contact — the seller, the delivery company or the platform — with each one's published contacts and why. USE IT WHEN: For an 'I need help' that is not clearly about one thing, and as the first step of support: product → seller, parcel → delivery company, money or account → platform. NOT THIS TOOL: Not when you can answer from the catalogue or their orders yourself — a phone number is a worse answer than the actual answer. ⚠ Any contact may be null; offer those that exist, otherwise open a ticket. A delivery company has no contacts until an order has a shipment.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/support/context",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, scope: $fromAI(\"scope\", \"auto walks the relevance ladder. The others answer for one party only, and say so when there is no such party in context. One of: auto, vendor, agency, platform.\", \"string\") || undefined, hintProductId: $fromAI(\"hintProductId\", \"The product currently in focus in the conversation, if any. A product id (24 hex characters) — a slug is unique per vendor, not globally, so it cannot be resolved here. Overrides the server's own recency signal, and an id the customer cannot see is a 404 rather than a fall-through.\", \"string\") || undefined, hintOrderId: $fromAI(\"hintOrderId\", \"The order currently in focus, if any. An order id OR the order number the customer read out (as orders_get_order accepts). Wins over hintProductId when both are sent, and an order that is not theirs is a 404 rather than a fall-through.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const tickets_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "tickets_list",
    position: [1040,928],
    parameters: {
      "toolDescription": "The customer's open support tickets and their status. USE IT WHEN: They ask about a request they already made, or before opening a new one — add to an existing ticket rather than duplicating it. NOT THIS TOOL: Not as the answer to a first question — most are better answered directly. ⚠ assigned_admin is null until a person takes the ticket — say 'waiting to be picked up', never invent a handler.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/tickets/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, status: $fromAI(\"status\", \"Authoritative values are in agency/tickets.md. Omit to get open tickets.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const tickets_get = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "tickets_get",
    position: [1240,928],
    parameters: {
      "toolDescription": "One support ticket with its public conversation. USE IT WHEN: The customer names a ticket or asks what happened to a request. NOT THIS TOOL: Not for a list — use tickets_list. ⚠ Only public notes are returned — never imply a hidden conversation.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/tickets/{{ $fromAI(\"ticketId\", \"The ticket id or the TKT- number the customer quoted.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const tickets_add_note = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "tickets_add_note",
    position: [1440,928],
    parameters: {
      "toolDescription": "Adds the customer's message to an existing ticket, attributed to them. USE IT WHEN: The customer says something more about a ticket that is already open. NOT THIS TOOL: Never your own summary — staff read it as the customer's words.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/tickets/{{ $fromAI(\"ticketId\", \"The ticket id, from tickets_list.\", \"string\") }}/notes",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-tickets_add_note"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, body: $fromAI(\"body\", \"What the customer wants added to the ticket, in their own words. Do not summarise it. At most 5000 characters.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const tickets_add_attachment = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "tickets_add_attachment",
    position: [40,1128],
    parameters: {
      "toolDescription": "Puts a photo or PDF the customer just sent onto one of their tickets. The file is already stored; name it by the reference you were given. USE IT WHEN: The customer sent a file in this conversation as evidence for a support request. Open the ticket first if there is none. NOT THIS TOOL: Never invent a reference; without one the customer must send the file again. References expire after 30 minutes. ⚠ One call per file (single use). When attachmentCount equals attachmentLimit, say the next file will be refused. You cannot see the file — call it what the customer called it.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/tickets/{{ $fromAI(\"ticketId\", \"The ticket id or the TKT- number the customer quoted.\", \"string\") }}/attachments",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-tickets_add_attachment"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, ref: $fromAI(\"ref\", \"The file reference you were given when the customer sent the file, e.g. att_… . Copy it exactly; never construct one.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const chat_answer_question = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "chat_answer_question",
    position: [240,1128],
    parameters: {
      "toolDescription": "Answers the platform's waiting Yes/No question (customer.pendingQuestion) exactly as tapping its Yes or No button would: place the order (co), parcel arrived (cd), cancel the order (cnc), close the support request (tcl), disconnect the other app (unl). ⚠ THIS TOOL SENDS THE CUSTOMER the result, word for word what the tap sends — do not repeat or re-word it. USE IT WHEN: pendingQuestion is not null and the customer's message ANSWERS it in words, in any language: 'yes', 'ok', 'go ahead', 'place it', 'oui', 'sim', 'sí', 'نعم' → 'yes'; 'no', 'not now', 'leave it', 'non', 'não', 'لا' → 'no'. Check pendingQuestion.text to be sure the message is about THAT question. NOT THIS TOOL: Never when pendingQuestion is null, never for closing the account (button-only), never twice for one message or after a tap. A question is not an answer ('how much is delivery?') — answer it instead. If the message could mean either, ask. For a waiting Place order question (co) use THIS, not checkout_place. ⚠ The customer's own words ARE the confirmation — the question already named the total, the address, the order or the app.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/chat/answer",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-chat_answer_question"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, answer: $fromAI(\"answer\", \"'yes' when the customer's message agrees to the waiting question, 'no' when it declines it. One of: yes, no.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const catalog_browse_categories = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_browse_categories",
    position: [440,1128],
    parameters: {
      "toolDescription": "Shows the customer the shop's categories as tap buttons (the busiest five plus See all); a tap opens that category as a product grid. Sends its own message. USE IT WHEN: The customer wants to BROWSE: 'what do you sell?', 'show me your categories'. NOT THIS TOOL: Not to learn category names for a search filter (catalog_list_categories). Not when they named a category — use inapp_open_listing with category. ⚠ Its message already asks the question — answer [sent], add nothing.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/catalog/categories",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const catalog_product_reviews_summary = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_product_reviews_summary",
    position: [640,1128],
    parameters: {
      "toolDescription": "Shows a product's star rating, review count and two short recent quotes, with a button to read them all. Sends its own message. USE IT WHEN: The customer asks whether a product is good, or for reviews or opinions. NOT THIS TOOL: Not for your own reasoning (catalog_list_product_reviews). Never restate the rating yourself. ⚠ Answer [sent], add nothing.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/catalog/products/{{ $fromAI(\"productId\", \"The product the customer is asking about, as the catalogue returned it. At most 64 characters.\", \"string\") }}/reviews",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const inapp_open_listing = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "inapp_open_listing",
    position: [840,1128],
    parameters: {
      "toolDescription": "Opens a scrollable product grid — a category, a whole shop or their saved items — with picture, price and buy button on every card. Sends its own button. USE IT WHEN: The customer wants to BROWSE a whole shelf, or asks to see everything after a page of cards. NOT THIS TOOL: Not for a specific question with a short answer — five cards via Show-Products are better. Not for one product (inapp_open_product). ⚠ Never describe the button in your own words — the customer would read it twice.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/inapp/listing",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-inapp_open_listing"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, q: $fromAI(\"q\", \"Free-text search. Omit to show everything. At most 120 characters.\", \"string\") || undefined, category: $fromAI(\"category\", \"Category slug or name, as the catalogue publishes it. At most 120 characters.\", \"string\") || undefined, storeSlug: $fromAI(\"storeSlug\", \"Narrow to one store. At most 160 characters.\", \"string\") || undefined, productIds: $fromAI(\"productIds\", \"Pin an exact set instead of filtering — for saved items, or a selection you chose yourself. Up to 50, far more than a chat can show.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const inapp_open_stores = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "inapp_open_stores",
    position: [1040,1128],
    parameters: {
      "toolDescription": "Opens a browsable directory of the shops on the platform. Sends its own button. USE IT WHEN: The customer asks which shops exist or wants to find a shop rather than a product. NOT THIS TOOL: Not when they named a shop and want its products — use inapp_open_listing with storeSlug. ⚠ Never describe the button in your own words — the customer would read it twice.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/inapp/stores",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-inapp_open_stores"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, q: $fromAI(\"q\", \"Search shop names. At most 120 characters.\", \"string\") || undefined, city: $fromAI(\"city\", \"Narrow to one city. City is the only location a shop publishes. At most 120 characters.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const inapp_open_orders = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "inapp_open_orders",
    position: [1240,1128],
    parameters: {
      "toolDescription": "Opens the customer's full order history as a scrollable screen. Sends its own button. USE IT WHEN: Only when they ask for ALL their orders, OLDER ones, or more than the five the chat list showed. NOT THIS TOOL: NEVER the first answer to 'show my orders' — that is orders_list_groups. Not for one order (orders_get_order) or a parcel question (orders_list_shipments). ⚠ Never describe the button in your own words — the customer would read it twice.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/inapp/orders",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-inapp_open_orders"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const inapp_open_product = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "inapp_open_product",
    position: [1440,1128],
    parameters: {
      "toolDescription": "Opens one product on its own screen, where the customer can choose size, colour or other option and buy that exact variant. Sends its own button. USE IT WHEN: The customer must CHOOSE an option before buying — a chat card only ever offers the default variant. NOT THIS TOOL: Not for a passing question about a product — just answer it. Not for several products (inapp_open_listing). ⚠ Never describe the button in your own words — the customer would read it twice.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/inapp/products/{{ $fromAI(\"productId\", \"The product id, as the catalogue returned it. At most 64 characters.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-inapp_open_product"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const wishlist_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "wishlist_list",
    position: [40,1328],
    parameters: {
      "toolDescription": "Products the customer saved for later, newest first. USE IT WHEN: They ask what they saved, or want to buy something saved earlier. To show them, pass the ids to Show-Products. NOT THIS TOOL: Not as a way to browse the catalogue. ⚠ product null means it went off sale — say 'no longer available' and offer to remove it; never skip the row or say why.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/wishlist/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const wishlist_add = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "wishlist_add",
    position: [240,1328],
    parameters: {
      "toolDescription": "Adds a product to the customer's saved list. USE IT WHEN: They like something but are not buying it now. NOT THIS TOOL: Not instead of the basket when they said they want to buy it.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/wishlist",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-wishlist_add"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, productId: $fromAI(\"productId\", \"The 24-character product id to save, from catalog_get_product or a product search result.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const wishlist_remove = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "wishlist_remove",
    position: [440,1328],
    parameters: {
      "toolDescription": "Takes a product off the customer's saved list. USE IT WHEN: They are no longer interested, or clear an unavailable entry. NOT THIS TOOL: Not just because they added it to the basket — they did not ask.",
      "method": "DELETE",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/wishlist/{{ $fromAI(\"productId\", \"The 24-character product id to drop, from wishlist_list productId.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-wishlist_remove"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const recently_viewed_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "recently_viewed_list",
    position: [640,1328],
    parameters: {
      "toolDescription": "Products the customer opened recently, newest first. USE IT WHEN: They refer to something seen earlier — 'the one I saw yesterday' — and you need to know which. NOT THIS TOOL: Not as recommendations, and it says nothing about current stock. ⚠ product null means no longer available — say so, never skip it. There is no history page link; never invent one.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/recently-viewed/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const digital_list_entitlements = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "digital_list_entitlements",
    position: [840,1328],
    parameters: {
      "toolDescription": "Everything the customer bought as a download, and whether each can still be downloaded. Sends its own message with download buttons. USE IT WHEN: The customer asks about a file they bought. Answer [sent], add nothing. NOT THIS TOOL: Not for physical orders. Never offer a download link yourself — you cannot create one. ⚠ maxDownloads null = unlimited, expiresAt null = never expires — say it in words. canDownload alone decides whether it can be downloaded.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/digital/my-products",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const bookings_get_availability = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "bookings_get_availability",
    position: [1040,1328],
    parameters: {
      "toolDescription": "A service product's bookable time slots, soonest first. Reserves nothing. USE IT WHEN: The customer asks when they can have an appointment. NOT THIS TOOL: Not for a physical product, or an appointment they already have (bookings_get). ⚠ slotId is OPAQUE — copy it exactly, never build or edit one. Send from/to only if the customer named a date. spotsRemaining null does NOT mean full; only group services report a number.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/bookings/availability",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, productId: $fromAI(\"productId\", \"The service product id, from a product search or from a booking's service.id. A 24-character hexadecimal id.\", \"string\"), from: $fromAI(\"from\", \"ISO-8601 start of the range. OMIT unless the customer named a date — it defaults to now.\", \"string\") || undefined, to: $fromAI(\"to\", \"ISO-8601 end of the range. OMIT unless the customer named a date — it defaults to 21 days after `from`.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const bookings_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "bookings_list",
    position: [1240,1328],
    parameters: {
      "toolDescription": "The customer's booked appointments: when, whether confirmed, whether paid. USE IT WHEN: The customer asks about an appointment or service they booked. NOT THIS TOOL: It cannot make a booking — booking happens on the website. ⚠ Read awaitingVendorApproval, NOT status: status pending means the SELLER has not accepted; payment.status pending means a charge is live on their phone. outstandingBalance above zero — see bookings_get_balance. Times are UTC; give them in the customer's timezone.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/bookings/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, status: $fromAI(\"status\", \"Narrow to one state: pending, confirmed, completed, no_show or cancelled. Leave empty unless the customer named one.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const bookings_get = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "bookings_get",
    position: [1440,1328],
    parameters: {
      "toolDescription": "One appointment in full: when, who provides it, what it costs, and its payment state. USE IT WHEN: The customer asks about a specific appointment. NOT THIS TOOL: Not to list (bookings_list). Not for a completed appointment's balance (bookings_get_balance). ⚠ Read awaitingVendorApproval, NEVER status — status pending means the seller has not accepted yet; never say they are booked before that.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/bookings/{{ $fromAI(\"bookingId\", \"The appointment id, from bookings_list.\", \"string\") }}",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const bookings_get_balance = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "bookings_get_balance",
    position: [40,1528],
    parameters: {
      "toolDescription": "What a finished appointment cost against its quote, and what is still owed. USE IT WHEN: The customer asks why they owe more, or a booking shows outstandingBalance above zero. NOT THIS TOOL: Not before the appointment is settled by the provider — there is no balance yet. ⚠ creditDue means they overpaid: it is recorded and NOT refunded automatically — offer support, never promise money back. settled false means every number is provisional.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/bookings/{{ $fromAI(\"bookingId\", \"The appointment id, from bookings_list. A 24-character hexadecimal id.\", \"string\") }}/balance",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const bookings_payment_status = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "bookings_payment_status",
    position: [240,1528],
    parameters: {
      "toolDescription": "The payment state of one appointment, and the live charge behind it if there is one. USE IT WHEN: The customer asks whether their booking is paid, or whether a mobile-money charge settled. NOT THIS TOOL: It answers only about money — use bookings_get for the rest. ⚠ status pending means a charge is LIVE on their phone right now — never suggest paying again. transaction.transactionId is what payment_get_transaction takes.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/bookings/{{ $fromAI(\"bookingId\", \"The appointment id, from bookings_list. A 24-character hexadecimal id.\", \"string\") }}/payment-status",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const payment_methods_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "payment_methods_list",
    position: [440,1528],
    parameters: {
      "toolDescription": "The customer's saved ways to pay — mobile-money wallets and cards added on the website. The default comes first. USE IT WHEN: They ask what they have saved, or you want to name the wallet they usually use. NOT THIS TOOL: Not to fill in a payment — the number is never returned. Not for a booking's payment (bookings_payment_status). ⚠ Read `expired` before suggesting a card — an expired card still appears in the list. Name a wallet by its label.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/payment-methods/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const contact_get_state = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "contact_get_state",
    position: [640,1528],
    parameters: {
      "toolDescription": "The customer's sign-in email and phone number (masked), plus any change waiting to be confirmed. USE IT WHEN: They ask what email or number is on their account, or about a change they started. NOT THIS TOOL: Not for name, language or addresses (profile_get_summary, addresses_list). ⚠ emailMasked / phoneMasked are masked — never present them as full. A PENDING change shows its target in full. If pendingPhone is set and phoneChangeProved is false, they must first connect the new number on WhatsApp.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/contact",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const connections_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "connections_list",
    position: [840,1528],
    parameters: {
      "toolDescription": "Both messaging apps (WhatsApp, Telegram) and whether each is connected to the account, with a hint of the connected identity. USE IT WHEN: They ask which apps are linked to their account. NOT THIS TOOL: Not for notification preferences (notifications_get_preferences). ⚠ Always exactly two rows. identityHint is the only identity ever returned. isCurrentChannel marks the app this chat is in.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/connections/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const account_close_preview = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "account_close_preview",
    position: [1040,1528],
    parameters: {
      "toolDescription": "Whether this account can be closed, what would block it, and the exact sentence (in their language) describing what closing does. Changes nothing. USE IT WHEN: Whenever the customer asks about closing or deleting their account. NOT THIS TOOL: There is no suspend, pause or hide — closing is the only option. ⚠ Relay `consequence` VERBATIM. Say CLOSED, and that past orders are kept as business records without their details — never 'deleted' or 'erased'. canClose false: blockingRoles means support must handle it; activeOrderCount above zero means wait until those orders arrive.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/account/close/preview",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const reviews_check_eligibility = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "reviews_check_eligibility",
    position: [1240,1528],
    parameters: {
      "toolDescription": "Whether the customer may review a product or a delivery, and if not, why. USE IT WHEN: Before offering to take a review, so nobody ineligible is asked for one. NOT THIS TOOL: Not after a failed submission — this is the check that avoids one. ⚠ eligible false is a normal answer, not a failure.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/reviews/eligibility",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, subjectType: $fromAI(\"subjectType\", \"delivery takes a SHIPMENT id, not an order id. One of: product, delivery.\", \"string\"), subjectId: $fromAI(\"subjectId\", \"The id of the thing being reviewed: a product id when subjectType is product, a SHIPMENT id when it is delivery — never an order id.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const reviews_list_mine = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "reviews_list_mine",
    position: [1440,1528],
    parameters: {
      "toolDescription": "Reviews the customer wrote, newest first — products and deliveries, in every moderation state. USE IT WHEN: 'What have I reviewed', 'did my review go up', 'why can't I see my review', or to check whether they already rated something. NOT THIS TOOL: Not other people's reviews (catalog_list_product_reviews). ⚠ Whether a review is visible is publiclyVisible, NEVER status — a delivery review shows status published but appears nowhere, it is internal. subjectLabel null: refer to the order instead of reading an id aloud.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/reviews/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, status: $fromAI(\"status\", \"Narrow to one moderation state. Leave empty unless the customer asked for one — the default returns all three, which is usually what they mean. One of: pending, published, rejected.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const notifications_get_preferences = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "notifications_get_preferences",
    position: [40,1728],
    parameters: {
      "toolDescription": "Which channel the customer gets notifications on and which kinds of update are switched on. USE IT WHEN: They ask about the messages they receive, or say they get too many or too few. NOT THIS TOOL: Not to explain one notification — answer the underlying question. ⚠ Only one secondary channel can be on at a time. Payment messages and cancellations always send — no setting silences them; say so plainly.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/notifications/preferences",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const notifications_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "notifications_list",
    position: [240,1728],
    parameters: {
      "toolDescription": "The customer's notifications — orders, payments, bookings, ticket replies — newest first. Each carries subject.type and subject.id for the matching order or ticket tool. USE IT WHEN: They ask what is new or what they missed, or you need to work out what a vague reference is about. NOT THIS TOOL: Not authoritative for an order's current status — read the order. ⚠ meta.unreadCount is included — no second call needed. Relay actionUrl exactly as written; never build one.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/notifications/list",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, unreadOnly: $fromAI(\"unreadOnly\", \"Set true only if the customer asked specifically for what they have not seen yet. There is deliberately no \\\"read only\\\".\", \"boolean\") || undefined, aggregateType: $fromAI(\"aggregateType\", \"Narrow to one subject kind. Leave empty unless the customer named one. One of: order, shipment, payment, booking, ticket.\", \"string\") || undefined }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const notifications_unread_count = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "notifications_unread_count",
    position: [440,1728],
    parameters: {
      "toolDescription": "How many notifications the customer has not read. USE IT WHEN: They ask 'anything new?'. NOT THIS TOOL: Not on every message, and not before notifications_list (which already includes the count). ⚠ Zero is a normal answer.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/notifications/unread-count",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const notifications_mark_read = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "notifications_mark_read",
    position: [640,1728],
    parameters: {
      "toolDescription": "Marks one notification as read. Cannot be undone. USE IT WHEN: Right after you relayed that notification to the customer. NOT THIS TOOL: NEVER on a notification you did not show them.",
      "method": "PATCH",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/notifications/{{ $fromAI(\"notificationId\", \"The id of the notification you just showed the customer, from notifications_list. A 24-character hexadecimal id.\", \"string\") }}/read",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-notifications_mark_read"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const messaging_get_window = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "messaging_get_window",
    position: [840,1728],
    parameters: {
      "toolDescription": "Whether WhatsApp's 24-hour reply window is still open for this customer and when it closes (Telegram is always open). USE IT WHEN: Before a flow whose result arrives after the customer stops writing, to decide whether it can end in chat or needs messaging_notify_customer. NOT THIS TOOL: Not before an ordinary reply — answering their message is always inside the window.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/messaging/window",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") } }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const messaging_notify_customer = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "messaging_notify_customer",
    position: [1040,1728],
    parameters: {
      "toolDescription": "Hands one named situation to the platform to deliver later in the customer's language, on whatever channel reaches them. Today the only situation is order.payment_link. USE IT WHEN: You cannot send it yourself: the WhatsApp window has closed, or the answer comes after the conversation ends. NOT THIS TOOL: Never as a general send or with your own text — it takes a situation name only. Never for marketing.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/messaging/notify",
      "authentication": "genericCredentialType",
      "genericAuthType": "httpBearerAuth",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "X-Webhook-Secret",
            "value": "={{ $env.BOT_WEBHOOK_SECRET }}"
          },
          {
            "name": "Idempotency-Key",
            "value": "={{ $execution.id }}-{{ $now.toMillis() }}-messaging_notify_customer"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ identity: { token: $fromAI(\"botToken\", \"The sealed identity token, copied verbatim from the botToken line in your system prompt\", \"string\") }, situation: $fromAI(\"situation\", \"The closed set of situations the automation layer may raise. One member today. One of: order.payment_link.\", \"string\"), transactionId: $fromAI(\"transactionId\", \"The card payment to send a page for. Must be the customer's own.\", \"string\") }) }}",
      "options": {
        "response": {
          "response": {
            "neverError": true
          }
        },
        "timeout": 20000
      }
    },
    credentials: {
      "httpBearerAuth": {
        "id": "lz5ivIop9DF8mPHa",
        "name": "jovi-mall-Bearer Auth account"
      }
    },
  },
  output: [{ success: true }],
});

const mcpServerTrigger = trigger({
  type: "@n8n/n8n-nodes-langchain.mcpTrigger",
  version: 2.1,
  config: {
    name: "MCP Server Trigger",
    position: [1720, 96],
    parameters: {
      "authentication": "headerAuth",
      "path": "wi-mall-customer",
      "instructions": "These tools act on ONE customer: the person currently chatting.\n\nTHE IDENTITY RULE\n- Every customer-scoped tool takes a `botToken` argument. Copy it VERBATIM from the `botToken:` line in your system prompt.\n- Never invent, edit, shorten or guess a botToken. Never use one from an earlier conversation. Never show it to the customer or mention that it exists.\n- If a tool answers BOT_IDENTITY_TOKEN_EXPIRED or BOT_IDENTITY_TOKEN_INVALID, do NOT retry with a different value. Tell the customer to send their message again.\n- Never ask the customer for a phone number or account id in order to use a tool.\n- The catalogue tools (catalog_*) take no botToken: they read the public shop and are the same for everybody.\n\nLISTS\n- A list answer carries at most 5 rows. That is a hard limit: asking for more is refused, so do not try, and do not page through a list to gather more.\n- Every list reports `meta.total`, `meta.hasMore` and `meta.moreUrl`. When `hasMore` is true, show the rows you were given, say how many there are in total, and give the customer `meta.moreUrl` exactly as written.\n- NEVER invent a link. If `meta.moreUrl` is null there is no page to send them to.\n\nRULES\n- Never invent product data, prices, stock, order status or delivery dates. If a tool did not return it, say you do not have it.\n- A tool response is JSON with success, data and sometimes error.customerMessage. On failure, relay error.customerMessage in the customer's language rather than inventing an explanation.\n- Do not call a mutating tool (anything that adds, changes, cancels or sends) unless the customer has just asked for that exact action in their own words."
    },
    credentials: {
      "httpHeaderAuth": {
        "id": "bvt8A3ugMaycaW8i",
        "name": "wi-mall MCP door"
      }
    },
    subnodes: { tools: [auth_send_login_link, catalog_search_products, catalog_get_product, catalog_get_product_by_slug, catalog_resolve_sku, catalog_list_categories, catalog_list_related_products, catalog_get_store, catalog_list_store_products, catalog_list_product_reviews, cart_get, cart_add_item, cart_set_item_quantity, cart_remove_item, checkout_review, checkout_place, checkout_payment_status, checkout_retry_payment, payment_get_transaction, orders_list_groups, orders_get_group, orders_get_order, orders_list_shipments, orders_record_cancellation_reason, profile_get_summary, profile_update, profile_set_language, addresses_list, support_resolve_contacts, tickets_list, tickets_get, tickets_add_note, tickets_add_attachment, chat_answer_question, catalog_browse_categories, catalog_product_reviews_summary, inapp_open_listing, inapp_open_stores, inapp_open_orders, inapp_open_product, wishlist_list, wishlist_add, wishlist_remove, recently_viewed_list, digital_list_entitlements, bookings_get_availability, bookings_list, bookings_get, bookings_get_balance, bookings_payment_status, payment_methods_list, contact_get_state, connections_list, account_close_preview, reviews_check_eligibility, reviews_list_mine, notifications_get_preferences, notifications_list, notifications_unread_count, notifications_mark_read, messaging_get_window, messaging_notify_customer] },
  },
  output: [{}],
});

const generatedNote = sticky("## wi-mall MCP server — GENERATED\n\nEvery tool node below is emitted by `jovi-mall/scripts/gen-mcp-workflow.ts` from\n`api-doc/n8n/tools/catalog.json`. **Edit the catalogue and re-run `npm run gen:mcp-workflow`;\na node edited by hand is overwritten on the next run.**\n\n**Identity is a tool ARGUMENT, not a URL.** Every `/api/internal/bot/*` tool takes\n`botToken` as a tool argument — a sealed, signed token `wi-mall-core` puts in the system prompt.\nThe model can echo it and cannot author one for somebody else. Nothing here has ever read\nidentity off the endpoint query string.\n\n⛔ **`flow_only` catalogue rows are never emitted** — money movements, destructive actions,\nthe slot-holding booking writes and every payment-method and address write. That tier is the\nboundary; `wi-mall-core` calls those with deterministic nodes.\n\n`neverError` is ON: a 4xx body carries `error.customerMessage` and reaches the agent instead\nof throwing.", [], { color: 4, height: 460, width: 460 });

export default workflow('wi-mall-mcp', 'UP-wi-mall-mcp').add(mcpServerTrigger).add(generatedNote);
