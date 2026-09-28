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
 * Whether an artifact could state its own provenance.
 *
 * `unreadable` is kept apart from `absent` because "we could not open it" is a
 * fault to chase rather than a rebuild to schedule.
 */
export type NominatimManifestState = "present" | "absent" | "unreadable"

/**
 * One database this deployment is serving from, and what it says about itself.
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
	reason?: string
	/**
	 * When the artifact was built, as its own manifest records it.
	 */
	built?: string
	/**
	 * `<layer name>@<layer version>`, the artifact's identity.
	 */
	version?: string
	/**
	 * What it was built from: the manifest's source, then its source vintage.
	 */
	sources?: string[]
	/**
	 * The SPDX expression this artifact's own manifest records, verbatim.
	 *
	 * Left out when the row holds none.
	 * An absent expression states that nobody recorded the obligations rather than that the
	 * artifact carries none, so a client must not read its absence as permissive.
	 */
	license?: string
	/**
	 * The credit line the publisher's terms ask for, as this artifact's own manifest records it.
	 */
	attribution?: string
}

/**
 * The native provenance block.
 *
 * A Nominatim client ignores unknown keys, so this rides alongside the compatible
 * `data_updated` without breaking one.
 */
export interface NominatimStatusExtension {
	/**
	 * Every artifact this process opened, including the ones that carry no manifest.
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
	 * Left out when none of them carries a manifest.
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
	dataUpdated?: string
	artifacts: NominatimStatusArtifact[]
}

/**
 * Compose the `/status` payload from a freshness report.
 *
 * A function rather than four lines at the one call site, because the CLI and the test
 * that checks this response would otherwise hold separate copies of the same mapping,
 * and the field this mapping exists to get right is omitted under a condition.
 *
 * `data_updated` is dropped when no artifact carried a build date,
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
