import { WhatsAppMessagingService, getWhatsAppMessagingService } from './whatsapp-messaging.service';
import { SendResult } from '../types/whatsapp-message.types';
import {
    WaServiceMessage,
    TextOptions,
    MediaOptions,
    DocumentOptions,
    ButtonsOptions,
    ListOptions,
    CtaUrlOptions,
    ContactsOptions,
    LocationOptions,
    ReactionOptions
} from '../builders/service-message.builder';

/**
 * WhatsAppServiceMessenger
 *
 * One-call facade for sending WhatsApp service messages: builds the payload via
 * `WaServiceMessage` and sends it through `WhatsAppMessagingService` (which keeps
 * all policy / 24h-window / idempotency / billing enforcement).
 *
 * Use `WaServiceMessage.*` directly when you only need the payload; use this when
 * you want build-and-send in one call.
 */
export class WhatsAppServiceMessenger {
    constructor(private readonly messaging: WhatsAppMessagingService = getWhatsAppMessagingService()) {}

    sendText(options: TextOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.text(options));
    }

    sendImage(options: MediaOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.image(options));
    }

    sendVideo(options: MediaOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.video(options));
    }

    sendAudio(options: MediaOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.audio(options));
    }

    sendDocument(options: DocumentOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.document(options));
    }

    sendButtons(options: ButtonsOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.buttons(options));
    }

    sendList(options: ListOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.list(options));
    }

    sendCtaUrl(options: CtaUrlOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.ctaUrl(options));
    }

    sendContacts(options: ContactsOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.contacts(options));
    }

    sendLocation(options: LocationOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.location(options));
    }

    sendReaction(options: ReactionOptions): Promise<SendResult> {
        return this.messaging.send(WaServiceMessage.reaction(options));
    }
}
