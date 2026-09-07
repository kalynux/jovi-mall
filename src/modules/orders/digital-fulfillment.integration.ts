/**
 * Order Fulfillment Integration - Digital Product Auto-Grant
 * 
 * This file demonstrates how to integrate digital entitlement granting
 * into the order payment success flow.
 * 
 * INTEGRATION POINTS:
 * 1. Payment webhook handler
 * 2. Order service payment success callback
 * 3. Any place where order status changes to 'PAID'
 * 
 * CRITICAL: Must be idempotent (webhook retries safe)
 */

import { ProductModel } from '../catalog/models/product.model';
import { ProductVariantModel } from '../catalog/models/product-variant.model';
import { DigitalEntitlementService } from '../digital-delivery/services/digital-entitlement.service';
import { OrderTimelineRepository } from './order-timeline.repository';

/**
 * What the grant pass actually did, per order.
 *
 * Returned rather than logged-and-forgotten because the caller has to decide whether the
 * order is fulfilled, and "I tried" is not an answer to that question. See the ⚠ on
 * `handleDigitalProductFulfillment`.
 */
export interface DigitalFulfillmentResult {
  /** Digital line items that now have a live entitlement (including pre-existing ones). */
  granted: string[];
  /** Digital line items that do NOT, each with the reason. */
  failed: Array<{ orderItemId: string; productId: string; variantId: string; reason: string }>;
  /** Line items skipped because they are not digital — not a failure. */
  skipped: number;
}

/**
 * Handle payment success and grant digital entitlements
 *
 * This function should be called when:
 * - Payment webhook confirms successful payment
 * - Order status changes to 'PAID'
 * - Payment processor confirms transaction
 *
 * ⚠ **Every failure here used to be invisible, and one of them cost a customer their
 * purchase.** A per-item `catch` wrote to `console` and moved on; the caller ignored the
 * return and stamped `fulfillment_status = 'fulfilled'` regardless; and the payment
 * orchestrator wraps the whole call in a catch-all that swallows anything left, because a
 * webhook must still answer 200. Three layers of "carry on", and the only trace was a
 * console line that died with the next process restart. Order ORD-2026-000052 was paid,
 * marked fulfilled, and granted nothing — and there was no surviving evidence of why.
 *
 * So the outcome is now (a) returned to the caller, which decides fulfilment from it, and
 * (b) appended to the order timeline, which is durable, per-order, and already where an
 * investigation looks. The console line stays; it is just no longer the only record.
 *
 * @param orderId - Order ID that was paid
 * @param orderItems - Array of order items with product details
 * @param customerId - Customer who made the purchase
 * @returns Per-item outcome. A non-empty `failed` means the order is NOT fulfilled.
 */
export async function handleDigitalProductFulfillment(
  orderId: string,
  orderItems: Array<{
    _id: string; // orderItemId
    productId: string;
    variantId: string;
    quantity: number;
  }>,
  customerId: string
): Promise<DigitalFulfillmentResult> {
  const entitlementService = new DigitalEntitlementService();
  const result: DigitalFulfillmentResult = { granted: [], failed: [], skipped: 0 };

  const fail = (item: { _id: string; productId: string; variantId: string }, reason: string) => {
    console.error(
      `❌ [DigitalFulfillment] order ${orderId}, item ${item._id}: ${reason}`
    );
    result.failed.push({
      orderItemId: item._id,
      productId: item.productId,
      variantId: item.variantId,
      reason,
    });
  };

  // Process each order item
  for (const item of orderItems) {
    try {
      const product = await ProductModel.findById(item.productId);

      if (!product) {
        fail(item, `Product ${item.productId} not found`);
        continue;
      }

      // Only process digital products. Not a failure — a mixed order's physical
      // items go through the delivery system instead.
      if (product.type !== 'digital') {
        result.skipped++;
        continue;
      }

      if (!product.digitalConfig?.isActive) {
        fail(item, `Digital product ${product.id} is inactive`);
        continue;
      }

      const variant = await ProductVariantModel.findOne({
        _id: item.variantId,
        productId: product._id,
        deletedAt: null,
      });
      if (!variant) {
        fail(item, `Variant ${item.variantId} not found on product ${product.id}`);
        continue;
      }
      if (!variant.digitalConfig?.assetId) {
        fail(item, `Variant ${item.variantId} has no digital asset attached`);
        continue;
      }

      // Grant entitlement (IDEMPOTENT - safe for webhook retries).
      // maxDownloads / expiresAfterDays are snapshotted from the variant at grant time.
      const entitlement = await entitlementService.grantEntitlement({
        orderId,
        orderItemId: item._id.toString(),
        productId: product.id,
        variantId: variant._id.toString(),
        assetId: variant.digitalConfig.assetId.toString(),
        customerId,
        vendorId: product.vendorId.toString(),
        maxDownloads: variant.digitalConfig.maxDownloads ?? null,
        expiresAfterDays: variant.digitalConfig.expiresAfterDays ?? null,
      });

      result.granted.push(entitlement.id);

      console.log(
        `✅ Granted digital entitlement ${entitlement.id} for product ${product.title} (variant ${variant.name ?? variant.sku})`
      );
    } catch (error: any) {
      fail(item, `${error?.code ?? 'ERROR'}: ${error?.message ?? String(error)}`);
    }
  }

  await recordOutcome(orderId, result);

  return result;
}

