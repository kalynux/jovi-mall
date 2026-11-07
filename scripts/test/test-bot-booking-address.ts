/**
 * test:bot-booking-address — booking an appointment from the bot: the address step and the place
 * pin (2026-10-27, `PRODUCTION-READINESS/BOT-BOOKING-ADDRESS-AND-PLACE-PLAN.md`).
 *
 * Offline: pure functions driven directly, plus source scans for the wiring a pure test cannot
 * reach (who clears the step, what the save writes). No Redis, no Mongo, no server.
 *
 * What it pins, by owner decision:
 *   A-1  only a service at the customer's address asks for one (the Book doors branch on it);
 *   A-2  map matches first, the typed text kept when the map knows nothing (then the town, A-7);
 *   A-3  the address is saved to the account — and never with a `location` key;
 *   A-5  the place goes out as a PIN plus words, through the website's own gates, and the
 *        coordinates never reach the model's context;
 *   A-6  the description is optional (a No description button);
 *   A-8  Show the place is on the receipt, booking.confirmed and booking.reminder.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { renderBotReplies, renderBotReply, type BotReplyIntent } from '../../src/modules/bot-surface/domain/channel-reply';
import { sentTextForIntent } from '../../src/modules/bot-surface/domain/bot-recently-sent';
import { pendingQuestionDecisionFor } from '../../src/modules/bot-surface/domain/bot-pending-question';
import { placeReplyIntent, showPlaceOption } from '../../src/modules/bot-surface/domain/booking-place-reply';
import { bookingAddressStepCopy, bookingPlaceReplyCopy } from '../../src/modules/bot-surface/domain/bot-booking-place-copy';
import {
    bookingAddressCancelActionId,
    bookingAddressStepActionId,
    bookingPickerAtAddressActionId,
    bookingPlaceActionId,
    continuesBookingAddressStep,
    parseBotActionId,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import { BotBookingAddressStepSchema } from '../../src/modules/bot-surface/validators/bot.validators';
import { needsAddress } from '../../src/modules/whatsapp/flows/screens/booking.adapter';
import { CUSTOMER_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/customer-notification-catalog';
import type { AppointmentAccessView, CustomerLocationView } from '../../src/modules/booking/domain/appointment';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean): void {
    try {
        if (fn()) {
            passed += 1;
            originalConsole.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            originalConsole.log(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ THROW: ${label} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

const SRC = join(__dirname, '..', '..', 'src', 'modules');
const code = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const HEX = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const HEX2 = 'f2e1d0c9b8a7f6e5d4c3b2a1';
const LANGUAGES = ['en', 'fr', 'pt', 'es', 'ar'] as const;
/** Douala, Akwa — [lng, lat], GeoJSON order, as every stored address keeps it. */
const COORDS: [number, number] = [9.7043, 4.0511];

const shop: CustomerLocationView = {
    kind: 'vendor_address',
    addressVisible: true,
    label: 'Salon Akwa',
    addressLine1: 'Rue Joss',
    addressLine2: 'Second floor, blue gate',
    city: 'Douala',
    state: 'Littoral',
    country: 'CM',
    formattedAddress: 'Rue Joss, Akwa, Douala',
    coordinates: COORDS,
};

const access = (over: Partial<AppointmentAccessView>): AppointmentAccessView => ({
    state: 'locked',
    reason: 'too_early',
    opensAt: new Date('2026-11-03T08:30:00Z'),
    closesAt: new Date('2026-11-03T11:00:00Z'),
    hasInstructions: true,
    hasMeetingUrl: false,
    ...over,
});

const textOf = (intent: BotReplyIntent): string => JSON.stringify(intent);

