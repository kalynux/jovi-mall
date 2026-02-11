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

import { Types } from 'mongoose';
import { ProductModel } from '../catalog/models/product.model';
import { DigitalEntitlementService } from '../digital-delivery/services/digital-entitlement.service';

/**
 * Handle payment success and grant digital entitlements
 * 
 * This function should be called when:
 * - Payment webhook confirms successful payment
 * - Order status changes to 'PAID'
 * - Payment processor confirms transaction
 * 
 * @param orderId - Order ID that was paid
 * @param orderItems - Array of order items with product details
 * @param customerId - Customer who made the purchase
 */
export async function handleDigitalProductFulfillment(
  orderId: string,
  orderItems: Array<{
    _id: string; // orderItemId
    productId: string;
    quantity: number;
  }>,
  customerId: string
): Promise<void> {
  const entitlementService = new DigitalEntitlementService();

  // Process each order item
  for (const item of orderItems) {
    try {
      // Load product to check type
      const product = await ProductModel.findById(item.productId);

      if (!product) {
        console.warn(`Product ${item.productId} not found for order ${orderId}`);
        continue;
      }

      // Only process digital products
      if (product.type === 'digital') {
        // Verify digitalConfig exists
        if (!product.digitalConfig || !product.digitalConfig.isActive) {
          console.error(
            `Digital product ${product.id} has no active configuration. Entitlement not granted.`
          );
          // TODO: Alert vendor or create support ticket
          continue;
        }

        // Grant entitlement (IDEMPOTENT - safe for webhook retries)
        const entitlement = await entitlementService.grantEntitlement({
          orderId,
          orderItemId: item._id.toString(),
          productId: product.id,
          assetId: product.digitalConfig.assetId.toString(),
          customerId,
          vendorId: product.vendorId.toString(),
        });

        console.log(
          `✅ Granted digital entitlement ${entitlement.id} for product ${product.title}`
        );

        // TODO: Send customer notification email
        // await sendDigitalProductReadyEmail(customerId, product.title);
      }
    } catch (error: any) {
      console.error(
        `❌ Failed to grant entitlement for order ${orderId}, item ${item._id}:`,
        error.message
      );

      // IMPORTANT: Don't throw - log error and continue
      // Manual entitlement grant can be done later if needed
      // TODO: Create error tracking entry for admin review
    }
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