/**
 * Append the grant pass to the order timeline.
 *
 * Best-effort by design and last in the sequence: the entitlements are already committed by
 * the time this runs, so a timeline write that fails must not undo or re-report them. It is
 * the audit trail, not the transaction.
 *
 * Uses `fulfillment.updated` — the same event type the module's other digital-fulfilment
 * records use — so one timeline read shows the whole story rather than two shapes.
 */
async function recordOutcome(orderId: string, result: DigitalFulfillmentResult): Promise<void> {
  if (result.granted.length === 0 && result.failed.length === 0) return; // nothing digital

  const description =
    result.failed.length === 0
      ? `Digital order fulfilled — ${result.granted.length} entitlement(s) granted.`
      : `Digital fulfilment INCOMPLETE — ${result.granted.length} granted, ${result.failed.length} failed. The customer cannot download the failed item(s).`;

  try {
    await new OrderTimelineRepository().appendEvent({
      orderId,
      eventType: 'fulfillment.updated',
      description,
      metadata: {
        entitlement_ids: result.granted,
        failures: result.failed,
      },
      actorType: 'system',
      actorId: null,
    });
  } catch (error: any) {
    console.error(
      `[DigitalFulfillment] Could not record the fulfilment outcome for order ${orderId}:`,
      error?.message ?? error
    );
  }
}

/**
 * Example Integration: Payment Webhook
 * 
 * Add this to your payment webhook handler
 */
export async function examplePaymentWebhookIntegration(webhookData: any) {
  const { orderId, status, paymentId } = webhookData;

  if (status !== 'SUCCESS') {
    return;
  }

  // Load order with items
  // const order = await OrderModel.findById(orderId).populate('items.productId');

  // Update order status
  // await OrderModel.updateOne({ _id: orderId }, { status: 'PAID' });

  // Grant digital entitlements
  // await handleDigitalProductFulfillment(
  //   order.id,
  //   order.items,
  //   order.customerId.toString()
  // );

  console.log('Payment webhook processed - digital entitlements granted');
}

/**
 * Example Integration: Order Service
 * 
 * Add this to your OrderService.markAsPaid() or similar method
 */
export class OrderServiceIntegrationExample {
  async markOrderAsPaid(orderId: string): Promise<void> {
    // Load order
    // const order = await OrderModel.findById(orderId);

    // Update status
    // order.status = 'PAID';
    // await order.save();

    // Grant digital entitlements
    // await handleDigitalProductFulfillment(
    //   order.id,
    //   order.items,
    //   order.customerId.toString()
    // );
  }
}

/**
 * Email Notification Example (TODO: Implement)
 */
async function sendDigitalProductReadyEmail(
  customerId: string,
  productTitle: string
): Promise<void> {
  // TODO: Integrate with your email service
  console.log(`Sending email to customer ${customerId} for product ${productTitle}`);

  // Example email content:
  // Subject: Your Digital Product is Ready
  // Body:
  //   Hi {customerName},
  //
  //   Your purchase of "{productTitle}" is complete!
  //
  //   You can now access your digital product from your account:
  //   {baseUrl}/customer/digital-products
  //
  //   Your download link will be available for {expiryDays} days with
  //   up to {maxDownloads} downloads.
  //
  //   Thank you for your purchase!
}
