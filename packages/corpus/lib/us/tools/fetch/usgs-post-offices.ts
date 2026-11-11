/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetches the post offices (feature code 78006) from the USGS National Map structures layer, the
 *   source of the `usgov-usgs-post-offices` adapter. US public domain under 17 U.S.C. § 105.
 *
 *   The layer is an ArcGIS MapServer layer that answers at most 2,000 features per request. The
 *   fetcher asks for the feature count first, pages the query by `resultOffset` in `OBJECTID` order,
 *   and refuses a pull whose feature count differs from the count the service stated. Each feature
 *   is written as one GeoJSON line with its ZIP Code as a string, leading zeros intact, normalized
 *   by `normalizeZIPCode` where the feature's state is known.
 *
 *   The service description is saved beside the features as `service.json`, because it holds the
 *   publisher's statement about the data ("public domain structures data") and its refresh date.
 *
 *   Invoke via `mailwoman corpus fetch usgs-post-offices`.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us/state"
import { normalizeZIPCode } from "@mailwoman/codex/us/zipcode"
import { APIClient } from "@mailwoman/core/api"
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
import { PathBuilder, type PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"
import {
	USGOV_USGS_POST_OFFICES_ADAPTER_ID,
	USGS_POST_OFFICES_FILENAME,
	type USGSPostOfficeFeature,
	type USGSPostOfficeProperties,
} from "#us/adapters/usgov/usgs-post-offices/adapter"

/**
 * The structures MapServer.
 *
 * Its description states the publisher's terms and refresh date.
 */
export const USGS_STRUCTURES_SERVICE_URL = "https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer"

/**
 * The query endpoint of layer 38, `Post Offices`.
 */
export const USGS_POST_OFFICES_QUERY_URL = `${USGS_STRUCTURES_SERVICE_URL}/38/query`

/**
 * The National Hydrography and Structures feature code for a post office.
 */
export const USGS_POST_OFFICE_FCODE = 78_006

/**
 * The service's `maxRecordCount`: the most features one query returns.
 */
export const USGS_POST_OFFICES_PAGE_SIZE = 2000

/**
 * The service fields the fetcher asks for, in the service's spelling.
 */
export const USGS_POST_OFFICE_FIELDS = ["PERMANENT_IDENTIFIER", "NAME", "ADDRESS", "CITY", "STATE", "ZIPCODE"] as const

/**
 * The file the service description is saved to, beside the features.
 */
export const USGS_STRUCTURES_SERVICE_FILENAME = "service.json"

const SLUG = USGOV_USGS_POST_OFFICES_ADAPTER_ID

const WHERE = `FCODE=${USGS_POST_OFFICE_FCODE}`

/**
 * What one run recorded.
 *
 * `publisher_version` is the service's `copyrightText`, which states its
 * refresh (`USGS TNM – National Structures Dataset. Data Refreshed October, 2026.`).
 */
export interface USGSPostOfficesManifest extends SourceManifest {
	service_url: string
	where: string
	feature_count: number
}

/**
 * The parts of the MapServer description a fetch records.
 */
interface StructuresService {
	copyrightText?: string
	serviceDescription?: string
}

/**
 * An ArcGIS REST error body.
 * The service sends it with HTTP status 200.
 */
interface ArcGISErrorBody {
	error?: { code?: number; message?: string; details?: unknown }
}

/**
 * Reads JSON from the service and throws on an ArcGIS error body.
 */
async function readServiceJSON<T>(client: Pick<APIClient, "fetch">, url: string, signal?: AbortSignal): Promise<T> {
	const { data } = await client.fetch<T & ArcGISErrorBody>({ url, timeout: 120_000, signal })

	if (data == null || typeof data !== "object") {
		throw new Error(`${SLUG}: ${url} answered a body that is not JSON: ${String(data).slice(0, 200)}`)
	}

	if (data.error) {
		throw new Error(`${SLUG}: ${url} answered an ArcGIS error ${data.error.code ?? ""}: ${data.error.message ?? ""}`)
	}

	return data
}

/**
 * The query URL for one request: a count, or one page from `offset`.
 */
export function postOfficesQueryURL(request: { countOnly: true } | { offset: number }): string {
	const params = new URLSearchParams({ where: WHERE })

	if ("countOnly" in request) {
		params.set("returnCountOnly", "true")
		params.set("f", "json")
	} else {
		params.set("outFields", USGS_POST_OFFICE_FIELDS.join(","))
		params.set("orderByFields", "OBJECTID")
		params.set("outSR", "4326")
		params.set("resultOffset", String(request.offset))
		params.set("resultRecordCount", String(USGS_POST_OFFICES_PAGE_SIZE))
		params.set("f", "geojson")
	}

	return `${USGS_POST_OFFICES_QUERY_URL}?${params}`
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
 * A feature's properties keyed by the lower-cased field name.
 *
 * The service answers GeoJSON with its own field spelling, so a reader looks names up case-insensitively.
 */
function lowerCasedProperties(properties: unknown): Record<string, unknown> {
	if (properties == null || typeof properties !== "object") return {}

	return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]))
}

