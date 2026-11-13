// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches every point layer of the USGS National Map structures MapServer
 *   (`#us/structures/usgs/layers`), the source of the `usgov-usgs-structures` adapter.
 *   US public domain under 17 U.S.C. § 105.
 *
 *   Each layer is an ArcGIS MapServer layer that answers at most 2,000 features per request.
 *   The fetcher asks each layer for its feature count first, then pages it by `OBJECTID`:
 *   each page asks for the features whose `OBJECTID` exceeds the last one read, in `OBJECTID` order.
 *
 *   A `resultOffset` query slows as the offset grows (1.7 s for the first page of Cemeteries
 *   and 8.7 s at offset 184,000, against 0.8 s for the same page by `OBJECTID`).
 *   A pull whose feature count for any layer differs from the count the service stated is refused.
 *
 *   Each feature is written as one GeoJSON line carrying its layer id and slug,
 *   with its ZIP Code as a string, leading zeros intact, normalized by `normalizeZIPCode`
 *   where the feature's state is known.
 *
 *   The service description is saved beside the features as `service.json`, because it holds the
 *   publisher's statement about the data ("public domain structures data") and its refresh date.
 *
 *   Invoke via `mailwoman corpus fetch usgs-structures`.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us/state"
import { normalizeZIPCode } from "@mailwoman/codex/us/zipcode"
import { APIClient } from "@mailwoman/core/api"
import { assertNoArcGISError } from "@mailwoman/core/api/arcgis"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import {
	appendLocalTextFile,
	makeDirectories,
	movePath,
	removePathIfPresent,
	stagingSiblingPath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { isoDate } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"
import {
	USGOV_USGS_STRUCTURES_ADAPTER_ID,
	USGS_STRUCTURES_FILENAME,
	type USGSStructureFeature,
	type USGSStructureProperties,
} from "#us/adapters/usgov/usgs-structures/adapter"
import { USGS_STRUCTURE_LAYERS, type USGSStructureLayer } from "#us/structures/usgs/layers"

/**
 * The structures MapServer.
 *
 * Its description states the publisher's terms and refresh date.
 */
export const USGS_STRUCTURES_SERVICE_URL = "https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer"

/**
 * The service's `maxRecordCount`: the most features one query returns.
 */
export const USGS_STRUCTURES_PAGE_SIZE = 2000

/**
 * The service fields the fetcher asks for, in the service's spelling.
 */
export const USGS_STRUCTURE_FIELDS = [
	"OBJECTID",
	"PERMANENT_IDENTIFIER",
	"FCODE",
	"GNIS_ID",
	"NAME",
	"ADDRESSBUILDINGNAME",
	"ADDRESS",
	"CITY",
	"STATE",
	"ZIPCODE",
	"LOADDATE",
	"SOURCE_ORIGINATOR",
] as const

/**
 * The file the service description is saved to, beside the features.
 */
export const USGS_STRUCTURES_SERVICE_FILENAME = "service.json"

const SLUG = USGOV_USGS_STRUCTURES_ADAPTER_ID

/**
 * What one layer contributed to a run.
 */
export interface USGSStructuresLayerCount {
	layer_id: number
	layer: string
	name: string
	feature_count: number
}

/**
 * What one run recorded.
 *
 * `publisher_version` is the service's `copyrightText`, which states its
 * refresh (`USGS TNM – National Structures Dataset. Data Refreshed October, 2026.`).
 */
export interface USGSStructuresManifest extends SourceManifest {
	service_url: string
	feature_count: number
	layers: USGSStructuresLayerCount[]
}

/**
 * The parts of the MapServer description a fetch records.
 */
interface StructuresService {
	copyrightText?: string
	serviceDescription?: string
}

/**
 * Reads JSON from the service and throws on an ArcGIS error body.
 */
async function readServiceJSON<T>(client: Pick<APIClient, "fetch">, url: string, signal?: AbortSignal): Promise<T> {
	const { data } = await client.fetch<T>({ url, timeout: 120_000, signal })
	const body: unknown = data

	if (body == null || typeof body !== "object") {
		throw new Error(`${SLUG}: ${url} answered a body that is not JSON: ${String(body).slice(0, 200)}`)
	}

	assertNoArcGISError(body, `${SLUG}: ${url}`)

	return data
}

/**
 * The query URL for one request to `layerID`: a count, or one page of the features
 * whose `OBJECTID` exceeds `afterObjectID`.
 */
export function structuresQueryURL(layerID: number, request: { countOnly: true } | { afterObjectID: number }): string {
	const params = new URLSearchParams()

	if ("countOnly" in request) {
		params.set("where", "1=1")
		params.set("returnCountOnly", "true")
		params.set("f", "json")
	} else {
		params.set("where", `OBJECTID>${request.afterObjectID}`)
		params.set("outFields", USGS_STRUCTURE_FIELDS.join(","))
		params.set("orderByFields", "OBJECTID")
		params.set("outSR", "4326")
		params.set("resultRecordCount", String(USGS_STRUCTURES_PAGE_SIZE))
		params.set("f", "geojson")
	}

	return `${USGS_STRUCTURES_SERVICE_URL}/${layerID}/query?${params}`
}

/**
 * A text field as written: trimmed, or `null` when the service left it empty.
 */
function textField(value: unknown): string | null {
	if (value == null) return null
	const text = String(value).trim()

	return text || null
}

/**
 * An integer field, or `null` when the service left it empty or it isn't an integer.
 */
function integerField(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN

	return Number.isInteger(number) ? number : null
}

/**
 * A date field as an ISO 8601 date.
 * The service answers a date as epoch milliseconds.
 */
function dateField(value: unknown): string | null {
	const milliseconds = integerField(value)

	return milliseconds === null ? null : isoDate(new Date(milliseconds))
}

/**
 * A feature's properties keyed by the lower-cased field name.
 *
 * The service answers GeoJSON with its own field spelling, so a reader looks names up case-insensitively.
 */
function lowerCasedProperties(properties: unknown): Record<string, unknown> {
	if (properties == null || typeof properties !== "object") return {}

	return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]))
}

