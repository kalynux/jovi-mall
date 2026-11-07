import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { getGeocodingProvider } from '../../../core/geocoding';
import { CustomerProfileService } from '../../customers/services/customer-profile.service';
import type { AddCustomerAddressInput } from '../../customers/validators/customer-onboarding.validator';
import { BookingService } from '../../booking/services/booking.service';
import { appointmentLocationService } from '../../booking/services/appointment-location.service';
import { customerAppointmentFields, type CustomerLocationView } from '../../booking/domain/appointment';
import type { IBooking } from '../../booking/models/booking.model';
import { VendorModel } from '../../vendors/vendor.model';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import type { BotReplyOption, BotSingleReplyIntent } from '../domain/channel-reply';
import { bookingAddressStepCopy } from '../domain/bot-booking-place-copy';
import { placeReplyIntent } from '../domain/booking-place-reply';
import {
    bookingAddressCancelActionId,
    bookingAddressStepActionId,
    bookingPickerAtAddressActionId,
} from '../domain/bot-action-id';
import { ParsedBotAction, unknownBotAction, type BotActionHandlers } from '../domain/bot-action-dispatch';
import type { PendingQuestionOwner } from '../domain/bot-pending-question';
import { geoCandidateStore } from '../services/geo-candidate.store';
import { bookingAddressStepStore, type BookingAddressStep } from '../services/booking-address-step.store';
import { BotBookingAddressStepSchema, BotBookingParamSchema, BotNoArgsSchema } from '../validators/bot.validators';
import { __toSavedAddressInput as toSavedAddressInput } from './bot-profile.controller';
import { openInAppScreen } from './bot-inapp.controller';

/**
 * ⭐ **WHERE AN APPOINTMENT HAPPENS, IN THE CHAT** (2026-10-27,
 * `PRODUCTION-READINESS/BOT-BOOKING-ADDRESS-AND-PLACE-PLAN.md`).
 *
 * Two jobs, both owner decisions:
 *
 *   1. **The address step** (A-1…A-7). A service the provider travels to (`customer_address`)
 *      asks where, in the chat, BEFORE the time picker opens: a saved address (one tap), a shared
 *      location, or a typed address — map matches first, the typed text kept when the map knows
 *      nothing (then the town is asked) — and an optional description. The address is saved to the
 *      account and the picker opens with it chosen. Any other service asks nothing.
 *   2. **The place** (A-5). `place:<bookingId>` and `POST /bookings/:id/place` send a map pin and
 *      the address, or the session link, through `customerAppointmentFields` — the website's gate.
 *
 * ⚠ **The step's state is the backend's** (`booking-address-step.store.ts`); `/identity/sync`
 * reports it as `bookingAddress`, and the automation layer routes the customer's next text,
 * location or `gc_` tap to `/bookings/address-step` on that field alone.
 */

const customerProfileService = new CustomerProfileService();
const bookingService = new BookingService();

/** The step's owner — the conversation, as the pending-question store keys it. */
function ownerOf(req: Request): PendingQuestionOwner {
    const caller = botCallerOf(req);
    return { userId: caller.userId, channel: req.bot!.envelope.channel };
}

function cancelOption(language: string | null): BotReplyOption {
    return { id: bookingAddressCancelActionId(), label: bookingAddressStepCopy(language).cancelButton };
}

