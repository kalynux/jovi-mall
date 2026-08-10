import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { CustomerNotificationController } from '../controllers/customer-notification.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

/**
 * CUSTOMER NOTIFICATION INBOX
 *
 * ROUTE ORDER: every literal path is declared BEFORE `/:id/...`, or Express
 * matches 'unread-count' / 'preferences' / 'read-all' as an `:id` and the
 * handler receives a notification id that is really a word.
 */

/**
 * GET /api/customer/notifications
 * Query: page, limit, unreadOnly ('true'|'false'), aggregateType.
 */
router.get('/', CustomerNotificationController.list);

/** GET /api/customer/notifications/unread-count → { unreadCount } */
router.get('/unread-count', CustomerNotificationController.unreadCount);

/** GET /api/customer/notifications/preferences */
router.get('/preferences', CustomerNotificationController.getPreferences);

/**
 * PATCH /api/customer/notifications/preferences
 * Body: { emailEnabled?, telegramEnabled?, whatsappEnabled?, preferences? }
 * At most one secondary channel is active; enabling one disables the others.
 */
router.patch('/preferences', CustomerNotificationController.updatePreferences);

/** PATCH /api/customer/notifications/read-all */
router.patch('/read-all', CustomerNotificationController.markAllAsRead);

/** PATCH /api/customer/notifications/:id/read */
router.patch('/:id/read', CustomerNotificationController.markAsRead);

export default router;
