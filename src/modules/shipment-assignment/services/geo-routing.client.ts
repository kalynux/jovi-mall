import jwt from 'jsonwebtoken';
import { IGeoPoint } from '../../../core/types/geo.types';
import { ASSIGNMENT_CONFIG } from '../config/assignment.config';
import {
  TRACKING_INTEGRATION_CONFIG,
  trackingIntegrationEnabled,
} from '../../tracking-integration/config/tracking-integration.config';

/**
 * GeoRoutingClient — the jovi-mall → geo-tracker bridge for PROXIMITY RANKING.
 *
 * The auto-assignment requirement is explicit: once the eligible agents are
 * chosen, they (and the pickup) go to the "Geo Provider", which returns them
 * ordered nearest → farthest. geo-tracker already owns the road network and
 * exposes a pairwise distance/duration matrix (`POST /routing/matrix`); this
 * client calls it with the agent positions as the matrix SOURCES and the single
 * pickup as the one TARGET, then sorts by the returned road distance/duration.
 *
 * ── Off the critical path, by contract ──────────────────────────────────────
 *
 * geo-tracker must never be able to block a business action (the governing rule
 * in the workspace CLAUDE.md). So this client is best-effort: it returns `null`
 * on ANY problem — the integration being disabled (`GEO_TRACKER_BASE_URL`
 * unset), a timeout, a non-200, or an unparseable body — and the caller falls
 * back to the local haversine ordering it already computed. Auto-assignment
 * therefore still ranks by proximity when geo-tracker is down; it just uses
 * straight-line distance instead of road distance.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 *
 * geo-tracker's routing endpoints admit any authenticated jovi-mall caller and
 * verify an HS256 JWT signed with the SHARED `JWT_SECRET` (`{ userId, role }`).
 * We mint a short-lived (`GEO_SERVICE_TOKEN_TTL_SECONDS`) service token per call
 * rather than forward a user's token — there is no user on this path, and a
 * forwarded token could not be refreshed anyway.
 */

/** One agent + the position to rank it from. Coordinates are GeoJSON `[lng, lat]`. */
export interface GeoRankInput {
  agentId: string;
  position: IGeoPoint;
}

/** One ranked result. `distanceMeters`/`durationSeconds` are road-network values. */
export interface GeoRankResult {
  agentId: string;
  distanceMeters: number;
  durationSeconds: number;
}

/** geo-tracker's `MatrixCell` — Go field names, no json tags, so PascalCase. */
interface MatrixCell {
  DistanceMeters: number;
  DurationSeconds: number;
}

interface MatrixResponse {
  cells?: MatrixCell[][];
}

export class GeoRoutingClient {
  /** True when a geo-tracker endpoint is configured to answer routing calls. */
  isEnabled(): boolean {
    return trackingIntegrationEnabled();
  }

  /**
   * Rank `agents` by proximity to `pickup`, nearest first, using geo-tracker's
   * road-network matrix. Returns `null` when the provider is unavailable or the
   * response can't be used — the caller then keeps its local ordering.
   *
   * Ordering key: road DURATION first (time-to-pickup is what actually matters
   * for a dispatch), DISTANCE as the tie-break. A cell with a non-finite value
   * (no route found for that agent) sorts to the back rather than dropping the
   * agent — they remain a valid, if worse, candidate.
   */
  async rankByProximity(pickup: IGeoPoint, agents: GeoRankInput[]): Promise<GeoRankResult[] | null> {
    if (!this.isEnabled() || agents.length === 0) return null;
    if (!this.isValidPoint(pickup)) return null;

    const url = `${TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL}${ASSIGNMENT_CONFIG.GEO_MATRIX_PATH}`;
    const body = {
      sources: agents.map((a) => this.toCoordinate(a.position)),
      targets: [this.toCoordinate(pickup)],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASSIGNMENT_CONFIG.GEO_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.mintServiceToken()}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        console.warn(`[GeoRoutingClient] matrix call returned ${resp.status}; falling back to haversine`);
        return null;
      }
      const json = (await resp.json()) as MatrixResponse;
      return this.orderFromMatrix(agents, json);
    } catch (err) {
      // Timeout, network error, JSON error — all fall back, never throw upward.
      console.warn('[GeoRoutingClient] matrix call failed; falling back to haversine:', (err as Error)?.message ?? err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map the sources×[pickup] grid back onto agents and sort nearest-first. */
  private orderFromMatrix(agents: GeoRankInput[], json: MatrixResponse): GeoRankResult[] | null {
    const cells = json.cells;
    if (!Array.isArray(cells) || cells.length !== agents.length) return null;

    const results: GeoRankResult[] = agents.map((a, i) => {
      const cell = cells[i]?.[0];
      const distanceMeters = Number.isFinite(cell?.DistanceMeters) ? (cell as MatrixCell).DistanceMeters : Infinity;
      const durationSeconds = Number.isFinite(cell?.DurationSeconds) ? (cell as MatrixCell).DurationSeconds : Infinity;
      return { agentId: a.agentId, distanceMeters, durationSeconds };
    });

    results.sort(
      (a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters || a.agentId.localeCompare(b.agentId)
    );
    return results;
  }

  private toCoordinate(point: IGeoPoint): { latitude: number; longitude: number } {
    // IGeoPoint is GeoJSON `[lng, lat]`; geo.Coordinate is `{ latitude, longitude }`.
    const [lng, lat] = point.coordinates;
    return { latitude: lat, longitude: lng };
  }

  private isValidPoint(point: IGeoPoint | null | undefined): boolean {
    return !!point && Array.isArray(point.coordinates) && point.coordinates.length === 2;
  }

  private mintServiceToken(): string {
    const secret = process.env.JWT_SECRET || 'secret';
    return jwt.sign(
      { userId: ASSIGNMENT_CONFIG.GEO_SERVICE_TOKEN_SUBJECT, role: ASSIGNMENT_CONFIG.GEO_SERVICE_TOKEN_ROLE },
      secret,
      { expiresIn: ASSIGNMENT_CONFIG.GEO_SERVICE_TOKEN_TTL_SECONDS }
    );
  }
}

export const geoRoutingClient = new GeoRoutingClient();
