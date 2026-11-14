// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches the Populated Places layer of the USGS National Map geonames MapServer: the Geographic
 *   Names Information System's populated places, one per GNIS id, in every state and territory.
 *
 *   A work of the United States Government, public domain under 17 U.S.C. § 105.
 *
 *   The layer answers at most 2,000 features per request, and `pageArcGISLayer` pages it by `OBJECTID`.
 *   Each place is written as one JSON line: its GNIS id, name, feature class, state, county and point.
 *
 *   The layer stores a place's point as a one-point multipoint, and the fetcher writes that point.
 *
 *   The service description is saved beside the places as `service.json`.
 *   Its `copyrightText` states the publisher's refresh date.
 *
 *   Invoke via `mailwoman corpus fetch usgs-gnis`.
 */

import { APIClient } from "@mailwoman/core/api"
import { pageArcGISLayer, readArcGISJSON } from "@mailwoman/core/api/arcgis"
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

/**
 * The directory a fetch writes under, below the fetch root.
 */
export const USGS_GNIS_SLUG = "usgov-usgs-gnis"

/**
 * The geonames MapServer.
 */
export const USGS_GNIS_SERVICE_URL = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer"

/**
 * The Populated Places layer of {@link USGS_GNIS_SERVICE_URL}.
 */
export const USGS_GNIS_POPULATED_PLACES_LAYER = 3

/**
 * The service's `maxRecordCount`: the most features one query returns.
 */
export const USGS_GNIS_PAGE_SIZE = 2000

/**
 * The layer fields the fetcher asks for, in the service's spelling.
 */
export const USGS_GNIS_FIELDS = [
	"OBJECTID",
	"gaz_id",
	"gaz_name",
	"gaz_featureclass",
	"fcode",
	"state_alpha",
	"county_name",
	"incounty_id",
	"isunknowncoords",
] as const

/**
 * The file the places are written to.
 */
export const USGS_GNIS_PLACES_FILENAME = "populated-places.jsonl"

/**
 * The file the service description is saved to, beside the places.
 */
export const USGS_GNIS_SERVICE_FILENAME = "service.json"

/**
 * One GNIS populated place as the fetch writes it.
 */
export interface GNISPopulatedPlace {
	gnisID: number
	name: string
	featureClass: string | null
	fcode: number | null
	/**
	 * The USPS state or territory code.
	 */
	state: string | null
	county: string | null
	/**
	 * The GNIS id of the county the place lies in.
	 */
	countyGNISID: number | null
	/**
	 * Whether GNIS marks the place's coordinates as unknown.
	 */
	unknownCoordinates: boolean
	longitude: number | null
	latitude: number | null
}

/**
 * What one run recorded.
 *
 * `publisher_version` is the service's `copyrightText`, which states its refresh.
 */
export interface USGSGNISManifest extends SourceManifest {
	service_url: string
	layer_id: number
	feature_count: number
}

function textField(value: unknown): string | null {
	if (value == null) return null
	const text = String(value).trim()

	return text || null
}

function integerField(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN

	return Number.isInteger(number) ? number : null
}

/**
 * The first point of a GeoJSON Point or MultiPoint geometry, or `null` when it has none.
 */
function firstPoint(geometry: unknown): [number, number] | null {
	const { type, coordinates } = (geometry ?? {}) as { type?: unknown; coordinates?: unknown }
	const point = type === "MultiPoint" && Array.isArray(coordinates) ? coordinates[0] : coordinates

	if (type !== "Point" && type !== "MultiPoint") return null

	if (!Array.isArray(point) || point.length < 2) return null

	const [longitude, latitude] = point.map(Number)

	return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude!, latitude!] : null
}

/**
 * One service feature as a {@link GNISPopulatedPlace}.
 *
 * @throws When the value isn't a GeoJSON feature, or has no GNIS id or name.
 */