/**
 * The ZIP Code fields for one post office.
 *
 * A known state passes the value through `normalizeZIPCode`, which restores leading zeros a numeric
 * value lost (`725` in Puerto Rico is `00725`) and reads a value that isn't a ZIP Code as `null`.
 * An unknown state keeps the trimmed value.
 *
 * The published value is kept beside the result whenever the two differ.
 */
export function postOfficeZIPCode(
	value: unknown,
	state: string | null
): Pick<USGSPostOfficeProperties, "zipcode" | "zipcode_published"> {
	const published = textField(value)

	if (!published) return { zipcode: null }

	const zipcode = state && isUSStateAbbreviation(state) ? normalizeZIPCode(published, state) : published

	return zipcode === published ? { zipcode } : { zipcode, zipcode_published: published }
}

/**
 * One service feature in the shape the adapter reads.
 *
 * @throws When the value isn't a GeoJSON feature.
 */
export function normalizePostOfficeFeature(value: unknown): USGSPostOfficeFeature {
	if (value == null || typeof value !== "object" || (value as { type?: unknown }).type !== "Feature") {
		throw new Error(`${SLUG}: expected a GeoJSON Feature, got ${String(stringifyJSON(value)).slice(0, 200)}`)
	}

	const feature = value as { geometry?: unknown; properties?: unknown }
	const properties = lowerCasedProperties(feature.properties)
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
			permanent_identifier: textField(properties["permanent_identifier"]),
			name: textField(properties["name"]),
			address: textField(properties["address"]),
			city: textField(properties["city"]),
			state,
			...postOfficeZIPCode(properties["zipcode"], state),
		},
	}
}

/**
 * Per-invocation options.
 */
export interface DownloadUSGSPostOfficesOptions {
	outputDir: PathBuilderLike
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Pages every post office into `<outputDir>/post-offices.geojsonl` and writes the manifest.
 *
 * The features are written to a staging file.
 * It moves into place only once the pull holds the feature count the service stated.
 * A failed run leaves the previous file as it was.
 *
 * @throws When the service answers an error, a page that isn't a FeatureCollection,
 * or a pull whose size differs from its count.
 */
export async function downloadUSGSPostOffices(
	client: Pick<APIClient, "fetch">,
	options: DownloadUSGSPostOfficesOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const featuresPath = destDir(USGS_POST_OFFICES_FILENAME)

	report?.(`=== ${SLUG} / ${USGS_POST_OFFICES_FILENAME}`)

	const service = await readServiceJSON<StructuresService>(client, `${USGS_STRUCTURES_SERVICE_URL}?f=json`, signal)
	const { count } = await readServiceJSON<{ count?: unknown }>(client, postOfficesQueryURL({ countOnly: true }), signal)

	if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
		throw new Error(`${SLUG}: the count query answered no feature count: ${stringifyJSON(count)}`)
	}

	report?.(`  ${service.copyrightText ?? "no copyrightText"}; ${count.toLocaleString()} post offices`)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(featuresPath)
	let written = 0

	try {
		while (written < count) {
			const url = postOfficesQueryURL({ offset: written })
			const page = await readServiceJSON<{ type?: unknown; features?: unknown }>(client, url, signal)

			if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
				throw new Error(`${SLUG}: ${url} answered something other than a FeatureCollection`)
			}

			if (!page.features.length) break

			const lines = page.features.map((feature) => stringifyJSON(normalizePostOfficeFeature(feature)))

			await appendLocalTextFile(`${lines.join("\n")}\n`, staging)
			written += lines.length

			report?.(`  ${written.toLocaleString()} / ${count.toLocaleString()}`)
		}

		if (written !== count) {
			throw new Error(`${SLUG}: the service counted ${count} post offices and the pull returned ${written}`)
		}

		if (!written) {
			// An empty pull writes no staging file, and an empty input is a valid one.
			await appendLocalTextFile("", staging)
		}

		await movePath(staging, featuresPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile(service as Record<string, unknown>, destDir(USGS_STRUCTURES_SERVICE_FILENAME))

	const sha256 = await sha256File(featuresPath)
	const { size: bytes } = await statPath(featuresPath)

	const manifest: USGSPostOfficesManifest = {
		source_url: USGS_POST_OFFICES_QUERY_URL,
		service_url: USGS_STRUCTURES_SERVICE_URL,
		where: WHERE,
		filename: USGS_POST_OFFICES_FILENAME,
		feature_count: written,
		bytes,
		sha256,
		...(service.copyrightText ? { publisher_version: service.copyrightText } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${written.toLocaleString()} features, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#us/adapters/usgov/usgs-post-offices/adapter` reads, given the root a fetch wrote under.
 */
export function usgsPostOfficesInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, USGS_POST_OFFICES_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchUSGSPostOfficesOptions extends BaseFetchOptions {
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchUSGSPostOffices(
	options: FetchUSGSPostOfficesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadUSGSPostOffices(client, {
		outputDir: options.outRoot(SLUG),
		signal: options.signal,
		report,
	})
}
