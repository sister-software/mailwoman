/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Nominatim engine interface + wire types the router delegates to. The resolved-address →
 *   {@link NominatimResult} formatter (`toNominatimResult`, `toFeatureCollection`,
 *   `nominatimResultToSchemaOrg`) lives in `format.ts`.
 */

import type { OpenCageAnnotations } from "@mailwoman/annotations"

/**
 * Output serialization formats Nominatim supports.
 *
 * `jsonv2` is the modern default and `jsonld` is the Mailwoman extension that emits
 * schema.org `Place` JSON-LD rather than an upstream Nominatim format.
 */
export type NominatimFormat = "jsonv2" | "json" | "geojson" | "jsonld"

/**
 * The structured address breakdown returned under `address` when `addressdetails=1`.
 *
 * Keys mirror Nominatim's OSM-derived tag names, populated from Mailwoman's
 * `ComponentTag` and resolved ancestor lineage.
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
	 * OpenCage-style enrichment block (timezone, coordinate formats, …), attached by the engine.
	 */
	annotations?: OpenCageAnnotations
}

/**
 * Parsed `/search` parameters (free-text or structured. Never both).
 */
export interface NominatimSearchParams {
	q?: string | null
	street?: string | null
	city?: string | null
	county?: string | null
	state?: string | null
	country?: string | null
	postalcode?: string | null
	countrycodes?: string[] | null
	limit: number
	viewbox?: [number, number, number, number] | null
	bounded?: boolean | null
	addressdetails?: boolean | null
	format: NominatimFormat
	acceptLanguage?: string | null
}

/**
 * Parsed `/reverse` parameters.
 */
export interface NominatimReverseParams {
	lat: number
	lon: number
	zoom?: number | null
	addressdetails?: boolean | null
	format: NominatimFormat
	acceptLanguage?: string | null
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
 * Whether an artifact could state its own provenance.
 *
 * `unreadable` is kept apart from `absent` because "we could not open it" is a
 * fault to chase rather than a rebuild to schedule.
 */
export type NominatimManifestState = "present" | "absent" | "unreadable"

/**
 * One database this deployment serves and its self-reported metadata.
 *
 * The wire surface owns its own doc-accuracy types, so the CLI assigns the reader's report
 * straight into this shape and a drift is a compile error rather than a different response body.
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
	reason: string | null
	/**
	 * When the artifact was built, as its own manifest records it.
	 */
	built: string | null
	/**
	 * `<layer name>@<layer version>`, the artifact's identity.
	 */
	version: string | null
	/**
	 * What it was built from: the manifest's source, then its source vintage.
	 */
	sources: string[] | null
	/**
	 * The SPDX expression this artifact's own manifest records, verbatim.
	 *
	 * Null when the row holds none.
	 * A null expression states that the build did not record the obligations.
	 *
	 * The artifact may still contain a manifest, so a client must not read a null as permissive.
	 */
	license: string | null
	/**
	 * The credit line the publisher's terms ask for, as this artifact's own manifest records it.
	 */
	attribution: string | null
}

/**
 * The native provenance block.
 *
 * A Nominatim client ignores unknown keys, so this appears beside the compatible
 * `data_updated` without breaking one.
 */
export interface NominatimStatusExtension {
	/**
	 * Every artifact this process opened, including those with no manifest.
	 *
	 * An unstamped artifact reports its own absence rather than being omitted,
	 * because an omission cannot be told apart from an unopened artifact.
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
	 * The newest build epoch across the artifacts this deployment opened.
	 *
	 * Left out when none of them has a manifest.
	 * A boot time or a file mtime would answer a question the process cannot answer.
	 */
	data_updated?: string
	mailwoman?: NominatimStatusExtension
}

/**
 * A freshness report as this surface consumes it, structurally `mailwoman/freshness`'s `FreshnessReport`
 * and declared here so the wire interface keeps no import from the engine implementation.
 */
export interface NominatimFreshnessReport {
	dataUpdated: string | null
	artifacts: NominatimStatusArtifact[]
}

/**
 * Compose the `/status` payload from a freshness report.
 *
 * A function prevents the CLI and response test from holding separate copies of the mapping.
 * The mapped field is omitted under a condition, so both callers need the same logic.
 *
 * `data_updated` is dropped when no artifact recorded a build date,
 * since Nominatim declares the field optional.
 * A boot time or a file mtime would look measured and answer a question the process cannot.
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
 * The geocoding engine the router delegates to.
 *
 * Each method is optional and a route whose method is absent answers `501 Not Implemented`.
 * The real implementation is wired by the CLI.
 */
export interface NominatimEngine {
	search?(params: NominatimSearchParams): Promise<NominatimResult[]>
	reverse?(params: NominatimReverseParams): Promise<NominatimResult | null>
	lookup?(params: NominatimLookupParams): Promise<NominatimResult[]>
	status?(): Promise<NominatimStatus>
}