function main(): void {
    originalConsole.log('\n── 1. The pin, on both channels ─────────────────────────────────────');

    const pin: BotReplyIntent = { kind: 'place', latitude: 4.0511, longitude: 9.7043, name: 'Salon Akwa', address: 'Rue Joss, Akwa, Douala' };

    assert('Telegram: sendVenue with latitude, longitude, title and address', () => {
        const r = renderBotReply(pin, 'telegram', '12345');
        return r.method === 'sendVenue' && r.body.chat_id === '12345'
            && r.body.latitude === 4.0511 && r.body.longitude === 9.7043
            && r.body.title === 'Salon Akwa' && r.body.address === 'Rue Joss, Akwa, Douala';
    });

    assert('WhatsApp: a `location` message addressed to the sender, with name and address', () => {
        const r = renderBotReply(pin, 'whatsapp', '237600000000');
        const loc = r.body.location as Record<string, unknown>;
        return r.method === 'messages' && r.body.to === '237600000000' && r.body.type === 'location'
            && loc.latitude === 4.0511 && loc.longitude === 9.7043 && loc.name === 'Salon Akwa';
    });

    assert('⛔ the recorded text of a pin carries its name and address, NEVER the coordinates', () => {
        const line = sentTextForIntent(pin) ?? '';
        return line.includes('Salon Akwa') && !line.includes('4.0511') && !line.includes('9.7043');
    });

    originalConsole.log('\n── 2. A sequence is several messages, in order ───────────────────────');

    const seq: BotReplyIntent = { kind: 'sequence', parts: [pin, { kind: 'text', text: 'Second floor' }] };

    assert('renderBotReplies sends every part, in order, on both channels', () => {
        const tg = renderBotReplies(seq, 'telegram', '1');
        const wa = renderBotReplies(seq, 'whatsapp', '2');
        return tg.length === 2 && tg[0].method === 'sendVenue' && tg[1].method === 'sendMessage'
            && wa.length === 2 && wa[0].body.type === 'location' && wa[1].body.type === 'text';
    });

    assert('a caller that sends one message sends the FIRST part', () =>
        renderBotReply(seq, 'telegram', '1').method === 'sendVenue');

    assert('⛔ step buttons split across a sequence still SUPERSEDE a typed-answer question', () => {
        const decision = pendingQuestionDecisionFor({
            kind: 'sequence',
            parts: [
                { kind: 'text', text: 'Add a description', actions: [
                    { id: bookingAddressStepActionId('nodesc'), label: 'No description' },
                    { id: bookingAddressCancelActionId(), label: 'Cancel' },
                ] },
            ],
        }, new Date());
        return decision.kind === 'supersede';
    });

    originalConsole.log('\n── 3. The tokens ─────────────────────────────────────────────────────');

    assert('open:bk:<productId>:<addressId> fits Telegram\'s 64 bytes and routes to open:bk', () => {
        const t = bookingPickerAtAddressActionId(HEX, HEX2);
        const parsed = parseBotActionId(t);
        return Buffer.byteLength(t) <= 64 && !!parsed && actionKeyOf(parsed).key === 'open:bk'
            && actionKeyOf(parsed).action.argument === `${HEX}:${HEX2}`;
    });

    assert('place:<bookingId> routes by its own verb', () => {
        const parsed = parseBotActionId(bookingPlaceActionId(HEX));
        return !!parsed && actionKeyOf(parsed).key === 'place' && actionKeyOf(parsed).action.argument === HEX;
    });

    assert('the step buttons share ONE context: yes:bkadr:typed · yes:bkadr:nodesc · no:bkadr', () =>
        bookingAddressStepActionId('typed') === 'yes:bkadr:typed'
        && bookingAddressStepActionId('nodesc') === 'yes:bkadr:nodesc'
        && bookingAddressCancelActionId() === 'no:bkadr');

    originalConsole.log('\n── 4. The place reply follows the website\'s gates (A-5) ───────────────');

    const base = { placeName: 'Salon Akwa', timezone: 'Africa/Douala', language: 'en' };

    assert('no place set → one sentence', () => {
        const r = placeReplyIntent({ ...base, location: null, access: null });
        return r.kind === 'text' && r.text === bookingPlaceReplyCopy('en').noPlace;
    });

    assert('⛔ the shop has not accepted → "shown once accepted", and no pin', () => {
        const r = placeReplyIntent({ ...base, location: { kind: 'vendor_address', addressVisible: false }, access: null });
        return r.kind === 'text' && r.text === bookingPlaceReplyCopy('en').addressAfterAccept;
    });

    assert('the shop\'s place: a pin (lat = coords[1], lng = coords[0]) then the description', () => {
        const r = placeReplyIntent({ ...base, location: shop, access: null });
        if (r.kind !== 'sequence') return false;
        const [p, words] = r.parts;
        return p.kind === 'place' && p.latitude === COORDS[1] && p.longitude === COORDS[0]
            && p.name === 'Salon Akwa' && p.address === 'Rue Joss, Akwa, Douala'
            && words?.kind === 'text' && words.text.includes('Second floor, blue gate');
    });

    assert('⛔ instructions locked as too early: WHEN they appear, never the instructions', () => {
        const r = placeReplyIntent({ ...base, location: shop, access: access({}) });
        const all = textOf(r);
        return all.includes("The shop's instructions appear here from") && !all.includes('Ring twice');
    });

    assert('⛔ instructions locked as unpaid: say payment opens them', () =>
        textOf(placeReplyIntent({ ...base, location: shop, access: access({ reason: 'not_paid' }) }))
            .includes('once the appointment is paid'));

    assert('instructions open → included', () =>
        textOf(placeReplyIntent({ ...base, location: shop, access: access({ state: 'open', reason: null, instructions: 'Ring twice' }) }))
            .includes('Instructions from the shop: Ring twice'));

    assert('a shop address with no map point → the address in words, no pin', () => {
        const r = placeReplyIntent({ ...base, location: { ...shop, coordinates: null }, access: null });
        return r.kind === 'text' && r.text.includes('Rue Joss, Akwa, Douala');
    });

    assert('at the customer\'s address → their own address, in words', () => {
        const r = placeReplyIntent({ ...base, location: { ...shop, kind: 'customer_address' }, access: null });
        return r.kind === 'text' && r.text.startsWith('The provider comes to you:');
    });

    assert('⛔ online, locked: when the link appears — never the link', () => {
        const r = placeReplyIntent({
            ...base,
            location: { kind: 'online', addressVisible: false },
            access: access({ hasMeetingUrl: true, hasInstructions: false }),
        });
        return r.kind === 'text' && r.text.includes('Your link appears here from') && !r.text.includes('https://');
    });

    assert('online, open → the link', () => {
        const r = placeReplyIntent({
            ...base,
            location: { kind: 'online', addressVisible: false },
            access: access({ state: 'open', reason: null, hasMeetingUrl: true, meetingUrl: 'https://meet.example/abc' }),
        });
        return r.kind === 'text' && r.text === 'Your link: https://meet.example/abc';
    });

    assert('online with no link set → "the shop will add it"', () =>
        textOf(placeReplyIntent({ ...base, location: { kind: 'online', addressVisible: false }, access: null }))
            .includes(bookingPlaceReplyCopy('en').linkNotSet));

    originalConsole.log('\n── 5. The copy ───────────────────────────────────────────────────────');

    assert('every button title fits WhatsApp\'s 20 characters, in all five languages', () =>
        LANGUAGES.every((l) => {
            const c = bookingAddressStepCopy(l);
            return [c.cancelButton, c.useTypedButton, c.noDescriptionButton, c.listButton, bookingPlaceReplyCopy(l).showPlaceButton]
                .every((t) => t.length > 0 && t.length <= 20);
        }));

    assert('the section title fits a WhatsApp list section (24)', () =>
        LANGUAGES.every((l) => bookingAddressStepCopy(l).sectionTitle.length <= 24));

    assert('every sentence is translated (French and Arabic differ from English)', () => {
        const en = bookingAddressStepCopy('en');
        return (['fr', 'ar'] as const).every((l) => {
            const c = bookingAddressStepCopy(l);
            return c.pickSaved !== en.pickSaved && c.askDescription !== en.askDescription && c.askCity !== en.askCity
                && bookingPlaceReplyCopy(l).addressAfterAccept !== bookingPlaceReplyCopy('en').addressAfterAccept;
        });
    });

    assert('showPlaceOption draws place:<id> under the translated label', () => {
        const o = showPlaceOption(HEX, 'fr');
        return o.id === `place:${HEX}` && o.label === 'Voir le lieu';
    });

    originalConsole.log('\n── 6. The step\'s input ──────────────────────────────────────────────');

    assert('exactly one of text, location, token', () =>
        BotBookingAddressStepSchema.safeParse({ text: 'Akwa' }).success
        && BotBookingAddressStepSchema.safeParse({ location: { lat: 4, lng: 9 } }).success
        && BotBookingAddressStepSchema.safeParse({ token: 'gc_abc' }).success
        && !BotBookingAddressStepSchema.safeParse({}).success
        && !BotBookingAddressStepSchema.safeParse({ text: 'Akwa', token: 'gc_abc' }).success
        && !BotBookingAddressStepSchema.safeParse({ location: { lat: 99, lng: 9 } }).success);

    originalConsole.log('\n── 7. The picker takes the address the chat collected ───────────────');

    assert('the WhatsApp form asks for an address only when none was collected', () =>
        needsAddress({ kind: 'customer_address', copy: null, addresses: [] })
        && !needsAddress({ kind: 'customer_address', copy: null, addresses: [], chosenAddressId: HEX })
        && !needsAddress({ kind: 'vendor_address', copy: null, addresses: null }));

    const core = code('bot-surface/miniapp/surfaces/booking.core.ts');
    assert('confirm uses the screen\'s choice first, then the session\'s address', () =>
        core.includes('input.addressId ?? session.addressId ?? null'));
    assert('⛔ a collected address is re-checked against the customer\'s CURRENT addresses', () =>
        core.includes('presetAddressId ? saved.find((a) => a.addressId === presetAddressId) ?? null : null'));

    originalConsole.log('\n── 8. The wiring (source) ───────────────────────────────────────────');

    const ctl = code('bot-surface/controllers/bot-booking-address.controller.ts');
    const booking = code('bot-surface/controllers/bot-booking.controller.ts');
    const purchase = code('bot-surface/controllers/bot-purchase.controller.ts');
    const action = code('bot-surface/controllers/bot-action.controller.ts');
    const command = code('bot-surface/controllers/bot-command.controller.ts');
    const identity = code('bot-surface/controllers/bot-identity.controller.ts');

    assert('A-1: open:bk asks WHERE only for a service at the customer\'s address', () =>
        booking.includes("if ((await serviceLocationKind(productId)) === 'customer_address') {")
        && booking.includes('await startBookingAddressStep(req, productId);'));

    assert('A-1: the book door skips the picker for that service, and opens the step instead', () =>
        purchase.includes("const needsAddress = (await serviceLocationKind(productId)) === 'customer_address';")
        && purchase.includes('if (result.needsAddress) {\n        await startBookingAddressStep(req, result.productId);'));

    assert('⛔ A-3: a typed address saves with `geo: null` and no `location` key', () => {
        const finish = ctl.slice(ctl.indexOf('async function finishStep('), ctl.indexOf('export class BotBookingAddressController'));
        return finish.includes('geo: null,') && !/\blocation\s*:/.test(finish);
    });

    assert('A-2: a typed address searches the map first, and offers Use what I typed beside the matches', () =>
        ctl.includes('getGeocodingProvider().search(text, { limit: 5 })')
        && ctl.includes("id: bookingAddressStepActionId('typed')"));

    assert('A-7: Use what I typed asks the town before the description', () =>
        ctl.includes("stage: 'city'") && ctl.includes('.askCity'));

    assert('A-6: the description question carries No description', () =>
        ctl.includes("{ id: bookingAddressStepActionId('nodesc'), label: copy.noDescriptionButton }"));

    assert('⛔ a saved-address tap must still be one of the TAPPER\'s addresses', () =>
        ctl.includes("if (!saved.some((a) => String(a._id) === addressId)) throw unknownBotAction();"));

    assert('⛔ any other tap ends the step; only the step\'s own Yes and open:bk keep it', () =>
        action.includes('if (!continuesBookingAddressStep(token)) {')
        && continuesBookingAddressStep(bookingAddressStepActionId('typed'))
        && continuesBookingAddressStep(bookingAddressStepActionId('nodesc'))
        && continuesBookingAddressStep(bookingPickerAtAddressActionId(HEX, HEX2))
        && !continuesBookingAddressStep(bookingAddressCancelActionId())
        && !continuesBookingAddressStep(bookingPlaceActionId(HEX))
        && !continuesBookingAddressStep('not a token'));

    assert('⛔ a command the platform answers ends the step', () =>
        command.includes("if (outcome.kind !== 'to_model') {") && command.includes('bookingAddressStepStore.clear('));

    assert('sync reports the step — and never while onboarding has a question', () =>
        identity.includes('const bookingAddress = dto.onboarding.next')
        && identity.includes('{ ...dto, pendingBargain, bookingAddress }'));

    assert('⛔ the place reply is built from customerAppointmentFields, owner-scoped', () =>
        ctl.includes('await bookingService.getUserBooking(bookingId, caller.userId)')
        && ctl.includes('const fields = customerAppointmentFields(booking);'));

    originalConsole.log('\n── 9. Show the place on the messages (A-8) ──────────────────────────');

    for (const situation of ['booking.confirmed', 'booking.reminder'] as const) {
        assert(`${situation} offers place:{{bookingId}}, falling back to My bookings in a template`, () => {
            const entry = (CUSTOMER_NOTIFICATION_CATALOG as Record<string, { actions?: Array<{ token: string; templateFallback?: string }> }>)[situation];
            const action = (entry.actions ?? []).find((a) => a.token === 'place:{{bookingId}}');
            return !!action && action.templateFallback === 'open:bl';
        });
    }

    const screens = code('bot-surface/miniapp/surfaces/booking.controller.ts');
    assert('the chat receipt carries Show the place for the shop\'s place or online — never for a move', () =>
        screens.includes("const place = !outcome.moved && (outcome.placeKind === 'vendor_address' || outcome.placeKind === 'online')"));

    originalConsole.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    originalConsole.error('test:bot-booking-address crashed:', error);
    process.exitCode = 1;
}
