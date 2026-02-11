import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { TicketNoteService } from '../services/ticket-note.service';
import { CreateNoteSchema } from '../validators/ticket-note.validator';
import { AppError } from '../../../core/errors';
import { ActorRole, NoteVisibility } from '../types/ticket.types';

/**
 * TicketNoteController
 * 
 * HTTP layer for ticket notes with visibility controls.
 */

export class TicketNoteController {
    private static noteService = new TicketNoteService();

    // * POST /api/*/tickets/:ticketId/notes
    // * Create a note on a ticket
  static async createNote(req: Request, res: Response): Promise < void> {
    try {
        const ticketId = req.params.ticketId;
        const validated = CreateNoteSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const note = await TicketNoteController.noteService.createNote(
            ticketId,
            validated.content,
            userId,
            role,
            validated.visibility as NoteVisibility,
            validated.visibleToUserIds
        );

        res.status(201).json({
            success: true,
            data: note
        });
    } catch(error) {
        TicketNoteController.handleError(error, res);
    }
}

// * GET /api/*/tickets /: ticketId / notes
// * List notes for a ticket(visibility - filtered)
  static async listNotes(req: Request, res: Response): Promise < void> {
    try {
        const ticketId = req.params.ticketId;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const notes = await TicketNoteController.noteService.listNotes(ticketId, userId, role);

        res.status(200).json({
            success: true,
            data: notes
        });
    } catch(error) {
        TicketNoteController.handleError(error, res);
    }
}

  /**
   * Centralized error handler
   */
  private static handleError(error: any, res: Response): void {
    if(error instanceof ZodError) {
    res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors
    });
    return;
}

if (error instanceof AppError) {
    res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
    });
    return;
}

console.error('Unexpected error:', error);
res.status(500).json({
    success: false,
    error: 'Internal server error'
});
  }
}
