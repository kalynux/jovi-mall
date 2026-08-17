#!/usr/bin/env ts-node

/**
 * Migrate embedded customer payment methods → unified `user_payment_methods`.
 *
 * Copies every row from `customers.saved_payment_methods[]` into the new
 * role-agnostic `user_payment_methods` collection with owner_role='customer'.
 * Saved methods are now stored exclusively there; the embedded array is left
 * untouched on the customer documents for safety but is no longer read.
 *
 * Idempotent: a customer is skipped if it already has migrated methods (matched
 * by gateway_instrument_id), so it is safe to re-run.
 *
 * Usage:
 *   ts-node scripts/migrate-customer-payment-methods.ts
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CustomerModel } from '../src/modules/customers/customer.model';
import { UserPaymentMethodModel } from '../src/modules/payment-methods/models/user-payment-method.model';

dotenv.config();

async function main() {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

    console.log('[Migrate] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[Migrate] Connected.');

    let migrated = 0;
    let skipped = 0;

    try {
        const customers = await CustomerModel.find({
            'saved_payment_methods.0': { $exists: true },
        }).exec();

        console.log(`[Migrate] ${customers.length} customer(s) with embedded payment methods.`);

        for (const customer of customers) {
            for (const m of customer.saved_payment_methods) {
                const exists = await UserPaymentMethodModel.exists({
                    owner_role: 'customer',
                    owner_id: customer._id,
                    gateway_instrument_id: m.gateway_instrument_id,
                });
                if (exists) {
                    skipped++;
                    continue;
                }

                await UserPaymentMethodModel.create({
                    owner_role: 'customer',
                    owner_id: customer._id,
                    provider: m.provider,
                    gateway_customer_id: m.gateway_customer_id,
                    gateway_instrument_id: m.gateway_instrument_id,
                    method_type: m.method_type,
                    display_label: m.display_label,
                    is_default: m.is_default,
                });
                migrated++;
            }
        }

        console.log(`[Migrate] Done. Migrated ${migrated}, skipped ${skipped} (already present).`);
    } finally {
        await mongoose.disconnect();
        console.log('[Migrate] Disconnected.');
    }
}

main().catch((err) => {
    console.error('[Migrate] Failed:', err);
    process.exit(1);
});
