/**
 * Ticketing Module Routes Index
 * 
 * Exports all role-specific ticket routes for registration in main app.
 */

import adminTicketRoutes from './routes/admin-ticket.routes';
import vendorTicketRoutes from './routes/vendor-ticket.routes';
import customerTicketRoutes from './routes/customer-ticket.routes';
import agencyTicketRoutes from './routes/agency-ticket.routes';
import agentTicketRoutes from './routes/agent-ticket.routes';

export {
    adminTicketRoutes,
    vendorTicketRoutes,
    customerTicketRoutes,
    agencyTicketRoutes,
    agentTicketRoutes
};
