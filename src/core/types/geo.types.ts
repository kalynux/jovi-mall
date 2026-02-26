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
