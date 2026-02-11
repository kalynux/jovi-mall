# WhatsApp Messaging Infrastructure

**Production-ready, extensible WhatsApp messaging abstraction with policy awareness and idempotency enforcement.**

## Overview

This system provides a **single unified `send()` API** for all WhatsApp message types, with:

- ✅ **Provider-Isolated Architecture** (Meta Cloud API only, not over-generalized)
- ✅ **Handler Registry Pattern** (zero conditional explosion)
- ✅ **WhatsApp Policy Awareness** (24h window, capabilities, eligibility)
- ✅ **Explicit Idempotency** (Redis TTL for critical message types)
- ✅ **Authoritative `sendContext`** (computed by service, not caller-overridable)
- ✅ **Startup Validation** (ensures all message types have handlers)
- ✅ **First-Class Templates & Flows** (dedicated registries, validators)

---

## Core Design Principles

### 1. Provider-Isolated, Not Provider-Agnostic

This system uses **Meta WhatsApp Cloud API exclusively**. The `WhatsAppProvider` interface exists for **testing and isolation**, not multi-provider support. There will be exactly **one implementation**.

**Why?** Prevents over-engineering and leaky abstractions.

### 2. Message Type Governance

**RULE:** New message types can **ONLY** be introduced if WhatsApp Cloud API has a distinct payload structure not representable by existing handlers.

Message types map **1:1 to WhatsApp API payload roots**, not UX concepts.

### 3. Authoritative sendContext

The `sendContext` object is **computed by the service** and treated as **authoritative** by handlers. Callers **MAY NOT** override policy flags.

**Why?** Prevents policy bypass vectors and debugging nightmares.

### 4. Idempotency with Redis TTL

Idempotency is **REQUIRED** for critical message types (templates, payments, orders). Keys are stored in Redis with a **TTL of 72 hours** to prevent unbounded growth.

**Why?** Duplicate sends erode vendor trust and cause confusion.

### 5. PolicyViolationError

A distinct error type for WhatsApp policy failures, separate from validation or provider rejections.

**Why?** Makes failures deterministic and debuggable.

---

## Quick Start

```typescript
import { WhatsAppMessagingService } from './services/whatsapp-messaging.service';

const whatsappService = new WhatsAppMessagingService();

// Send text message
const result = await whatsappService.send({
  to: '+1234567890',
  type: 'text',
  message: {
    type: 'text',
    body: 'Hello from WhatsApp!',
    previewUrl: true,
  },
  meta: {
    traceId: 'req_123',
  },
});

if (result.success) {
  console.log('Message sent:', result.messageId);
} else {
  console.error('Send failed:', result. error);
}
```

---

## Supported Message Types

The system supports **14 WhatsApp message types**, each with a dedicated handler:

| Message Type | Handler | First-Class? | Idempotency? |
|--------------|---------|--------------|--------------|
| `text` | `TextMessageHandler` | ❌ | ❌ |
| `template` | `TemplateMessageHandler` | ✅ | ✅ |
| `image` | `ImageMessageHandler` | ❌ | ❌ |
| `video` | `VideoMessageHandler` | ❌ | ❌ |
| `audio` | `AudioMessageHandler` | ❌ | ❌ |
| `document` | `DocumentMessageHandler` | ❌ | ❌ |
| `interactive` | `InteractiveMessageHandler` | ❌ | ❌ |
| `product` | `ProductMessageHandler` | ❌ | ❌ |
| `product_list` | `ProductListMessageHandler` | ❌ | ❌ |
| `media_carousel` | `MediaCarouselMessageHandler` | ❌ | ❌ |
| `reaction` | `ReactionMessageHandler` | ❌ | ❌ |
| `location` | `LocationMessageHandler` | ❌ | ❌ |
| `contacts` | `ContactsMessageHandler` | ❌ | ❌ |
| `flow` | `FlowMessageHandler` | ✅ | ❌ |

---

## Environment Variables

```bash
WHATSAPP_API_URL=https://graph.facebook.com/v18.0
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_access_token
```

---

## Policy Awareness

The system automatically enforces WhatsApp's critical constraints:

### 24-Hour Window

- **Within window:** All message types allowed
- **Outside window:** Only `template` messages allowed

The service computes this **authoritatively** based on the last inbound message timestamp.

### Capability Checks

- **Interactive messages:** Requires account capability
- **WhatsApp Flows:** Requires Flow capability and published flow

### Error Handling

Policy violations throw `PolicyViolationError`:

```typescript
{
  name: 'PolicyViolationError',
  code: 'POLICY_VIOLATION',
  message: 'Message type \'text\' requires 24-hour window. Use \'template\' message instead.',
  details: {
    policyType: '24H_WINDOW',
    messageType: 'text',
    isWithin24hWindow: false,
    allowedTypes: ['template']
  }
}
```

