import { Schema } from 'mongoose';
import { z } from 'zod';

// ─── Mongoose Sub-Schemas ────────────────────────────────────────────────────

/**
 * GeoJSON Point sub-schema for Mongoose.
 *
 * Use this embedded schema wherever a single lat/lng location is stored.
 * Pair with a `2dsphere` index on the parent field for geospatial queries.
 *
 * @example
 *   location: { type: GeoPointSchema, index: '2dsphere' }
 *
 * ── ⚠ INSIDE AN ARRAY, EMBED IT WITH `default: undefined` ────────────────────
 *
 * `default: null` on a point sitting under a 2dsphere-indexed ARRAY path is a
 * write-blocking bug that looks like nothing. MongoDB extracts index keys for the
 * WHOLE array: the moment one element carries a real point and another carries an
 * explicit `null`, key extraction fails and the write is refused —
 *
 *   Can't extract geo keys: {...} geo element must be an array or object: location: null
 *
 * And it is not only the write that touched the address: it is EVERY write to that
 * document, whatever it touches, plus the index build itself. Measured against
 * MongoDB on 2026-08-23 on `customers.saved_addresses[].location`, where it made
 * "add a second delivery address" impossible for any customer whose first one was
 * geocoded.
 *
 * An ABSENT key is fine — MongoDB emits no key for that element and indexes the
 * rest. So the leaf must never be *stored* as null:
 *
 *   location: { type: GeoPointSchema, default: undefined }   // ✅ key omitted
 *   location: { type: GeoPointSchema, default: null }        // ❌ breaks the document
 *
 * `sparse` and `partialFilterExpression` do NOT rescue this, and that is worth
 * knowing before reaching for either: both select DOCUMENTS, and this document
 * legitimately holds a point, so it is selected and then fails on the null sibling
 * regardless. Both were measured; both still fail.
 *
 * A nested `GeoAddress` is immune — its `coordinates` is `required`, so `geo: null`
 * puts the null one level ABOVE the indexed leaf and the path is simply absent.
 * Only the bare legacy `location` field has this shape.
 */
export const GeoPointSchema = new Schema(
    {
        type: {
            type: String,
            enum: ['Point'],
            required: true,
            default: 'Point',
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: true,
        },
    },
    { _id: false }
);

/**
 * GeoJSON Polygon sub-schema for Mongoose.
 *
 * Use wherever a coverage/service-area polygon is stored.
 * Pair with a `2dsphere` index on the parent field.
 *
 * @example
 *   coverage_area: { type: PolygonSchema, index: '2dsphere' }
 */
export const PolygonSchema = new Schema(
    {
        type: {
            type: String,
            enum: ['Polygon'],
            required: true,
            default: 'Polygon',
        },
        coordinates: {
            type: [[[Number]]], // Array of rings, each a [lng, lat] pair array
            required: true,
        },
    },
    { _id: false }
);

// ─── TypeScript Interfaces ───────────────────────────────────────────────────

export interface IGeoPoint {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
}

export interface IPolygon {
    type: 'Polygon';
    coordinates: number[][][]; // First ring = outer boundary
}

// ─── Zod Validators ─────────────────────────────────────────────────────────

/**
 * Validates a GeoJSON Point input from API requests.
 */
export const GeoPointZodSchema = z.object({
    type: z.literal('Point'),
    coordinates: z
        .tuple([
            z.number().min(-180).max(180), // longitude
            z.number().min(-90).max(90),   // latitude
        ])
        .describe('GeoJSON coordinates: [longitude, latitude]'),
});

/**
 * Validates a GeoJSON Polygon input from API requests.
 * Each ring must have at least 4 positions, and the first = last (closed ring).
 */
export const PolygonZodSchema = z.object({
    type: z.literal('Polygon'),
    coordinates: z
        .array(
            z.array(z.tuple([z.number(), z.number()])).min(4) // minimum 4 to form a closed ring
        )
        .min(1, 'At least one ring (outer boundary) is required'),
});

export type GeoPointInput = z.infer<typeof GeoPointZodSchema>;
export type PolygonInput = z.infer<typeof PolygonZodSchema>;
