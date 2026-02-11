# WhatsApp Messaging Examples

Comprehensive examples for all message types.

## Table of Contents

- [Text Messages](#text-messages)
- [Template Messages](#template-messages)
- [Media Messages](#media-messages)
- [Interactive Messages](#interactive-messages)
- [Product Messages](#product-messages)
- [Location & Contacts](#location--contacts)
- [Reactions](#reactions)
- [WhatsApp Flows](#whatsapp-flows)

---

## Text Messages

### Basic Text

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'text',
  message: {
    type: 'text',
    body: 'Hello! Your booking has been confirmed.',
  },
  meta: {
    traceId: 'text_msg_001',
  },
});
```

### Text with URL Preview

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'text',
  message: {
    type: 'text',
    body: 'Check out our website: https://example.com',
    previewUrl: true, // Enables URL preview
  },
  meta: {},
});
```

---

## Template Messages

### Booking Confirmation

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
          { type: 'text', text: 'Luxury Spa' },
          { type: 'text', text: 'February 15, 2024' },
          { type: 'text', text: 'BK-12345' },
        ],
      },
    ],
  },
  meta: {
    idempotencyKey: 'booking_12345_confirmation', // REQUIRED
    traceId: 'template_001',
  },
});
```

### Payment Confirmation with Currency

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'template',
  message: {
    type: 'template',
    name: 'payment_confirmation',
    language: 'en',
    components: [
      {
        type: 'body',
        parameters: [
          {
            type: 'currency',
            currency: {
              fallback_value: '$50.00',
              code: 'USD',
              amount_1000: 50000, // $50.00 * 1000
            },
          },
          { type: 'text', text: 'ORD-789' },
        ],
      },
    ],
  },
  meta: {
    idempotencyKey: 'payment_789_confirmation', // REQUIRED
  },
});
```

---

## Media Messages

### Image

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'image',
  message: {
    type: 'image',
    link: 'https://example.com/images/product.jpg',
    caption: 'Your booking confirmation',
  },
  meta: {},
});
```

### Video with Caption

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'video',
  message: {
    type: 'video',
    link: 'https://example.com/videos/tour.mp4',
    caption: 'Virtual tour of our facility',
  },
  meta: {},
});
```

### Document

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'document',
  message: {
    type: 'document',
    link: 'https://example.com/docs/invoice.pdf',
    filename: 'Invoice_BK-12345.pdf',
    caption: 'Your booking invoice',
  },
  meta: {},
});
```

---

## Interactive Messages

### Button Interactive

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'interactive',
  message: {
    type: 'interactive',
    subtype: 'button',
    body: {
      text: 'Your booking is confirmed! Would you like to add any extras?',
    },
    footer: {
      text: 'Reply anytime to modify',
    },
    action: {
      type: 'button',
      buttons: [
        {
          type: 'reply',
          reply: {
            id: 'add_massage',
            title: 'Add Massage',
          },
        },
        {
          type: 'reply',
          reply: {
            id: 'add_facial',
            title: 'Add Facial',
          },
        },
        {
          type: 'reply',
          reply: {
            id: 'no_thanks',
            title: 'No Thanks',
          },
        },
      ],
    },
  },
  meta: {},
});
```

### List Interactive

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'interactive',
  message: {
    type: 'interactive',
    subtype: 'list',
    body: {
      text: 'Select a service to book:',
    },
    action: {
      type: 'list',
      button: 'View Services',
      sections: [
        {
          title: 'Spa Services',
          rows: [
            {
              id: 'massage_60',
              title: '60-Min Massage',
              description: 'Full body relaxation',
            },
            {
              id: 'facial_30',
              title: '30-Min Facial',
              description: 'Skin rejuvenation',
            },
          ],
        },
        {
          title: 'Beauty Services',
          rows: [
            {
              id: 'manicure',
              title: 'Manicure',
              description: 'Classic nail care',
            },
          ],
        },
      ],
    },
  },
  meta: {},
});
```

### CTA URL Interactive

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'interactive',
  message: {
    type: 'interactive',
    subtype: 'cta_url',
    body: {
      text: 'View your booking details online',
    },
    action: {
      type: 'cta_url',
      name: 'cta_url',
      parameters: {
        display_text: 'View Booking',
        url: 'https://example.com/bookings/BK-12345',
      },
    },
  },
  meta: {},
});
```

---

## Product Messages

### Single Product

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'product',
  message: {
    type: 'product',
    catalogId: 'YOUR_CATALOG_ID',
    productRetailerId: 'PRODUCT_SKU_123',
    body: 'Check out this amazing spa package!',
    footer: 'Limited time offer',
  },
  meta: {},
});
```

### Product List

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'product_list',
  message: {
    type: 'product_list',
    header: 'Our Best Sellers',
    body: 'Explore our most popular services',
    footer: 'Book now and save',
    catalogId: 'YOUR_CATALOG_ID',
    sections: [
      {
        title: 'Massage Packages',
        product_items: [
          { product_retailer_id: 'MASSAGE_60' },
          { product_retailer_id: 'MASSAGE_90' },
        ],
      },
      {
        title: 'Facial Treatments',
        product_items: [
          { product_retailer_id: 'FACIAL_BASIC' },
          { product_retailer_id: 'FACIAL_PREMIUM' },
        ],
      },
    ],
  },
  meta: {},
});
```

---

## Location & Contacts

