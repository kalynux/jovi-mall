import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { getGeocodingProvider, getGeocodingProviderType } from '../../../core/geocoding';
import { GeoSearchQuerySchema, GeoReverseQuerySchema } from '../validators/geo.validator';

/**
 * GeoController — the address-search HTTP surface.
 *
 * Backs the Google-Maps-style workflow: the client sends the free-form text a
 * user typed, gets ranked candidates, and later stores the one the user picks as
 * a GeoAddress (see `toGeoAddress`). Provider-agnostic: every candidate already
 * carries which `provider` resolved it, but the endpoints never branch on it.
 *
 * Errors (provider unavailable/failed, Zod validation) propagate to the global
 * error handler via asyncHandler — never written inline.
 */
export class GeoController {
    /**
     * GET /api/geo/search?q=<text>&limit=<n>&country=<cc,cc>&lang=<bcp47>
     * Returns candidate locations for free-form address text.
     */
    static search = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const { q, limit, country, lang } = GeoSearchQuerySchema.parse(req.query);
        const provider = getGeocodingProvider();
        const results = await provider.search(q, { limit, countryCodes: country, language: lang });
        res.json({
            success: true,
            data: { provider: getGeocodingProviderType(), query: q, results },
        });
    });

    /**
     * GET /api/geo/reverse?lat=<>&lng=<>
     * Returns the best-matching address for a coordinate, or null.
     */
    static reverse = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const { lat, lng } = GeoReverseQuerySchema.parse(req.query);
        const provider = getGeocodingProvider();
        const result = await provider.reverse(lat, lng);
        res.json({
            success: true,
            data: { provider: getGeocodingProviderType(), result },
        });
    });
}