---

## Idempotency

Idempotency keys are **REQUIRED** for critical message types:

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'template',
  message: {
    type: 'template',
    name: 'booking_confirmation',
    language: 'en',
    components: [...],
  },
  meta: {
    idempotencyKey: 'booking_123_confirmation', // REQUIRED
    traceId: 'req_456',
  },
});
```

**Duplicate sends** will throw `DuplicateMessageError`.

**Redis TTL:** Keys expire after **72 hours** to prevent memory leaks.

---

## Templates & Flows (First-Class)

### Templates

Templates have dedicated infrastructure:

- **Template Registry:** Track pre-approved templates, prevent magic strings
- **Template Validator:** Component-level validation
- **Template Constants:** Centralized template names

**Example:**

```typescript
import { TEMPLATE_NAMES } from './handlers/template/template-constants';

await whatsappService.send({
  to: '+1234567890',
  type: 'template',
  message: {
    type: 'template',
    name: TEMPLATE_NAMES.BOOKING_CONFIRMATION,
    language: 'en',
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Vendor Name' },
          { type: 'text', text: '2024-02-15' },
          { type: 'text', text: 'BK-123' },
        ],
      },
    ],
  },
  meta: {
    idempotencyKey: 'booking_123_confirmation',
  },
});
```

### Flows

Flows have dedicated infrastructure:

- **Flow Registry:** Track published flows
- **Flow Validator:** Screen and capability checks

**Example:**

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'flow',
  message: {
    type: 'flow',
    flowId: 'FLOW_ID_HERE',
    flowAction: 'navigate',
    flowScreen: 'welcome',
    header: 'Customer Support',
    body: 'How can we help you today?',
    flowParameters: {
      user_id: 'user_123',
    },
  },
  meta: {
    traceId: 'req_789',
  },
});
```

---

## Extending the System

### Adding a New Message Type

1. Add type to `WhatsAppMessageTypes` array in `whatsapp-message.types.ts`
2. Create message interface and add to `WhatsAppMessage` union
3. Implement handler extending `WhatsAppMessageHandler`
4. Register handler in `WhatsAppMessagingService.registerHandlers()`
5. **Startup validation** will ensure it's registered correctly

**REMEMBER:** New types can only be added if WhatsApp API has a distinct payload structure!

---

## Testing

The provider interface enables easy testing:

```typescript
class MockWhatsAppProvider implements WhatsAppProvider {
  async send(payload: ProviderPayload): Promise<SendResult> {
    return {
      success: true,
      messageId: 'mock_msg_123',
      meta: { timestamp: new Date() },
    };
  }
  
  getName(): string {
    return 'Mock Provider';
  }
}
```

---

## Error Hierarchy

| Error Type | When Thrown | Retryable? |
|------------|-------------|------------|
| `UnsupportedMessageTypeError` | Message type has no handler | ❌ No |
| `InvalidMessagePayloadError` | Payload validation fails | ❌ No |
| `PolicyViolationError` | WhatsApp policy constraint | ❌ No |
| `IdempotencyRequiredError` | Missing idempotency key | ❌ No |
| `DuplicateMessageError` | Duplicate idempotency key | ❌ No |
| `ProviderRejectedMessageError` | WhatsApp API rejects | ⚠️ Maybe |
| `ValidationError` | Schema validation fails | ❌ No |

---

## Production Checklist

- [ ] Configure environment variables
- [ ] Register templates in WhatsApp Business Manager
- [ ] Configure template registry in `template-registry.ts`
- [ ] Publish WhatsApp Flows
- [ ] Configure flow registry in `flow-registry.ts`
- [ ] Set up Redis for idempotency
- [ ] Configure logging/monitoring
- [ ] Test all message types
- [ ] Verify 24-hour window tracking
- [ ] Load test with realistic traffic

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│         WhatsAppMessagingService (Entry Point)          │
│  • Unified send() API                                   │
│  • Idempotency enforcement (Redis TTL)                  │
│  • Authoritative sendContext computation                │
│  • Startup validation                                   │
└────────────┬───────────────────────────┬────────────────┘
             │                           │
    ┌────────▼────────┐         ┌───────▼───────┐
    │ Policy Validator│         │ Handler Registry│
    │  • 24h window   │         │  • 14 handlers  │
    │  • Capabilities │         │  • Type → impl  │
    │  • Eligibility  │         └────────┬────────┘
    └─────────────────┘                  │
                                ┌────────▼─────────┐
                                │  Message Handlers │
                                │  • Validate       │
                                │  • Build payload  │
                                └────────┬──────────┘
                                         │
                                ┌────────▼──────────┐
                                │  WhatsApp Provider │
                                │  (Meta Cloud API)  │
                                └────────────────────┘
```

---

## License

Internal use only.