/**
 * The ZIP Code fields for one structure.
 *
 * A known state passes the value through `normalizeZIPCode`, which restores leading zeros a numeric
 * value lost (`725` in Puerto Rico is `00725`) and reads a value that isn't a ZIP Code as `null`.
 * An unknown state keeps the trimmed value.
 *
 * The published value is kept beside the result whenever the two differ.
 */
export function structureZIPCode(
	value: unknown,
	state: string | null
): Pick<USGSStructureProperties, "zipcode" | "zipcode_published"> {
	const published = textField(value)

	if (!published) return { zipcode: null }

	const zipcode = state && isUSStateAbbreviation(state) ? normalizeZIPCode(published, state) : published

	return zipcode === published ? { zipcode } : { zipcode, zipcode_published: published }
}

/**
 * One service feature of `layer` in the shape the adapter reads.
 *
 * @throws When the value isn't a GeoJSON feature, or has no `OBJECTID`.
 */
export function normalizeStructureFeature(
	value: unknown,
	layer: Pick<USGSStructureLayer, "layerID" | "slug">
): USGSStructureFeature {
	if (value == null || typeof value !== "object" || (value as { type?: unknown }).type !== "Feature") {
		throw new Error(`${SLUG}: expected a GeoJSON Feature, got ${String(stringifyJSON(value)).slice(0, 200)}`)
	}

	const feature = value as { geometry?: unknown; properties?: unknown }
	const properties = lowerCasedProperties(feature.properties)
	const objectid = integerField(properties["objectid"])

	if (objectid === null) {
		throw new Error(`${SLUG}: layer ${layer.layerID} answered a feature with no OBJECTID`)
	}

	const state = textField(properties["state"])?.toUpperCase() ?? null

	const geometry = (feature.geometry ?? {}) as { type?: unknown; coordinates?: unknown }
	const coordinates: number[] = Array.isArray(geometry.coordinates) ? geometry.coordinates.map(Number) : []

	const point =
		geometry.type === "Point" &&
		coordinates.length >= 2 &&
		coordinates.every((coordinate) => Number.isFinite(coordinate))
			? { type: "Point" as const, coordinates: [coordinates[0]!, coordinates[1]!] as [number, number] }
			: null

	return {
		type: "Feature",
		geometry: point,
		properties: {
			layer_id: layer.layerID,
			layer: layer.slug,
			objectid,
			permanent_identifier: textField(properties["permanent_identifier"]),
			fcode: integerField(properties["fcode"]),
			gnis_id: textField(properties["gnis_id"]),
			name: textField(properties["name"]),
			addressbuildingname: textField(properties["addressbuildingname"]),
			address: textField(properties["address"]),
			city: textField(properties["city"]),
			state,
			...structureZIPCode(properties["zipcode"], state),
			loaddate: dateField(properties["loaddate"]),
			source_originator: textField(properties["source_originator"]),
		},
	}
}

/**
 * Per-invocation options.
 */
