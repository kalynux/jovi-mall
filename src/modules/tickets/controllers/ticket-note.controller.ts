import { Request, Response } from 'express';
import { TicketNoteService } from '../services/ticket-note.service';
import { TicketEnrichmentService } from '../services/ticket-enrichment.service';
import { CreateNoteSchema } from '../validators/ticket-note.validator';
import { ActorRole, NoteVisibility } from '../types/ticket.types';
import { asyncHandler } from '../../../api/middlewares/async-handler';

const noteService = new TicketNoteService();
const enrichmentService = new TicketEnrichmentService();

export class TicketNoteController {

    static createNote = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.ticketId;
        const validated = CreateNoteSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const note = await noteService.createNote(
            ticketId,
            validated.content,
            userId,
            role,
            validated.visibility as NoteVisibility,
            validated.visibleToUserIds
        );

        const [enriched] = await enrichmentService.enrichNotes([note]);
        res.status(201).json({ success: true, data: enriched });
    });

    static listNotes = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.ticketId;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const notes = await noteService.listNotes(ticketId, userId, role);

        const enriched = await enrichmentService.enrichNotes(notes);
        res.status(200).json({ success: true, data: enriched });
    });
}
