/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Nominatim engine contract + wire types the router delegates to. The RESOLVED-address →
 *   {@link NominatimResult} formatter (`toNominatimResult`, `toFeatureCollection`,
 *   `nominatimResultToSchemaOrg`) lives in `format.ts`.
 */

import type { OpenCageAnnotations } from "@mailwoman/annotations"

/**
 * Output serialization formats Nominatim supports. `jsonv2` is the modern default. `jsonld` is the Mailwoman extension
 * (#1052) — schema.org `Place` JSON-LD, not part of upstream Nominatim.
 */
export type NominatimFormat = "jsonv2" | "json" | "geojson" | "jsonld"

/**
 * The structured address breakdown returned under `address` when `addressdetails=1`. Keys mirror Nominatim's
 * OSM-derived tag names; populated from Mailwoman's `ComponentTag` / resolved ancestor lineage (mapping owned by
 * #804).
 */
export interface NominatimAddressDetails {
	house_number?: string
	road?: string
	neighbourhood?: string
	suburb?: string
	city?: string
	town?: string
	village?: string
	county?: string
	state?: string
	postcode?: string
	country?: string
	country_code?: string
	[key: string]: string | undefined
}

/** A single Nominatim result object (the shape geopy and friends parse). */
export interface NominatimResult {
	place_id: number | string
	licence: string
	osm_type?: string
	osm_id?: number | string
	lat: string
	lon: string
	display_name: string
	/** `[south, north, west, east]` as strings, per Nominatim. */
	boundingbox?: [string, string, string, string]
	class?: string
	type?: string
	importance?: number
	place_rank?: number
	address?: NominatimAddressDetails
	/** Present when `format=geojson` or `polygon_geojson=1`. */
	geojson?: unknown
	/** OpenCage-style enrichment block (timezone, coordinate formats, …); attached by the engine. */
	annotations?: OpenCageAnnotations
}

/** Parsed `/search` parameters (free-text OR structured; never both). */
export interface NominatimSearchParams {
	q?: string
	street?: string
	city?: string
	county?: string
	state?: string
	country?: string
	postalcode?: string
	countrycodes?: string[]
	limit: number
	viewbox?: [number, number, number, number]
	bounded?: boolean
	addressdetails?: boolean
	format: NominatimFormat
	acceptLanguage?: string
}

/** Parsed `/reverse` parameters. */
export interface NominatimReverseParams {
	lat: number
	lon: number
	zoom?: number
	addressdetails?: boolean
	format: NominatimFormat
	acceptLanguage?: string
}

/** Parsed `/lookup` parameters. */
export interface NominatimLookupParams {
	osmIds: string[]
	addressdetails?: boolean
	format: NominatimFormat
}

/** Nominatim `/status` payload. */
export interface NominatimStatus {
	status: number
	message: string
	data_updated?: string
}

/**
 * The geocoding engine the router delegates to. Each method is optional; a route whose method is not provided answers
 * `501 Not Implemented`. The real implementation (Mailwoman parse → resolve, plus `WOFReverseGeocoder`) is wired by the
 * CLI and fleshed out across #802–#805.
 */
export interface NominatimEngine {
	search?(params: NominatimSearchParams): Promise<NominatimResult[]>
	reverse?(params: NominatimReverseParams): Promise<NominatimResult | null>
	lookup?(params: NominatimLookupParams): Promise<NominatimResult[]>
	status?(): Promise<NominatimStatus>
}