export function normalizeGNISFeature(value: unknown): GNISPopulatedPlace {
	if (value == null || typeof value !== "object" || (value as { type?: unknown }).type !== "Feature") {
		throw new Error(`${USGS_GNIS_SLUG}: expected a GeoJSON Feature, got ${String(stringifyJSON(value)).slice(0, 200)}`)
	}

	const feature = value as { geometry?: unknown; properties?: unknown }

	const properties = Object.fromEntries(
		Object.entries((feature.properties ?? {}) as Record<string, unknown>).map(([key, field]) => [
			key.toLowerCase(),
			field,
		])
	)

	const gnisID = integerField(properties["gaz_id"])
	const name = textField(properties["gaz_name"])

	if (gnisID === null || !name) {
		throw new Error(`${USGS_GNIS_SLUG}: a feature has no GNIS id or name: ${String(stringifyJSON(properties))}`)
	}

	const point = firstPoint(feature.geometry)

	return {
		gnisID,
		name,
		featureClass: textField(properties["gaz_featureclass"]),
		fcode: integerField(properties["fcode"]),
		state: textField(properties["state_alpha"])?.toUpperCase() ?? null,
		county: textField(properties["county_name"]),
		countyGNISID: integerField(properties["incounty_id"]),
		unknownCoordinates: integerField(properties["isunknowncoords"]) === 1,
		longitude: point?.[0] ?? null,
		latitude: point?.[1] ?? null,
	}
}

/**
 * Per-invocation options.
 */
export interface DownloadUSGSGNISOptions {
	outputDir: PathBuilderLike
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Pages the Populated Places layer into `<outputDir>/populated-places.jsonl` and writes the manifest.
 *
 * The places are written to a staging file.
 * The file moves into place only once the pull holds the feature count the service stated.
 * A failed run leaves the previous file as it was.
 */
export async function downloadUSGSGNIS(
	client: Pick<APIClient, "fetch">,
	options: DownloadUSGSGNISOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const placesPath = destDir(USGS_GNIS_PLACES_FILENAME)

	report?.(`=== ${USGS_GNIS_SLUG} / ${USGS_GNIS_PLACES_FILENAME}`)

	const service = await readArcGISJSON<{ copyrightText?: string }>(
		client,
		`${USGS_GNIS_SERVICE_URL}?f=json`,
		USGS_GNIS_SLUG,
		signal
	)

	report?.(`  ${service.copyrightText ?? "no copyrightText"}`)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(placesPath)
	let written = 0

	try {
		await appendLocalTextFile("", staging)

		const pages = pageArcGISLayer(
			client,
			{ serviceURL: USGS_GNIS_SERVICE_URL, layerID: USGS_GNIS_POPULATED_PLACES_LAYER },
			{
				outFields: USGS_GNIS_FIELDS,
				pageSize: USGS_GNIS_PAGE_SIZE,
				context: USGS_GNIS_SLUG,
				signal,
				onCount: (count) => report?.(`  Populated Places: ${count.toLocaleString()} features`),
				onPage: (done, count) => report?.(`    ${done.toLocaleString()} / ${count.toLocaleString()}`),
			}
		)

		for await (const page of pages) {
			const places = page.map(normalizeGNISFeature)

			await appendLocalTextFile(`${places.map((place) => stringifyJSON(place)).join("\n")}\n`, staging)
			written += places.length
		}

		await movePath(staging, placesPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile(service as Record<string, unknown>, destDir(USGS_GNIS_SERVICE_FILENAME))

	const sha256 = await sha256File(placesPath)
	const { size: bytes } = await statPath(placesPath)

	const manifest: USGSGNISManifest = {
		source_url: USGS_GNIS_SERVICE_URL,
		service_url: USGS_GNIS_SERVICE_URL,
		layer_id: USGS_GNIS_POPULATED_PLACES_LAYER,
		filename: USGS_GNIS_PLACES_FILENAME,
		feature_count: written,
		bytes,
		sha256,
		...(service.copyrightText ? { publisher_version: service.copyrightText } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${written.toLocaleString()} places, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path a fetch under `outRoot` writes the places to.
 */
export function usgsGNISPlacesPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(USGS_GNIS_SLUG, USGS_GNIS_PLACES_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchUSGSGNISOptions extends BaseFetchOptions {
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchUSGSGNIS(
	options: FetchUSGSGNISOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	// One request at a time with a pause between them: a full pull is about 100 requests to a public service.
	await using client = new APIClient({ displayName: USGS_GNIS_SLUG, retry: true, minRequestIntervalMs: 500 })

	// Awaited rather than returned, because `await using` disposes the client when this scope exits.
	return await downloadUSGSGNIS(client, { outputDir: options.outRoot(USGS_GNIS_SLUG), signal: options.signal, report })
}