function clamp(value: string, max: number): string {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The address step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the step for this product and ask where (§ 3.1 step 2 of the plan).
 *
 * ⚠ **Two messages, because Telegram cannot put a location button and inline buttons on one.**
 * The saved addresses come first as buttons; the location request follows. With no saved address
 * the first message is skipped. Exported for the two Book doors (`open:bk`, `book:`).
 */
export async function startBookingAddressStep(req: Request, productId: string): Promise<void> {
    const owner = ownerOf(req);
    const language = botResponseLanguageOf(req);
    const copy = bookingAddressStepCopy(language);

    await bookingAddressStepStore.start(owner, productId);
    const saved = await appointmentLocationService.customerAddresses(owner.userId);

    const locationRequest: BotSingleReplyIntent = {
        kind: 'location_request',
        text: saved.length > 0 ? copy.typeOrShareToo : copy.typeOrShareOnly,
        buttonLabel: botChrome('locationButton', language),
    };

    if (saved.length === 0) {
        setBotReply(req, locationRequest);
        return;
    }

    setBotReply(req, {
        kind: 'sequence',
        parts: [
            {
                kind: 'choice',
                text: copy.pickSaved,
                listButton: copy.listButton,
                sectionTitle: copy.sectionTitle,
                options: [
                    // Nine at most, so the Cancel row still fits WhatsApp's ten-row list.
                    ...saved.slice(0, 9).map((a) => {
                        const line = [a.address_line1, a.city].filter(Boolean).join(', ');
                        return {
                            id: bookingPickerAtAddressActionId(productId, String(a._id)),
                            label: a.label ? `${a.label} — ${line}` : line,
                            shortLabel: a.label || line,
                            description: line,
                        };
                    }),
                    cancelOption(language),
                ],
            },
            locationRequest,
        ],
    });
}

/**
 * The same opening, for a door with no `req.bot` (the product screen): the step is started for the
 * session's conversation and the question is PUSHED, as text plus at most two saved addresses and
 * Cancel (the push helper's WhatsApp cap is three buttons). The customer types or shares a
 * location from there exactly as in the chat.
 */
export async function startBookingAddressStepFor(
    conversation: { userId: string; channel: PendingQuestionOwner['channel'] },
    productId: string,
    language: string | null,
): Promise<{ text: string; actions: BotReplyOption[] }> {
    const copy = bookingAddressStepCopy(language);
    await bookingAddressStepStore.start(conversation, productId);
    const saved = await appointmentLocationService.customerAddresses(conversation.userId);
    if (saved.length === 0) return { text: copy.typeOrShareOnly, actions: [cancelOption(language)] };
    return {
        text: `${copy.pickSaved}\n${copy.typeOrShareToo}`,
        actions: [
            ...saved.slice(0, 2).map((a) => ({
                id: bookingPickerAtAddressActionId(productId, String(a._id)),
                label: a.label || [a.address_line1, a.city].filter(Boolean).join(', '),
            })),
            cancelOption(language),
        ],
    };
}

/**
 * Open the time picker with the address chosen. The chat's last word on the step.
 *
 * ⚠ **The address must still be one of the tapper's saved addresses** — a button forwarded into
 * another chat names somebody else's id, and that is refused rather than booked.
 */
export async function openPickerAtAddress(req: Request, productId: string, addressId: string, savedLine?: string): Promise<void> {
    const owner = ownerOf(req);
    const saved = await appointmentLocationService.customerAddresses(owner.userId);
    if (!saved.some((a) => String(a._id) === addressId)) throw unknownBotAction();

    await bookingAddressStepStore.clear(owner);
    await openInAppScreen(req, {
        payload: { kind: 'bk', productId, bookingId: null, addressId },
        fallbackPath: `/shop/p/${productId}`,
        labelKey: 'bookChooseTimeButton',
    });

    // "Saved: …" above the picker door, when the address was just written.
    if (savedLine && req.bot?.replyIntent && req.bot.replyIntent.kind !== 'sequence' && req.bot.replyIntent.kind !== 'product_list') {
        setBotReply(req, {
            kind: 'sequence',
            parts: [
                { kind: 'text', text: bookingAddressStepCopy(botResponseLanguageOf(req)).saved(savedLine) },
                req.bot.replyIntent,
            ],
        });
    }
}

/** No step, or a different one: the question has gone. Answered, never refused. */
function expired(req: Request, res: Response): void {
    setBotReply(req, { kind: 'text', text: bookingAddressStepCopy(botResponseLanguageOf(req)).expired });
    sendSuccess(res, { active: false });
}

function askDescription(req: Request, language: string | null): void {
    const copy = bookingAddressStepCopy(language);
    setBotReply(req, {
        kind: 'text',
        text: copy.askDescription,
        actions: [
            { id: bookingAddressStepActionId('nodesc'), label: copy.noDescriptionButton },
            cancelOption(language),
        ],
    });
}

/**
 * Write the address the step collected and open the picker with it.
 *
 * ⚠ **No `location` key is ever written** — a map match goes through `toSavedAddressInput`, which
 * writes `geo` only, and a typed address writes `geo: null`. A null inside the 2dsphere-indexed
 * array would make the whole customer document unwritable.
 */
async function finishStep(req: Request, res: Response, step: BookingAddressStep, description: string | null): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const copy = bookingAddressStepCopy(language);
    const existing = await appointmentLocationService.customerAddresses(caller.userId);
    // The first address on an account is its default, as every other door makes it.
    const isDefault = existing.length === 0;

    let input: AddCustomerAddressInput;
    if (step.candidate) {
        input = toSavedAddressInput({
            label: copy.addressLabel,
            addressLine2: description,
            isDefault,
            candidate: step.candidate.candidate,
            rawInput: step.candidate.rawInput,
        });
    } else if (step.typed && step.city) {
        input = {
            label: copy.addressLabel,
            address_line1: clamp(step.typed, 200),
            address_line2: description,
            city: clamp(step.city, 100),
            state: null,
            is_default: isDefault,
            geo: null,
        } as AddCustomerAddressInput;
    } else {
        expired(req, res);
        return;
    }

    const profile = await customerProfileService.addAddress(caller.customerId, input);
    // `addAddress` pushes, so the newest is last.
    const written = profile.savedAddresses[profile.savedAddresses.length - 1] as { _id?: unknown; id?: unknown } | undefined;
    const addressId = String(written?._id ?? written?.id ?? '');
    const line = step.candidate
        ? step.candidate.candidate.formatted_address
        : `${clamp(step.typed ?? '', 200)}, ${clamp(step.city ?? '', 100)}`;

    await openPickerAtAddress(req, step.productId, addressId, description ? `${line} (${description})` : line);
    sendSuccess(res, { active: false, addressId, productId: step.productId });
}

