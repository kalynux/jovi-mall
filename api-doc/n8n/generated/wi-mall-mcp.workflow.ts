import { workflow, trigger, tool, sticky } from '@n8n/workflow-sdk';

const catalog_search_products = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "catalog_search_products",
    position: [40,328],
    parameters: {
      "toolDescription": "Find products on sale, by words, category, price range, type or store. Returns a page of product cards with price, stock, rating and the store that sells them. USE IT WHEN: Any time the customer describes something they want to buy, asks what is available, or narrows a previous search. NOT THIS TOOL: Not to look up a product code printed on a package — `q` is a whole-word text search over title, tags and description and does not match SKUs. Use catalog_resolve_sku. Not to fetch one known product: catalog_get_product returns far more. ⚠ Render at most 10 rows as an interactive list; row title is capped at 24 characters and the description at 72, so the title must be truncated rather than the price dropped.",
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
    position: [240,328],
    parameters: {
      "toolDescription": "Everything about one product: description, images, options, every variant with its own price and stock, the store, and the store's return and cancellation policies. USE IT WHEN: Before answering any question about a specific product, and always before adding one to a cart — the variant id you need comes from here. NOT THIS TOOL: Not for browsing; the list rows from catalog_search_products are enough to choose from. ⚠ A service variant's price is a UNIT RATE per durationMinutes, not the price — quote priceFrom with priceUnit or the customer is misquoted.",
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
    position: [440,328],
    parameters: {
      "toolDescription": "The same product detail, addressed the way a shared storefront link addresses it. USE IT WHEN: When the customer pastes a storefront product URL. Product slugs are unique per vendor, not globally, so both halves are required. NOT THIS TOOL: When you hold a product id — catalog_get_product returns an identical body with one parameter.",
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
    position: [640,328],
    parameters: {
      "toolDescription": "Turn a product code printed on a package, a label or an advertisement into the product and variant it identifies. USE IT WHEN: When the customer types something that looks like a product code rather than words. NOT THIS TOOL: Not for a search phrase — catalog_search_products handles words.",
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
    position: [840,328],
    parameters: {
      "toolDescription": "The categories that currently have something for sale in them, with a count each. USE IT WHEN: When the customer asks what is sold here, or before filtering a search by category — the values are free text and must come from this list. NOT THIS TOOL: Not as a substitute for search when the customer already described what they want. ⚠ A complete small set, not a page — but still cap the rendered list at 10 rows and offer the rest as a second page.",
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
    position: [1040,328],
    parameters: {
      "toolDescription": "Up to eight products related to this one, and — importantly — which kind of relation it is. USE IT WHEN: After showing a product card, when the customer asks for alternatives or similar items. NOT THIS TOOL: Never describe the result as 'customers also bought' unless meta.source is co_purchase. On a young catalogue the fallback is the common case and saying otherwise is a false claim about other shoppers. ⚠ meta.source is part of the contract. co_purchase -> 'Frequently bought together'; same_category -> 'More in this category'. `orders` is always null on the fallback. An empty list is a successful answer.",
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
    position: [1240,328],
    parameters: {
      "toolDescription": "A seller's public page: name, description, city, whether they are verified, whether they are currently open, and the support contacts they chose to publish. USE IT WHEN: When the customer asks who is selling something, or asks how to contact a seller — this is the source for the vendor branch of the support flow. NOT THIS TOOL: Not for the delivery company's contacts; those come from orders_list_shipments, because an agency is attached to a shipment rather than to a product. ⚠ Any support field may be null. A closed store (isOpen:false) still sells — say 'the seller is on holiday', never 'unavailable'.",
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
    position: [1440,328],
    parameters: {
      "toolDescription": "What a particular seller currently has for sale. USE IT WHEN: When the customer wants to see more from a seller they have already seen. NOT THIS TOOL: Use catalog_search_products with storeSlug when you also need to filter or sort within that store — the contract is identical and one call does both.",
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
    position: [40,528],
    parameters: {
      "toolDescription": "What buyers said about a product, and the star breakdown. USE IT WHEN: When the customer asks whether a product is any good, or asks for opinions. NOT THIS TOOL: Not for delivery reviews — those are internal, feed an agent's trust score and have no public endpoint. ⚠ A product nobody has reviewed carries rating: null on the product card — never report that as zero stars.",
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
    position: [240,528],
    parameters: {
      "toolDescription": "What is currently in the customer's basket, line by line, with quantities and prices. USE IT WHEN: Whenever the customer asks about their cart, and at the start of any checkout flow. NOT THIS TOOL: Not for the total payable — that is cart_quote, which adds delivery and validates the address. ⚠ An empty cart is a successful answer with items: [] and no cartId, never an error.",
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
    position: [440,528],
    parameters: {
      "toolDescription": "Put a product variant in the customer's basket. If that exact variant is already there, its quantity goes up. USE IT WHEN: When the customer asks to add something, and you already hold the variant id from catalog_get_product. NOT THIS TOOL: Never guess a variant id, and never add a product that has more than one variant without asking which one. Never for a service product — services are booked, not carted, and the call is refused. ⚠ A cart may hold items from several vendors but only ONE product type, and never a service.",
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
            "value": "={{ $execution.id }}-cart_add_item"
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
    position: [640,528],
    parameters: {
      "toolDescription": "Change a basket line to exactly this many. USE IT WHEN: When the customer names a number they want — 'make it three'. NOT THIS TOOL: Not to remove a line: zero is refused. Use cart_remove_item.",
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
            "value": "={{ $execution.id }}-cart_set_item_quantity"
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
    position: [840,528],
    parameters: {
      "toolDescription": "Take one variant out of the basket. USE IT WHEN: When the customer asks to remove a specific item. NOT THIS TOOL: Not to empty the whole basket — that is cart_clear and it needs confirmation.",
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
            "value": "={{ $execution.id }}-cart_remove_item"
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

const payment_get_transaction = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "payment_get_transaction",
    position: [1040,528],
    parameters: {
      "toolDescription": "The stored details of one of the customer's own payments. USE IT WHEN: When the customer asks what happened to a specific payment. NOT THIS TOOL: Not during a checkout poll — payment_verify is the live answer. Not on the public payment surface: reading a transaction requires ownership and the bot surface supplies it.",
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
    position: [1240,528],
    parameters: {
      "toolDescription": "The customer's order history, newest first, grouped the way they placed them — one group per checkout, however many sellers were in it. USE IT WHEN: When the customer asks about their orders in general, and as the first step of anything that needs an order the customer has not named. NOT THIS TOOL: Not to answer 'where is my parcel' — that needs orders_list_shipments, which carries the delivery status. ⚠ The group paymentStatus is an aggregate: paid, awaiting_payment, partially_paid (including a cash order partway through per-shipment collection), refunded, failed, disputed, unknown, or mixed.",
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
    position: [1440,528],
    parameters: {
      "toolDescription": "Everything the customer bought in one checkout, across every seller, with line items — and, for cash orders, the collection each shipment is waiting on. USE IT WHEN: When the customer wants the detail of one purchase and it spanned several sellers. NOT THIS TOOL: Not for a single seller's order when you hold its id — orders_get_order is narrower. ⚠ codCollections[].deliveryCode is present on this response and MUST be stripped before the result reaches the model. It is the customer's proof-of-payment lever and is only ever disclosed by orders_get_cod_code, on explicit request, with its warning.",
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
    position: [40,728],
    parameters: {
      "toolDescription": "One seller's order in full: what was bought, what it cost, where it is going, and how each line is being delivered. USE IT WHEN: When the customer names an order number, or follows up on one order from a list. NOT THIS TOOL: Not to answer a delivery question on its own — pair it with orders_list_shipments. ⚠ cartId is what makes an unpaid order resumable — payment_initiate takes the group, not the order.",
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
    position: [240,728],
    parameters: {
      "toolDescription": "Each parcel on an order: its current stage, the history of how it got there, the delivery company and their support contacts, and — while it is actually moving — the first name of the person carrying it. USE IT WHEN: This is the answer to 'where is my order'. Use it for every tracking, delivery-timing or delivery-problem question, and as the source for the delivery-company branch of the support flow. NOT THIS TOOL: There is no live map in chat. Live GPS is a WebSocket in a separate service that needs a per-viewer token the bot deliberately never holds — describe the stage, never a position. ⚠ The status vocabulary is five words — preparing, shipped, out_for_delivery, delivered, delivery_failed — and they are the same five the customer's notifications use. `agent` is null far more often than set and each null means something different: no agent bound yet at preparing, and revoked on settlement at delivered. Never publish an agent phone number or full name; a customer with a question contacts the AGENCY. estimatedDelivery is always null — nothing estimates a delivery date, so never invent one.",
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

const profile_get_summary = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "profile_get_summary",
    position: [440,728],
    parameters: {
      "toolDescription": "The handful of profile facts that matter in a chat: display name, language, currency, whether contact details are verified, and how many addresses are saved. USE IT WHEN: When the customer asks what the platform knows about them, or before a settings change. NOT THIS TOOL: Not to fetch an address to deliver to — addresses_list is narrower and returns the ids checkout needs. ⚠ The bot surface returns MASKED contact details. A chat window is a shared, screenshotted, sometimes-shoulder-surfed place, and the customer already knows their own number.",
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
    position: [640,728],
    parameters: {
      "toolDescription": "Change the name the customer is called. USE IT WHEN: When they ask to be called something else, or correct the name the bot greets them by. NOT THIS TOOL: Not for language — profile_set_language owns that. Not for a phone, an email or an address; each has its own tool, and this route accepts nothing but the name. ⚠ This is the ONLY profile field this surface can change. The answer is the whole profile summary, with the email and phone masked — read it back as confirmation rather than reading the number aloud.",
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
            "value": "={{ $execution.id }}-profile_update"
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
    position: [840,728],
    parameters: {
      "toolDescription": "Set the language the platform writes to this customer in — in chat, in notifications and in email. USE IT WHEN: When the customer asks to change language, or writes consistently in a language other than the one on their profile and confirms the switch. NOT THIS TOOL: Do not switch on a single message in another language. People code-switch; a preference change is durable and reaches their email too. ⚠ Product text is NOT translated — it is vendor-authored in one language and the product carries contentLanguage saying which. Say so rather than appearing to have translated it.",
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
            "value": "={{ $execution.id }}-profile_set_language"
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
    position: [1040,728],
    parameters: {
      "toolDescription": "The customer's saved addresses, which is the default, and — crucially — whether each one can actually be delivered to. USE IT WHEN: As the address step of checkout, and whenever the customer asks where their orders go. NOT THIS TOOL: Not to find a new address — that is geo_search_address. ⚠ `deliverable` is the bot surface's rendering of 'has a geocoded location'. An address without one is refused at checkout, so an undeliverable address must be shown as needing to be re-picked rather than offered as a choice.",
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
    position: [1240,728],
    parameters: {
      "toolDescription": "For the thing the customer most recently dealt with, who to contact: the seller, the delivery company, or the platform — with each one's published contacts and why it is relevant. USE IT WHEN: For any 'I need help' that is not obviously about one specific thing, and as the first step of the support flow. A product question goes to the seller; a parcel question goes to the delivery company; a money or account question goes to the platform. NOT THIS TOOL: Not for a question you can answer from the catalogue or the customer's own orders. Routing someone to a phone number is a worse answer than telling them where their parcel is. ⚠ An agency has no contacts until an order has a shipment, so /support:agency on a product-only context legitimately has nothing to answer with. Any contact field may be null; offer the ones that exist and fall through to a ticket.",
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
    position: [1440,728],
    parameters: {
      "toolDescription": "The support tickets this customer has open, and their current status. USE IT WHEN: When the customer asks about a support request they already made, or before opening a new one — an existing open ticket about the same thing should be added to rather than duplicated. NOT THIS TOOL: Not as the answer to a first-time question. Most questions are answered better than by opening a ticket. ⚠ The pagination block on ticket lists is called `pagination`, not `meta`. assigned_admin is null until a human takes the ticket, which is the state almost every ticket is in — say 'waiting to be picked up', never invent a handler.",
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
    position: [40,928],
    parameters: {
      "toolDescription": "One support ticket with its public conversation. USE IT WHEN: When the customer names a ticket number or asks what happened to a request. NOT THIS TOOL: Not for a list — tickets_list is cheaper and paginated. ⚠ Customers never see internal staff notes; only public ones are returned. Do not imply there is a hidden conversation.",
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
    position: [240,928],
    parameters: {
      "toolDescription": "Add the customer's message to an existing ticket. USE IT WHEN: When the customer says something more about a ticket that is already open. NOT THIS TOOL: Not to record your own summary. A note is attributed to the customer and read by staff as their words.",
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
            "value": "={{ $execution.id }}-tickets_add_note"
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
    position: [440,928],
    parameters: {
      "toolDescription": "Put a photo or PDF the customer just sent in this chat onto one of their support tickets. You do not upload anything — the file is already stored and you name it by the reference you were given when it arrived. USE IT WHEN: When the customer has sent a file in this conversation and it is evidence for a support request — a damaged item, a wrong delivery, a receipt. Open the ticket first if there is not one yet, then attach. NOT THIS TOOL: Never invent a reference. If you were not given one for a file in this conversation, the file is not available and the customer must send it again. Not for a file the customer sent in an earlier conversation — references expire after 30 minutes. ⚠ The reference is single-use — one call per file. `attachmentCount` and `attachmentLimit` come back on success; when they are equal, say so, because the next photo will be refused. You cannot see what is in the file: describe it as what the customer called it, never as what you assume it shows.",
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
            "value": "={{ $execution.id }}-tickets_add_attachment"
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

const wishlist_list = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "wishlist_list",
    position: [640,928],
    parameters: {
      "toolDescription": "Products the customer saved for later, newest save first. USE IT WHEN: When the customer asks what they saved, or wants to buy something they saved earlier. NOT THIS TOOL: Not as a browse surface — it is their own short list, not the catalogue. ⚠ An entry's `product` can be null when the product went off sale. Say 'no longer available' and offer to remove it — never drop the row silently, and never say why it went, which would leak a seller's catalogue state.",
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
    position: [840,928],
    parameters: {
      "toolDescription": "Add a product to the customer's saved list. USE IT WHEN: When the customer likes something but is not buying it now. NOT THIS TOOL: Not instead of adding to the cart when they said they want to buy it.",
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
            "value": "={{ $execution.id }}-wishlist_add"
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
    position: [1040,928],
    parameters: {
      "toolDescription": "Take a product off the customer's saved list. USE IT WHEN: When the customer says they are no longer interested, or clears an unavailable entry. NOT THIS TOOL: Not after adding it to the cart. Those are different lists and the customer did not ask.",
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
            "value": "={{ $execution.id }}-wishlist_remove"
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
    position: [1240,928],
    parameters: {
      "toolDescription": "The products the customer has opened recently, newest first. USE IT WHEN: When they refer to something they were looking at earlier — \"the one I saw yesterday\", \"that blue one\" — and you need to know what they mean. NOT THIS TOOL: Not as a recommendation source. It is a history, and it says nothing about what is in stock now. ⚠ An entry whose product is gone comes back with product: null — say it is no longer available rather than skipping the row. This list has NO meta.moreUrl; do not invent a link to a history page, because there is not one.",
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
    position: [1440,928],
    parameters: {
      "toolDescription": "Everything the customer bought as a download, and whether each one can still be downloaded. USE IT WHEN: When the customer asks about a file they bought. NOT THIS TOOL: Not for physical orders. ⚠ maxDownloads null means unlimited and expiresAt null means never expires — say so in words rather than printing null. canDownload is the single flag that decides whether to offer the download.",
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
    position: [40,1128],
    parameters: {
      "toolDescription": "A service product's bookable time slots, soonest first. USE IT WHEN: Whenever the customer asks when they can have an appointment. Reading availability reserves nothing, so it is always safe to ask. NOT THIS TOOL: Not for a physical product — only a service has a calendar. Not to check an appointment the customer already has: that is bookings_get. ⚠ slotId is OPAQUE — it looks like slot_1757494800000_1757498400000 and must be echoed exactly, never built or edited. Do NOT send from/to unless the customer named a date: a range computed in the chat is how you end up reporting \"no availability\" for a service with plenty. spotsRemaining is null on an ordinary one-at-a-time service and that does NOT mean full; only a class or a group tour reports a number.",
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
    position: [240,1128],
    parameters: {
      "toolDescription": "Appointments the customer has booked, with when they are and whether they are confirmed and paid. USE IT WHEN: When the customer asks about an appointment or a service they booked. NOT THIS TOOL: Not to make a booking — booking needs a slot lock against a live calendar and is handed off to the website. ⚠ Read awaitingVendorApproval, NOT status, to say whether an appointment is settled: status:pending means the VENDOR has not accepted it, while payment.status:pending means a charge is live on the handset. Two different pendings on one row. outstandingBalance above zero means a completed appointment cost more than it was quoted — bookings_get_balance explains it. Times are ISO-8601 UTC; render them in the customer timezone. The pagination block here uses totalPages, not pages.",
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
    position: [440,1128],
    parameters: {
      "toolDescription": "One appointment in full: when it is, who provides it, what it costs and where its payment got to. USE IT WHEN: When the customer asks about a specific appointment, or about a balance they were told about. NOT THIS TOOL: Not to list — bookings_list is cheaper. Not for the balance on a completed appointment: bookings_get_balance owns that, and this row carries only the outstanding total. ⚠ Read awaitingVendorApproval, NEVER status: status:pending means the VENDOR has not accepted the appointment, not that a payment is pending. Telling a customer they are booked when the vendor has not looked is the mistake this field exists to prevent. outstandingBalance above zero means the appointment cost more than it was quoted; bookings_get_balance explains the difference, including the overpaid case, which is RECORDED and not refunded.",
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
    position: [640,1128],
    parameters: {
      "toolDescription": "What a finished appointment actually cost against what it was quoted, and what is still owed. USE IT WHEN: When the customer asks why they owe more, or when a booking row shows outstandingBalance above zero. NOT THIS TOOL: Not before the appointment happened — there is no balance until the vendor settles it. Not for the original price, which is on the booking as price.quoted. ⚠ creditDue is the OTHER direction — the provider settled BELOW the quote, so the customer overpaid. It is recorded and is NOT refunded automatically, by platform decision: say the provider settled below the quote and offer support, never promise money is on its way back. settled:false means the provider has not closed the appointment yet, so every number is provisional.",
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
    position: [840,1128],
    parameters: {
      "toolDescription": "The payment state of one appointment, and the live charge behind it when there is one. USE IT WHEN: When the customer asks whether their booking is paid for, or to check whether a mobile-money charge settled. NOT THIS TOOL: Not as a substitute for bookings_get — this answers only about money. ⚠ status:pending means a charge is LIVE on the customer's handset right now — do not suggest paying again while it is. transaction.transactionId is the handle the money tools take: payment_get_transaction, payment_authorize_otp and payment_create_pay_link all want it, and it is named transactionId rather than id precisely so it is not confused with the bookingId beside it.",
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
    position: [1040,1128],
    parameters: {
      "toolDescription": "The ways to pay the customer has saved — mobile-money wallets, and any cards they added on the website. USE IT WHEN: When they ask what they have saved, before offering to change their default, or when a payment is about to be taken and you want to name the wallet they usually use. NOT THIS TOOL: Not to fill in a payment — the number is never returned, so checkout still asks for it. Not for a booking payment state, which is bookings_payment_status. ⚠ Check `expired` before ever suggesting a card — an expired one stays in the list and still looks usable, and recommending it produces a decline the customer has to work out for themselves. Never work the expiry out yourself from the date; read the field. The wallet's phone number is NEVER returned, so you cannot fill in a payment from this: name the wallet by its label and let the customer give the number. The default is first in the list.",
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
    position: [1240,1128],
    parameters: {
      "toolDescription": "The email address and phone number the customer signs in with, masked, plus any change that is waiting to be confirmed. USE IT WHEN: When the customer asks what email or number is on their account, or asks what happened to a change they started. NOT THIS TOOL: Not for the customer's name, language or addresses — profile_get_summary and addresses_list answer those. ⚠ The CURRENT email and number come back MASKED and the field names say so — read emailMasked and phoneMasked, and never present them as the full value. A PENDING change carries its target in full, because the whole point of the read is telling the customer which address to check. If pendingPhone is set, read phoneChangeProved: false means the customer cannot finish that change yet, and the remedy is to connect the new number on WhatsApp first.",
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
    position: [1440,1128],
    parameters: {
      "toolDescription": "Both messaging channels and whether each one is connected to the customer's account, with a hint at the connected identity. USE IT WHEN: When the customer asks which apps are linked to their account, or before offering to disconnect one. NOT THIS TOOL: Not for notification preferences — notifications_get_preferences answers which channels the platform may write to. ⚠ Always exactly two rows, connected or not — there is no paging and nothing is truncated. identityHint is the ONLY form of the identity that ever comes back; there is no full number or chat id and asking for one will not produce it. isCurrentChannel marks the app this conversation is happening in, which is the one connections_disconnect refuses to cut.",
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
    position: [40,1328],
    parameters: {
      "toolDescription": "Whether this account can be closed, what would stop it, and the exact sentence describing what closing does — in the customer's language. USE IT WHEN: Whenever the customer asks about closing or deleting their account, and ALWAYS before account_close. It changes nothing. NOT THIS TOOL: Not for suspending, pausing or hiding an account — none of those exist. This is the only closure there is. ⚠ Relay `consequence` VERBATIM — it is written in the customer's language and it is the sentence they are entitled to read before deciding. Say CLOSED and say that past orders are kept as business records without their details; never say deleted or erased, because that is not what happens. canClose false means it is refused today: blockingRoles non-empty means the account also sells or delivers and support has to handle it, and activeOrderCount above zero means orders are still on the way and closing can happen once they arrive.",
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
    position: [240,1328],
    parameters: {
      "toolDescription": "Whether the customer is allowed to review a product or a delivery — and if not, why. USE IT WHEN: Before offering to take a review, so an ineligible customer is never asked for one. NOT THIS TOOL: Not after a failed submission — this is the check that avoids one. ⚠ A 200 with eligible:false is a successful answer to a question, not a failure. reason is the same code the write path would have raised.",
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
    position: [440,1328],
    parameters: {
      "toolDescription": "The reviews the customer has written themselves, newest first — products and deliveries, in every moderation state. USE IT WHEN: For \"what have I reviewed\", \"did my review go up\", \"why can I not see my review\", and to check whether they have already rated something. NOT THIS TOOL: NOT other people's reviews of a product — that is catalog_list_product_reviews. ⚠ To say whether a review is visible, read publiclyVisible and NEVER status. A delivery review is stored as status:published and appears on no page anywhere, because it is internal feedback about the carrier — so status alone would have you tell the customer their review is live and send them looking for it. subjectLabel is the product's name; it is null on a delivery review and null on a product no longer for sale, and in that case talk about the order via orderId rather than reading an id aloud. There is no subjectType filter, deliberately: pairing it with status would invite a query whose name promises a page nothing will ever appear on.",
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
    position: [640,1328],
    parameters: {
      "toolDescription": "Which channel the customer gets notifications on and which kinds of update they have switched on. USE IT WHEN: When the customer asks about the messages they get, or complains about too many or too few. NOT THIS TOOL: Not to explain a single notification they received — answer the underlying question instead. ⚠ At most ONE secondary channel is on at a time; enabling one disables the others. Money messages and cancellations always send and no setting silences them — say so plainly rather than implying everything is switchable.",
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
    position: [840,1328],
    parameters: {
      "toolDescription": "The customer's notifications — order progress, payments, bookings, ticket replies — newest first. USE IT WHEN: When they ask what is new or what they missed, and to work out what a vague reference is about: each row carries subject.type and subject.id, which is exactly what the order or ticket tools want. NOT THIS TOOL: NOT authoritative for live order status — a notification records one past moment. Read the order. ⚠ meta.unreadCount rides on the response, so \"you have N unread\" needs no second call. actionUrl is absolute and already in the customer language — relay it as written and never rebuild one. The five aggregate types are derived from the platform own list, so a sixth appearing later is a backend change rather than something to guess at here.",
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
    position: [1040,1328],
    parameters: {
      "toolDescription": "How many notifications the customer has not read — one number. USE IT WHEN: To answer \"anything new?\" without pulling a page of rows. NOT THIS TOOL: Not on every message. It answers a question the customer asked. ⚠ A count of zero is a successful answer, not an error. If the customer then asks what they are, notifications_list already reports the same number in meta.unreadCount — so do not call this first as a matter of routine.",
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
    position: [1240,1328],
    parameters: {
      "toolDescription": "Mark a single notification as read. USE IT WHEN: Right after relaying that notification to the customer — reading it aloud to them IS them seeing it. NOT THIS TOOL: NEVER on a notification you did not show them. There is no way to mark one unread again, so an acknowledgement they did not make cannot be taken back. ⚠ One-way: there is no mark-unread route anywhere on this platform. That is why this tool is model-facing while notifications_mark_all_read is not — acknowledging the one you just read out is honest, and doing it to a whole inbox on your own initiative is not.",
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
            "value": "={{ $execution.id }}-notifications_mark_read"
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

const payment_create_pay_link = tool({
  type: "n8n-nodes-base.httpRequestTool",
  version: 4.5,
  config: {
    name: "payment_create_pay_link",
    position: [1440,1328],
    parameters: {
      "toolDescription": "A short-lived link to a page where the customer completes a CARD payment. Mobile money never needs this — it finishes on the customer's handset. USE IT WHEN: After payment_initiate with gateway STRIPE, when the customer chose to pay by card. Send them the url. NOT THIS TOOL: Never for mobile money — that completes in the chat and this refuses it. Never for a payment that is already done. If url comes back null the deployment has no payment page: offer mobile money instead.",
      "method": "POST",
      "url": "={{ $env.JOVI_MALL_BASE_URL }}/api/internal/bot/payments/{{ $fromAI(\"transactionId\", \"The CARD payment’s transaction id, from the payment that was just initiated. Mobile money never needs a link.\", \"string\") }}/pay-link",
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
            "value": "={{ $execution.id }}-payment_create_pay_link"
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
    position: [40,1528],
    parameters: {
      "toolDescription": "Whether WhatsApp's 24-hour service window is still open for this customer, and when it closes. Telegram has no such window and always answers open. USE IT WHEN: Before starting a flow that may finish after the customer stops writing — a payment they will approve later, an order that ships in two days. Decides whether the flow can end in the chat or must hand off to messaging_notify_customer. NOT THIS TOOL: Not before an ordinary reply. Answering a message the customer just sent is always inside the window.",
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
    position: [240,1528],
    parameters: {
      "toolDescription": "Hands one situation to the platform to deliver, in the customer's language, through whichever channel reaches them — free-form inside the WhatsApp window, an approved template outside it. USE IT WHEN: When you have something to tell the customer and cannot send it yourself: the service window has closed, or the flow is ending and the answer comes later. Today the only situation is order.payment_link — a card payment page. NOT THIS TOOL: Never as a general send. It takes a named situation, never a message you wrote. There is no marketing situation and there will not be one.",
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
            "value": "={{ $execution.id }}-messaging_notify_customer"
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
    subnodes: { tools: [catalog_search_products, catalog_get_product, catalog_get_product_by_slug, catalog_resolve_sku, catalog_list_categories, catalog_list_related_products, catalog_get_store, catalog_list_store_products, catalog_list_product_reviews, cart_get, cart_add_item, cart_set_item_quantity, cart_remove_item, payment_get_transaction, orders_list_groups, orders_get_group, orders_get_order, orders_list_shipments, profile_get_summary, profile_update, profile_set_language, addresses_list, support_resolve_contacts, tickets_list, tickets_get, tickets_add_note, tickets_add_attachment, wishlist_list, wishlist_add, wishlist_remove, recently_viewed_list, digital_list_entitlements, bookings_get_availability, bookings_list, bookings_get, bookings_get_balance, bookings_payment_status, payment_methods_list, contact_get_state, connections_list, account_close_preview, reviews_check_eligibility, reviews_list_mine, notifications_get_preferences, notifications_list, notifications_unread_count, notifications_mark_read, payment_create_pay_link, messaging_get_window, messaging_notify_customer] },
  },
  output: [{}],
});

const generatedNote = sticky("## wi-mall MCP server — GENERATED\n\nEvery tool node below is emitted by `jovi-mall/scripts/gen-mcp-workflow.ts` from\n`api-doc/n8n/tools/catalog.json`. **Edit the catalogue and re-run `npm run gen:mcp-workflow`;\na node edited by hand is overwritten on the next run.**\n\n**Identity is a tool ARGUMENT, not a URL.** Every `/api/internal/bot/*` tool takes\n`botToken` as a tool argument — a sealed, signed token `wi-mall-core` puts in the system prompt.\nThe model can echo it and cannot author one for somebody else. Nothing here has ever read\nidentity off the endpoint query string.\n\n⛔ **`flow_only` catalogue rows are never emitted** — money movements, destructive actions,\nthe slot-holding booking writes and every payment-method and address write. That tier is the\nboundary; `wi-mall-core` calls those with deterministic nodes.\n\n`neverError` is ON: a 4xx body carries `error.customerMessage` and reaches the agent instead\nof throwing.", [], { color: 4, height: 460, width: 460 });

export default workflow('wi-mall-mcp', 'wi-mall-mcp').add(mcpServerTrigger).add(generatedNote);
