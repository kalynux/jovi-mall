import { IGeoPoint } from '../types/geo.types';

/**
 * Great-circle distance in km between two GeoJSON points ([lng, lat]).
 *
 * Lives in core rather than in a feature module because more than one module
 * needs it (assignment proximity ranking; the agent's straight-line route
 * fallback) and it depends on nothing — importing it must never drag a service
 * graph along, which is how require cycles get created in this codebase.
 */
export function haversineKm(a: IGeoPoint, b: IGeoPoint): number {
  const [lng1, lat1] = a.coordinates;
  const [lng2, lat2] = b.coordinates;
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
