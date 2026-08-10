import { DeliveryChannel, NotificationType } from '../../notifications/models/vendor-notification.model';

/**
 * Vendor Notification List Item DTO
 * 
 * Lightweight notification for list views.
 */
export interface VendorNotificationListItemDTO {
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    isRead: boolean;
    deliveredVia: DeliveryChannel[];
    createdAt: string; // ISO 8601
}

/**
 * Vendor Notification Details DTO
 * 
 * Full notification details.
 */
export interface VendorNotificationDetailsDTO {
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    aggregateType: 'order' | 'booking' | 'payment' | 'storage' | 'connection' | 'payout';
    aggregateId: string;
    deliveredVia: DeliveryChannel[];
    isRead: boolean;
    readAt: string | null; // ISO 8601
    createdAt: string; // ISO 8601
}

/**
 * List Notifications Response DTO
 */
export interface ListNotificationsResponseDTO {
    success: true;
    data: VendorNotificationListItemDTO[];
    unreadCount: number;
    meta: {
        total: number;
        page: number;
        limit: number;
        pages: number;
    };
}

/**
 * Mark As Read Response DTO
 */
export interface MarkAsReadResponseDTO {
    success: true;
    data: VendorNotificationDetailsDTO;
    message: string;
}

/**
 * Mark All As Read Response DTO
 */
export interface MarkAllAsReadResponseDTO {
    success: true;
    data: {
        count: number;
    };
    message: string;
}

/**
 * Vendor Notification Preferences DTO
 */
export interface VendorNotificationPreferencesDTO {
    success: true;
    data: {
        inAppEnabled: boolean;
        emailEnabled: boolean;
        telegramEnabled: boolean;
        whatsappEnabled: boolean;
        emailVerified: boolean;
        telegramVerified: boolean;
        whatsappVerified: boolean;
        preferences: {
            orderCreated: boolean;
            orderCancelled: boolean;
            bookingCreated: boolean;
            bookingCancelled: boolean;
            paymentReceivedPartial: boolean;
            paymentReceivedFull: boolean;
            storageAlert: boolean;
            connectionUpdated: boolean;
            payoutUpdates: boolean;
            shipmentRejected: boolean;
            agencyStorageUpdates: boolean;
        };
    };
}
