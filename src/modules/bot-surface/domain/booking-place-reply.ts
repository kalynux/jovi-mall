import type { AppointmentAccessView, CustomerLocationView } from '../../booking/domain/appointment';
import type { BotReplyIntent, BotReplyOption } from './channel-reply';
import { proposalMoment } from './bot-booking-proposal-copy';
import { bookingPlaceReplyCopy } from './bot-booking-place-copy';
import { bookingPlaceActionId } from './bot-action-id';

/**
 * What the chat sends about WHERE an appointment happens (2026-10-27, owner decision A-5) — pure,
 * so `test:bot-booking-address` drives every branch with nothing running. The controller reads
 * the booking and hands over `customerAppointmentFields`' output; nothing here decides what the
 * customer may see.
 */

function addressLineOf(location: CustomerLocationView): string {
    return (location.formattedAddress
        || [location.addressLine1, location.city, location.state, location.country].filter(Boolean).join(', ')
        || '').trim();
}

/**
 * What the customer is sent about a booking's place. Pure — `test:bot-booking-address` drives it.
 *
 * ⚠ **It shows only what it is handed.** `location` and `access` are the outputs of
 * `customerAppointmentFields`; an address that is not visible arrives without its lines, and a
 * locked link arrives without the link, so this function cannot leak either by mistake.
 */
export function placeReplyIntent(input: {
    location: CustomerLocationView | null;
    access: AppointmentAccessView | null;
    placeName: string;
    timezone: string | null;
    language: string | null;
}): BotReplyIntent {
    const copy = bookingPlaceReplyCopy(input.language);
    const when = (at: Date): string => proposalMoment(at, input.timezone, input.language);
    const { location, access } = input;

    const accessLines = (forLink: boolean): string[] => {
        if (!access) return forLink ? [copy.linkNotSet] : [];
        if (forLink) {
            if (!access.hasMeetingUrl) return [copy.linkNotSet];
            if (access.state === 'open' && access.meetingUrl) return [copy.link(access.meetingUrl)];
            return [copy.linkLater[access.reason ?? 'too_early'](when(access.opensAt))];
        }
        if (!access.hasInstructions) return [];
        if (access.state === 'open' && access.instructions) return [copy.instructions(access.instructions)];
        if (access.reason && access.reason !== 'ended') return [copy.instructionsLater[access.reason](when(access.opensAt))];
        return [];
    };

    if (!location) return { kind: 'text', text: copy.noPlace };

    if (location.kind === 'online') {
        return { kind: 'text', text: accessLines(true).join('\n') };
    }

    if (!location.addressVisible) {
        return { kind: 'text', text: copy.addressAfterAccept };
    }

    const address = addressLineOf(location);
    const description = (location.addressLine2 ?? '').trim();

    if (location.kind === 'customer_address') {
        const lines = [copy.atYourAddress(description ? `${address} (${description})` : address), ...accessLines(false)];
        return { kind: 'text', text: lines.join('\n') };
    }

    // The vendor's place: the pin first, then the words that go with it.
    const words = [address, description, ...accessLines(false)].filter((line) => line.length > 0).join('\n');
    const coords = location.coordinates;
    if (!coords || !address) return { kind: 'text', text: words || copy.noPlace };

    return {
        kind: 'sequence',
        parts: [
            {
                kind: 'place',
                // GeoJSON order, as every stored address keeps it: [lng, lat].
                latitude: coords[1],
                longitude: coords[0],
                name: input.placeName || address,
                address,
            },
            ...(description || accessLines(false).length > 0
                ? [{ kind: 'text' as const, text: [description, ...accessLines(false)].filter(Boolean).join('\n') }]
                : []),
        ],
    };
}

/** The "Show the place" button — for the receipt and the in-chat booking messages. */
export function showPlaceOption(bookingId: string, language: string | null): BotReplyOption {
    return { id: bookingPlaceActionId(bookingId), label: bookingPlaceReplyCopy(language).showPlaceButton };
}