export interface DownloadUSGSStructuresOptions {
	outputDir: PathBuilderLike
	/**
	 * The layers to pull.
	 *
	 * @defaultValue {@linkcode USGS_STRUCTURE_LAYERS}
	 */
	layers?: readonly USGSStructureLayer[]
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Pages every feature of one layer into `staging`, and returns the number written.
 *
 * @throws When the service answers an error, a page that isn't a FeatureCollection,
 * a page whose `OBJECTID`s don't advance, or a pull whose size differs from its count.
 */
async function pullLayer(
	client: Pick<APIClient, "fetch">,
	layer: USGSStructureLayer,
	staging: PathBuilderLike,
	options: Pick<DownloadUSGSStructuresOptions, "signal" | "report">
): Promise<number> {
	const { signal, report } = options
	const countURL = structuresQueryURL(layer.layerID, { countOnly: true })
	const { count } = await readServiceJSON<{ count?: unknown }>(client, countURL, signal)

	if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
		throw new Error(
			`${SLUG}: the count query of layer ${layer.layerID} answered no feature count: ${stringifyJSON(count)}`
		)
	}

	report?.(`  ${layer.layerID} ${layer.name}: ${count.toLocaleString()} features`)

	let written = 0
	let afterObjectID = 0

	while (written < count) {
		const url = structuresQueryURL(layer.layerID, { afterObjectID })
		const page = await readServiceJSON<{ type?: unknown; features?: unknown }>(client, url, signal)

		if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
			throw new Error(`${SLUG}: ${url} answered something other than a FeatureCollection`)
		}

		if (!page.features.length) break

		const features = page.features.map((feature) => normalizeStructureFeature(feature, layer))
		const lastObjectID = features.at(-1)!.properties.objectid

		if (lastObjectID <= afterObjectID) {
			throw new Error(`${SLUG}: ${url} answered a page whose OBJECTIDs don't advance past ${afterObjectID}`)
		}

		await appendLocalTextFile(`${features.map((feature) => stringifyJSON(feature)).join("\n")}\n`, staging)

		written += features.length
		afterObjectID = lastObjectID

		report?.(`    ${written.toLocaleString()} / ${count.toLocaleString()}`)
	}

	if (written !== count) {
		throw new Error(
			`${SLUG}: the service counted ${count} features in layer ${layer.layerID} and the pull returned ${written}`
		)
	}

	return written
}

/**
 * Pages every layer into `<outputDir>/structures.geojsonl` and writes the manifest.
 *
 * The features are written to a staging file.
 * It moves into place only once every layer's pull holds the feature count the service stated.
 * A failed run leaves the previous file as it was.
 *
 * @throws When the service answers an error, a page that isn't a FeatureCollection,
 * or a layer pull whose size differs from its count.
 */
export async function downloadUSGSStructures(
	client: Pick<APIClient, "fetch">,
	options: DownloadUSGSStructuresOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const layers = options.layers ?? USGS_STRUCTURE_LAYERS
	const destDir = PathBuilder.from(options.outputDir)
	const featuresPath = destDir(USGS_STRUCTURES_FILENAME)

	report?.(`=== ${SLUG} / ${USGS_STRUCTURES_FILENAME}`)

	const service = await readServiceJSON<StructuresService>(client, `${USGS_STRUCTURES_SERVICE_URL}?f=json`, signal)

	report?.(`  ${service.copyrightText ?? "no copyrightText"}; ${layers.length} layers`)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(featuresPath)
	const counts: USGSStructuresLayerCount[] = []

	try {
		// An empty pull writes no page, and an empty input is a valid one.
		await appendLocalTextFile("", staging)

		for (const layer of layers) {
			const written = await pullLayer(client, layer, staging, { signal, report })

			counts.push({ layer_id: layer.layerID, layer: layer.slug, name: layer.name, feature_count: written })
		}

		await movePath(staging, featuresPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile(service as Record<string, unknown>, destDir(USGS_STRUCTURES_SERVICE_FILENAME))

	const sha256 = await sha256File(featuresPath)
	const { size: bytes } = await statPath(featuresPath)
	const total = counts.reduce((sum, layer) => sum + layer.feature_count, 0)

	const manifest: USGSStructuresManifest = {
		source_url: USGS_STRUCTURES_SERVICE_URL,
		service_url: USGS_STRUCTURES_SERVICE_URL,
		filename: USGS_STRUCTURES_FILENAME,
		feature_count: total,
		layers: counts,
		bytes,
		sha256,
		...(service.copyrightText ? { publisher_version: service.copyrightText } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${total.toLocaleString()} features, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#us/adapters/usgov/usgs-structures/adapter` reads, given the root a fetch wrote under.
 */
export function usgsStructuresInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, USGS_STRUCTURES_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchUSGSStructuresOptions extends BaseFetchOptions {
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchUSGSStructures(
	options: FetchUSGSStructuresOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	// One request at a time with a pause between them: a full pull is about 270 requests to a public service.
	await using client = new APIClient({ displayName: SLUG, retry: true, minRequestIntervalMs: 500 })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadUSGSStructures(client, {
		outputDir: options.outRoot(SLUG),
		signal: options.signal,
		report,
	})
}
