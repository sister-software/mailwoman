/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The application's data shapes — the messy record that goes in, and the canonical entity that
 *   comes out. Plain interfaces over the `@mailwoman/record` types.
 */

import type { OrganizationName, PersonName, PostalAddress } from "@mailwoman/record"

/** A single source record: one row of a messy contact/organization dataset, after normalization. */
export interface SourceRecord {
	/** Stable identifier within the input (row id, primary key…). */
	id: string
	/** Provenance: which file / dataset this came from. */
	source?: string | null
	/** Parsed person name, when the record is a contact. */
	name?: PersonName | null
	/** Canonicalized organization name, when the record is an org. */
	organization?: OrganizationName | null
	/** The address, normalized + (ideally) geocoded. */
	address?: PostalAddress | null
	phone?: string | null
	email?: string | null
	/** The original row, verbatim, for audit. */
	raw?: Record<string, string>
}

/** A resolved canonical entity: a cluster of source records judged to be the same real-world thing. */
export interface ResolvedEntity {
	/** Identifier assigned to the entity. */
	id: string
	/** The source records that resolved to this entity. */
	records: SourceRecord[]
	/** The most complete record, used as the entity's canonical face. */
	representative: SourceRecord
	/** The entity's location, from the representative's geocode. */
	coordinate?: { latitude: number; longitude: number }
	/** Weakest within-cluster link weight in bits (how tightly it holds together); `null` for a
singleton. */
	cohesion: number | null
}

//#region Minimal GeoJSON (Point features) — no external dependency.

export interface GeoJsonPoint {
	type: "Point"
	/** `[longitude, latitude]`, per the GeoJSON spec. */
	coordinates: [number, number]
}

export interface GeoJsonFeature {
	type: "Feature"
	geometry: GeoJsonPoint
	properties: Record<string, unknown>
}

export interface GeoJsonFeatureCollection {
	type: "FeatureCollection"
	features: GeoJsonFeature[]
}

//#endregion