export class BotBookingAddressController {
    /**
     * `POST /bookings/address-step` — the customer's next message while the step is open.
     *
     * The automation layer sends whatever arrived (text · location · `gc_` tap) and interprets
     * nothing; which question it answers is decided here, from the step's stage.
     */
    static answer = asyncHandler(async (req: Request, res: Response) => {
        const input = BotBookingAddressStepSchema.parse(req.body ?? {});
        const owner = ownerOf(req);
        const language = botResponseLanguageOf(req);
        const copy = bookingAddressStepCopy(language);

        const step = await bookingAddressStepStore.peek(owner);
        if (!step) {
            expired(req, res);
            return;
        }

        // ── A map match tapped (or a pin confirmed) ─────────────────────────
        if (input.token !== undefined) {
            const stored = await geoCandidateStore.consume(owner.userId, input.token);
            if (!stored) {
                // A spent or lapsed handle: ask again rather than refuse — the step is still open.
                setBotReply(req, { kind: 'text', text: copy.typeOrShareOnly, actions: [cancelOption(language)] });
                sendSuccess(res, { active: true, stage: step.stage });
                return;
            }
            await bookingAddressStepStore.save(owner, { ...step, stage: 'description', candidate: stored, city: null });
            askDescription(req, language);
            sendSuccess(res, { active: true, stage: 'description' });
            return;
        }

        // ── A location shared — at any stage it means "here, instead" ───────
        if (input.location !== undefined) {
            const candidate = await getGeocodingProvider().reverse(input.location.lat, input.location.lng);
            await bookingAddressStepStore.save(owner, { ...step, stage: 'address', candidate: null, city: null });
            if (!candidate) {
                setBotReply(req, { kind: 'text', text: copy.pinNotFound, actions: [cancelOption(language)] });
                sendSuccess(res, { active: true, stage: 'address' });
                return;
            }
            const [ref] = await geoCandidateStore.mint(owner.userId, [candidate], null);
            setBotReply(req, {
                kind: 'choice',
                text: copy.confirmPin,
                listButton: copy.listButton,
                sectionTitle: copy.sectionTitle,
                options: [
                    {
                        id: ref,
                        label: candidate.formatted_address,
                        shortLabel: candidate.components.street ?? candidate.components.neighbourhood ?? candidate.components.city ?? candidate.formatted_address,
                        description: candidate.formatted_address,
                    },
                    cancelOption(language),
                ],
            });
            sendSuccess(res, { active: true, stage: 'address' });
            return;
        }

        const text = input.text!;

        // ── The town, for a typed address the map did not know ──────────────
        if (step.stage === 'city') {
            await bookingAddressStepStore.save(owner, { ...step, stage: 'description', city: clamp(text, 100) });
            askDescription(req, language);
            sendSuccess(res, { active: true, stage: 'description' });
            return;
        }

        // ── The description, last ───────────────────────────────────────────
        if (step.stage === 'description') {
            await finishStep(req, res, step, clamp(text, 200));
            return;
        }

        // ── A typed address: map matches first ──────────────────────────────
        const candidates = await getGeocodingProvider().search(text, { limit: 5 });
        const refs = await geoCandidateStore.mint(owner.userId, candidates, text);
        await bookingAddressStepStore.save(owner, { ...step, stage: 'address', typed: clamp(text, 200), candidate: null, city: null });

        const useTyped: BotReplyOption = {
            id: bookingAddressStepActionId('typed'),
            label: copy.useTypedButton,
            description: clamp(text, 72),
        };

        if (candidates.length === 0) {
            setBotReply(req, {
                kind: 'text',
                text: copy.notFound,
                actions: [{ id: useTyped.id, label: useTyped.label }, cancelOption(language)],
            });
            sendSuccess(res, { active: true, stage: 'address', matches: 0 });
            return;
        }

        setBotReply(req, {
            kind: 'choice',
            text: copy.chooseMatch,
            listButton: copy.listButton,
            sectionTitle: copy.sectionTitle,
            options: [
                ...candidates.map((c, i) => ({
                    id: refs[i],
                    label: c.formatted_address,
                    shortLabel: c.components.street ?? c.components.neighbourhood ?? c.components.city ?? c.formatted_address,
                    description: c.formatted_address,
                })),
                useTyped,
                cancelOption(language),
            ],
        });
        sendSuccess(res, { active: true, stage: 'address', matches: candidates.length });
    });

