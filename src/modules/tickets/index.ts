/**
 * Ticketing Module Routes Index
 * 
 * Exports all role-specific ticket routes for registration in main app.
 */

import { buildAdminTicketRouter } from './routes/admin-ticket.routes';
import vendorTicketRoutes from './routes/vendor-ticket.routes';
import customerTicketRoutes from './routes/customer-ticket.routes';
import agencyTicketRoutes from './routes/agency-ticket.routes';
import agentTicketRoutes from './routes/agent-ticket.routes';

export {
    // A FACTORY, unlike its siblings: the admin surface is internal-only and takes its
    // guards as a parameter. There is no public `/api/admin/tickets` mount any more.
    buildAdminTicketRouter,
    vendorTicketRoutes,
    customerTicketRoutes,
    agencyTicketRoutes,
    agentTicketRoutes
};
