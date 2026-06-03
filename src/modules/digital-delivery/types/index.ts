/**
 * Digital Delivery Type Definitions
 */

export interface GrantEntitlementDto {
  orderId: string;
  orderItemId: string;
  productId: string;
  variantId: string;
  assetId: string;
  customerId: string;
  vendorId: string;
  // Snapshotted from the variant at grant time. Null = unlimited / never expires.
  maxDownloads: number | null;
  expiresAfterDays: number | null;
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
  variantId: string;
  variantName?: string;
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
