import { TicketModel } from '../../tickets/models/ticket.model';
import { TicketAttachmentModel } from '../../tickets/models/ticket-attachment.model';
import { IFileReferenceRepository } from '../../catalog/repositories/interfaces/file-reference.repository.interface';
import { FileCleanupConfig, daysAgo } from '../../../config/file-cleanup.config';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';

export interface TicketStageResult {
  ticketsProcessed: number;
  attachmentsDetached: number;
}

/** Matches the field used by TicketAttachmentService when registering references. */
const TICKET_FILE_REFERENCE_FIELD = 'attachment';

/**
 * TicketAttachmentCleanupService — Stage A (tickets).
 *
 * Detaches and removes attachments from tickets that have sat in a terminal
 * status (resolved/closed) for `ticketTerminalGraceDays`, measured by the stable
 * `terminalAt` stamp. Releasing each file reference flips File.orphanedAt, so the
 * underlying files follow the same Stage B lonely-deletion path as product media.
 *
 * Note: tickets that reached a terminal status before `terminalAt` existed have a
 * null stamp and are skipped until they next transition — a deliberate safety
 * choice (no unreliable updatedAt fallback).
 */
export class TicketAttachmentCleanupService {
  constructor(
    private readonly fileReferenceRepository: IFileReferenceRepository,
    private readonly audit: CleanupAuditRepository,
    private readonly config: FileCleanupConfig,
  ) {}

  async run(sweepId: string, now: Date = new Date()): Promise<TicketStageResult> {
    const cutoff = daysAgo(this.config.ticketTerminalGraceDays, now);
    const result: TicketStageResult = { ticketsProcessed: 0, attachmentsDetached: 0 };

    const tickets = await TicketModel.find({
      status: { $in: this.config.terminalTicketStatuses },
      terminalAt: { $ne: null, $lt: cutoff },
      deletedAt: null,
    })
      .select('_id')
      .limit(this.config.batchSize)
      .lean();

    for (const ticket of tickets) {
      result.ticketsProcessed += 1;
      const ticketId = ticket._id.toString();

      const attachments = await TicketAttachmentModel.find({ ticket_id: ticket._id }).lean();
      for (const attachment of attachments) {
        const fileId = attachment.file_id.toString();

        if (!this.config.dryRun) {
          await this.fileReferenceRepository.remove(
            fileId,
            'ticket',
            ticketId,
            TICKET_FILE_REFERENCE_FIELD,
          );
          await TicketAttachmentModel.deleteOne({ _id: attachment._id });
        }

        await this.audit.record({
          sweepId,
          stage: 'ticket_detach',
          action: 'detach',
          dryRun: this.config.dryRun,
          fileId,
          entityType: 'ticket',
          entityId: ticketId,
          reason: `ticket terminal ≥ ${this.config.ticketTerminalGraceDays}d`,
        });
        result.attachmentsDetached += 1;
      }
    }

    return result;
  }
}
