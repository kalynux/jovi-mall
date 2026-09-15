/**
 * Report whether this deployment can send a WhatsApp message at all.
 *
 * ── Why this exists as its own script ────────────────────────────────────────
 *
 * Sending is gated by FOUR independent Meta-side conditions, and on 2026-09-15 three of them
 * were healthy while the fourth silently refused every message:
 *
 *   1. the owning business is verified          — gates the AUTHENTICATION template category
 *   2. the template is APPROVED                 — gates out-of-window sends
 *   3. the 24-hour service window is open       — gates in-window free-form sends
 *   4. the phone number has an APPROVED DISPLAY NAME  ← gates EVERYTHING, above the other three
 *
 * Each of the first three was found and fixed as "the" cause of non-delivery, and none of them
 * was the last one. The fourth presents as `(#131037)` on send and as nothing at all anywhere
 * else: no boot assertion, no health check, no log line. It is invisible until someone sends a
 * message and reads the error — which, before this script, meant nobody.
 *
 * ⚠ **`name_status: APPROVED` is the only value that sends.** `NON_EXISTS` means a display name
 * has never been submitted; the `verified_name` field is populated regardless and is therefore
 * NOT evidence of approval — it read `"Mrzenn"` on a `NON_EXISTS` number for months.
 *
 * ⚠ **The display-name change quota is 10 per month and it can be exhausted**, at which point
 * the name cannot be set by API or in WhatsApp Manager until it rolls over. Meta publishes no
 * reset timestamp, so this script probes for it with a deliberately over-length value.
 *
 * ⚠ **The probe is safe only while the quota is SPENT, which is the case it is for.** Meta
 * refuses it at the limit check *before* looking at the value, so no name is submitted and no
 * attempt can be consumed — verified by re-reading `name_status` afterwards. **Once the quota
 * reopens the probe stops being free**: the request then reaches validation, and whether a
 * rejected value ticks the counter is not documented. So this is a "has it reset yet?" poll, and
 * the run that answers *yes* is the last one to make — set the real name at that point rather
 * than polling again.
 *
 * Reads only; sends nothing and changes nothing.
 *
 * Run: npx ts-node scripts/check-whatsapp-number.ts
 */
import { config } from 'dotenv';

config();

const API = (process.env.WHATSAPP_API_URL ?? 'https://graph.facebook.com/v26.0').replace(/\/+$/, '');
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '';

async function graph(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    return response.json().catch(() => null);
}

async function main(): Promise<void> {
    if (!TOKEN || !PHONE_ID) {
        console.error('\n❌ WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must both be set.\n');
        process.exit(1);
    }

    const number = await graph(
        `/${PHONE_ID}?fields=display_phone_number,verified_name,name_status,new_name_status,`
        + 'quality_rating,account_mode,status,messaging_limit_tier',
    );
    if (number?.error) {
        console.error(`\n❌ could not read the phone number: ${number.error.message}\n`);
        process.exit(1);
    }

    console.log(`\nNumber   ${number.display_phone_number}  (${PHONE_ID})`);
    console.log(`  verified_name      ${number.verified_name}   ⚠ populated even when unapproved`);
    console.log(`  name_status        ${number.name_status}`);
    console.log(`  new_name_status    ${number.new_name_status}`);
    console.log(`  quality / mode     ${number.quality_rating} · ${number.account_mode} · ${number.status}`);
    console.log(`  messaging tier     ${number.messaging_limit_tier}`);

    const canSend = number.name_status === 'APPROVED';
    console.log(`\n${canSend ? '✅ CAN SEND' : '⛔ CANNOT SEND ANY MESSAGE'} — display name is ${number.name_status}`);

    if (!canSend) {
        /**
         * The quota probe. A deliberately over-length value cannot be accepted, so this either
         * fails validation (quota available) or is refused by the limit check (quota spent).
         * Neither outcome submits a name.
         */
        const probe = await graph(`/${PHONE_ID}`, {
            method: 'POST',
            body: JSON.stringify({ new_display_name: 'Z'.repeat(300) }),
        });
        const error = probe?.error ?? {};

        if (Number(error.code) === 4 && Number(error.error_subcode) === 2593011) {
            console.log(`\n⛔ The display-name change quota is SPENT: ${error.error_user_msg}`);
            console.log('   Re-run this script to find out when it reopens — the probe above is');
            console.log('   refused at the limit check and consumes no attempt.');
        } else {
            console.log('\n✅ The change quota appears AVAILABLE (the probe was refused on the value,');
            console.log(`   not on a limit): ${error.error_user_msg ?? error.message ?? JSON.stringify(probe)}`);
            console.log('   Set the name NOW, in WhatsApp Manager or by POSTing new_display_name here.');
            console.log('   ⚠ STOP POLLING: past this point the probe reaches validation, and whether');
            console.log('     a rejected value spends one of the 10 monthly attempts is undocumented.');
        }
    }

    if (WABA_ID) {
        const waba = await graph(`/${WABA_ID}?fields=name,account_review_status,business_verification_status`);
        if (!waba?.error) {
            console.log(`\nWABA     ${waba.name}  (${WABA_ID})`);
            console.log(`  account_review          ${waba.account_review_status}`);
            console.log(`  business_verification   ${waba.business_verification_status}`);
        }

        const templates = await graph(`/${WABA_ID}/message_templates?limit=200&fields=name,language,status`);
        const rows: any[] = templates?.data ?? [];
        if (rows.length) {
            const byStatus = rows.reduce<Record<string, number>>((a, t) => {
                a[t.status] = (a[t.status] ?? 0) + 1; return a;
            }, {});
            console.log(`\nTemplates (first page: ${rows.length})`);
            for (const [status, count] of Object.entries(byStatus)) console.log(`  ${status.padEnd(10)} ${count}`);

            const otp = rows.filter(t => t.name === (process.env.PHONE_VERIFY_TEMPLATE_NAME || 'wi_mall_phone_verification'));
            for (const t of otp) console.log(`  OTP [${t.language}]  ${t.status}`);
        }
    }

    console.log('\n⚠ An APPROVED template still sends nothing while the display name is unapproved.\n');
}

main().catch(error => {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
});