### Location

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'location',
  message: {
    type: 'location',
    latitude: 37.7749,
    longitude: -122.4194,
    name: 'Luxury Spa Downtown',
    address: '123 Main St, San Francisco, CA',
  },
  meta: {},
});
```

### Contacts

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'contacts',
  message: {
    type: 'contacts',
    contacts: [
      {
        name: {
          formatted_name: 'Customer Support',
          first_name: 'Customer',
          last_name: 'Support',
        },
        phones: [
          {
            phone: '+1234567890',
            type: 'WORK',
          },
        ],
        emails: [
          {
            email: 'support@example.com',
            type: 'WORK',
          },
        ],
      },
    ],
  },
  meta: {},
});
```

---

## Reactions

### Add Reaction

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'reaction',
  message: {
    type: 'reaction',
    messageId: 'wamid.xxx', // Message ID to react to
    emoji: '👍',
  },
  meta: {},
});
```

### Remove Reaction

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'reaction',
  message: {
    type: 'reaction',
    messageId: 'wamid.xxx',
    emoji: '', // Empty string removes reaction
  },
  meta: {},
});
```

---

## WhatsApp Flows

### Navigate Flow

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'flow',
  message: {
    type: 'flow',
    flowId: 'YOUR_FLOW_ID',
    flowAction: 'navigate',
    flowScreen: 'welcome',
    header: 'Customer Support',
    body: 'How can we help you today?',
    footer: 'Available 24/7',
    flowParameters: {
      user_id: 'user_123',
      session_id: 'sess_456',
    },
  },
  meta: {
    traceId: 'flow_001',
  },
});
```

### Data Exchange Flow

```typescript
await whatsappService.send({
  to: '+1234567890',
  type: 'flow',
  message: {
    type: 'flow',
    flowId: 'BOOKING_FLOW_ID',
    flowAction: 'data_exchange',
    header: 'Book Your Appointment',
    body: 'Select your preferred date and time',
    flowParameters: {
      services: ['massage', 'facial'],
      vendor_id: 'vendor_789',
    },
  },
  meta: {},
});
```

---

## Error Handling

### Complete Example with Error Handling

```typescript
import { WhatsAppMessagingService } from './services/whatsapp-messaging.service';
import {
  PolicyViolationError,
  IdempotencyRequiredError,
  DuplicateMessageError,
} from './types/whatsapp-error.types';

const whatsappService = new WhatsAppMessagingService();

try {
  const result = await whatsappService.send({
    to: '+1234567890',
    type: 'template',
    message: {
      type: 'template',
      name: 'booking_confirmation',
      language: 'en',
      components: [...],
    },
    meta: {
      idempotencyKey: 'booking_123',
      traceId: 'req_001',
    },
  });

  if (result.success) {
    console.log('✓ Message sent:', result.messageId);
  } else {
    console.error('✗ Send failed:', result.error);
    
    // Check specific error codes
    if (result.error?.code === 'POLICY_VIOLATION') {
      // Handle policy violation (e.g., outside 24h window)
      console.log('Policy violation details:', result.error.details);
    }
  }
} catch (error) {
  if (error instanceof PolicyViolationError) {
    console.error('Policy violation:', error.message);
    console.log('Allowed types:', error.details.allowedTypes);
  } else if (error instanceof IdempotencyRequiredError) {
    console.error('Idempotency key required for this message type');
  } else if (error instanceof DuplicateMessageError) {
    console.error('Duplicate message detected');
    console.log('Original message ID:', error.details.originalMessageId);
  } else {
    console.error('Unknown error:', error);
  }
}
```

---

## Best Practices

### 1. Always Use Idempotency for Templates

```typescript
// ✅ GOOD
await whatsappService.send({
  type: 'template',
  message: { ... },
  meta: {
    idempotencyKey: `booking_${bookingId}_confirmation`,
  },
});

// ❌ BAD  (will throw IdempotencyRequiredError)
await whatsappService.send({
  type: 'template',
  message: { ... },
  meta: {},
});
```

### 2. Use Template Constants

```typescript
// ✅ GOOD
import { TEMPLATE_NAMES } from './handlers/template/template-constants';

message: {
  type: 'template',
  name: TEMPLATE_NAMES.BOOKING_CONFIRMATION,
  ...
}

// ❌ BAD
message: {
  type: 'template',
  name: 'booking_confirmation', // Magic string
  ...
}
```

### 3. Include Trace IDs

```typescript
// ✅ GOOD
meta: {
  traceId: `${requestId}_whatsapp`,
}

// Makes debugging easier in production
```

### 4. Handle Policy Violations Gracefully

```typescript
try {
  await whatsappService.send({
    type: 'text',
    message: { ... },
  });
} catch (error) {
  if (error instanceof PolicyViolationError && error.details.policyType === '24H_WINDOW') {
    // Fallback to template message
    await whatsappService.send({
      type: 'template',
      message: { ... },
    });
  }
}
```

---

## Testing

### Mock Provider for Tests

```typescript
import { WhatsAppProvider } from './providers/provider.interface';

class MockWhatsAppProvider implements WhatsAppProvider {
  private messages: any[] = [];

  async send(payload: any): Promise<SendResult> {
    this.messages.push(payload);
    return {
      success: true,
      messageId: `mock_${Date.now()}`,
      meta: { timestamp: new Date() },
    };
  }

  getName(): string {
    return 'Mock Provider';
  }

  getMessages() {
    return this.messages;
  }
}

// In tests
const mockProvider = new MockWhatsAppProvider();
// Inject mock provider into service
```

---

For more information, see [README.md](./README.md).