    /**
     * `POST /bookings/:bookingId/place` — `bookings_show_place`: where this appointment happens.
     * The same answer as the `place:` button.
     */
    static place = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        await answerPlace(req, res, bookingId);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The step's buttons
// ─────────────────────────────────────────────────────────────────────────────

/** `yes:bkadr:typed` · `yes:bkadr:nodesc`. */
async function addressStepButtonTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const owner = ownerOf(req);
    const language = botResponseLanguageOf(req);
    const step = await bookingAddressStepStore.peek(owner);
    if (!step) {
        expired(req, res);
        return;
    }

    if (action.argument === 'typed') {
        if (!step.typed) {
            expired(req, res);
            return;
        }
        await bookingAddressStepStore.save(owner, { ...step, stage: 'city', candidate: null });
        setBotReply(req, {
            kind: 'text',
            text: bookingAddressStepCopy(language).askCity,
            actions: [cancelOption(language)],
        });
        sendSuccess(res, { active: true, stage: 'city' });
        return;
    }

    if (action.argument === 'nodesc') {
        if (step.stage !== 'description') {
            expired(req, res);
            return;
        }
        await finishStep(req, res, step, null);
        return;
    }

    throw unknownBotAction();
}

/** `no:bkadr` — stop asking. */
async function addressStepCancelTap(req: Request, res: Response): Promise<void> {
    await bookingAddressStepStore.clear(ownerOf(req));
    setBotReply(req, { kind: 'text', text: bookingAddressStepCopy(botResponseLanguageOf(req)).stopped });
    sendSuccess(res, { active: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The place
// ─────────────────────────────────────────────────────────────────────────────

/** `place:<bookingId>`. */
async function placeTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    if (!/^[0-9a-f]{24}$/.test(action.argument)) throw unknownBotAction();
    await answerPlace(req, res, action.argument);
}

async function answerPlace(req: Request, res: Response, bookingId: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    // Scoped to the caller: somebody else's booking is the same 404 as none.
    const booking = await bookingService.getUserBooking(bookingId, caller.userId);
    const fields = customerAppointmentFields(booking);
    const timezone = await vendorTimezone(booking.vendorId);

    setBotReply(req, placeReplyIntent({
        location: fields.location,
        access: fields.access,
        placeName: placeNameOf(booking, fields.location),
        timezone,
        language,
    }));

    sendSuccess(res, {
        bookingId,
        locationKind: fields.location?.kind ?? null,
        addressVisible: fields.location?.addressVisible ?? false,
        accessState: fields.access?.state ?? null,
    });
}

async function vendorTimezone(vendorRef: unknown): Promise<string | null> {
    const id = vendorRef !== null && typeof vendorRef === 'object' && '_id' in vendorRef
        ? (vendorRef as { _id: unknown })._id
        : vendorRef;
    const vendor = await VendorModel.findById(id).select('timezone').lean();
    return (vendor as { timezone?: string } | null)?.timezone ?? null;
}

/** The pin's title: the address's own name, else the shop, else the service. */
function placeNameOf(booking: IBooking, location: CustomerLocationView | null): string {
    const vendor = booking.vendorId as unknown as { display_name?: string } | null;
    const product = booking.productId as unknown as { title?: string } | null;
    return (location?.label || vendor?.display_name || product?.title || '').trim();
}

export const BOOKING_ADDRESS_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    'yes:bkadr': addressStepButtonTap,
    'no:bkadr': (req: Request, res: Response) => addressStepCancelTap(req, res),
    place: placeTap,
});
