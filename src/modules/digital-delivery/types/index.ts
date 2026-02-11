/**
 * Digital Delivery Type Definitions
 */

export interface GrantEntitlementDto {
  orderId: string;
  orderItemId: string;
  productId: string;
  assetId: string;
  customerId: string;
  vendorId: string;
}

export interface CreateDownloadLinkDto {
  entitlementId: string;
  customerId: string;
}

export interface DownloadLinkResult {
  url: string;
  expiresAt: Date;
  downloadsRemaining: number | null; // null = unlimited
}

export interface EntitlementSummary {
  id: string;
  productId: string;
  productTitle?: string;
  assetId: string;
  originalName: string;
  downloadsUsed: number;
  maxDownloads: number | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  isExpired: boolean;
  isRevoked: boolean;
  canDownload: boolean;
}
