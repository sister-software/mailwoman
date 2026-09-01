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
export type NominatimAddressDetails = Record<string, string>

/**
 * A single Nominatim result object (the shape geopy and friends parse).
 */
export interface NominatimResult {
	place_id: number | string
	licence: string
	osm_type?: string
	osm_id?: number | string
	lat: string
	lon: string
	display_name: string
	/**
	 * `[south, north, west, east]` as strings, per Nominatim.
	 */
	boundingbox?: [string, string, string, string]
	class?: string
	type?: string
	importance?: number
	place_rank?: number
	address?: NominatimAddressDetails
	/**
	 * Present when `format=geojson` or `polygon_geojson=1`.
	 */
	geojson?: unknown
	/**
	 * OpenCage-style enrichment block (timezone, coordinate formats, …); attached by the engine.
	 */
	annotations?: OpenCageAnnotations
}

/**
 * Parsed `/search` parameters (free-text OR structured; never both).
 */
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

/**
 * Parsed `/reverse` parameters.
 */
export interface NominatimReverseParams {
	lat: number
	lon: number
	zoom?: number
	addressdetails?: boolean
	format: NominatimFormat
	acceptLanguage?: string
}

/**
 * Parsed `/lookup` parameters.
 */
export interface NominatimLookupParams {
	osmIDs: string[]
	addressdetails?: boolean
	format: NominatimFormat
}

/**
 * Whether an artifact could state its own provenance. `unreadable` is kept apart from `absent` because "we could not
 * open it" is a fault to chase, not a rebuild to schedule.
 */
export type NominatimManifestState = "present" | "absent" | "unreadable"

/**
 * One database this deployment is serving from, and what it says about itself.
 *
 * Modeled here rather than imported from `mailwoman/freshness`, matching this package's convention that a wire surface
 * owns its own doc-accuracy types. The CLI assigns the reader's report straight into this shape, so a drift between the
 * two is a compile error at that assignment rather than a silently different response body.
 */
export interface NominatimStatusArtifact {
	/**
	 * The role this artifact plays for the running process (`gazetteer`, `reverse-admin`).
	 */
	name: string
	path: string
	manifest: NominatimManifestState
	/**
	 * Why the manifest is absent or unreadable.
	 */
	reason?: string
	/**
	 * When the artifact was BUILT, as its own manifest records it.
	 */
	built?: string
	/**
	 * `<layer name>@<layer version>` — the artifact's identity.
	 */
	version?: string
	/**
	 * What it was built FROM: the manifest's source, then its source vintage.
	 */
	sources?: string[]
}

/**
 * The native provenance block. A Nominatim client ignores unknown keys, so this rides alongside the compatible
 * `data_updated` without breaking one.
 */
export interface NominatimStatusExtension {
	/**
	 * Every artifact this process opened, INCLUDING the ones that carry no manifest — an unstamped artifact reports its
	 * own absence rather than being omitted, because an omission cannot be told apart from an artifact nobody opened.
	 */
	artifacts: NominatimStatusArtifact[]
}

/**
 * Nominatim `/status` payload.
 */
export interface NominatimStatus {
	status: number
	message: string
	/**
	 * The newest build epoch across the artifacts this deployment opened. Left OUT when none of them carries a manifest —
	 * never filled with a boot time or a file mtime, which would answer a question the process cannot answer.
	 */
	data_updated?: string
	mailwoman?: NominatimStatusExtension
}

/**
 * A freshness report as this surface consumes it — structurally `mailwoman/freshness`'s `FreshnessReport`, declared
 * here so the wire contract keeps no import from the engine implementation.
 */
export interface NominatimFreshnessReport {
	dataUpdated?: string
	artifacts: NominatimStatusArtifact[]
}

/**
 * Compose the `/status` payload from a freshness report.
 *
 * A FUNCTION rather than four lines at the one call site, because the CLI and the test that checks this response would
 * otherwise each hold their own copy of the same mapping — and the field this mapping exists to get right is one that
 * is OMITTED under a condition, which is exactly what two copies stop agreeing about first.
 *
 * `data_updated` is dropped when no artifact carried a build date. Nominatim declares the field optional, so leaving it
 * out is the contract's own way of saying the deployment cannot date its data; filling it with a boot time or a file
 * mtime would answer with something that looks measured and is not.
 */
export function nominatimStatus(freshness: NominatimFreshnessReport): NominatimStatus {
	return {
		status: 0,
		message: "OK",
		...(freshness.dataUpdated ? { data_updated: freshness.dataUpdated } : {}),
		mailwoman: { artifacts: freshness.artifacts },
	}
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
