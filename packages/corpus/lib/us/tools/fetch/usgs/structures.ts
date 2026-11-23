// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches every point layer of the USGS National Map structures MapServer
 *   (`#us/structures/usgs/layers`), the source of the `usgov-usgs-structures` adapter.
 *   US public domain under 17 U.S.C. § 105.
 *
 *   Each layer is an ArcGIS MapServer layer that answers at most 2,000 features per request.
 *   `pageArcGISLayer` asks each layer for its feature count, then pages it by `OBJECTID`.
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
import { arcGISFields, arcGISInteger, arcGISText, pageArcGISLayer, readArcGISJSON } from "@mailwoman/core/api/arcgis"
import { sha256File } from "@mailwoman/core/crypto/hash"
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
import { isoDate } from "@mailwoman/core/utils"
import { stringifyJSON } from "@mailwoman/core/values/json"
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
 * A date field as an ISO 8601 date.
 * The service answers a date as epoch milliseconds.
 */
function dateField(value: unknown): string | null {
	const milliseconds = arcGISInteger(value)

	return milliseconds === null ? null : isoDate(new Date(milliseconds))
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
	const published = arcGISText(value)

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
	const properties = arcGISFields(feature.properties)
	const objectid = arcGISInteger(properties["objectid"])

	if (objectid === null) {
		throw new Error(`${SLUG}: layer ${layer.layerID} answered a feature with no OBJECTID`)
	}

	const state = arcGISText(properties["state"])?.toUpperCase() ?? null

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
			permanent_identifier: arcGISText(properties["permanent_identifier"]),
			fcode: arcGISInteger(properties["fcode"]),
			gnis_id: arcGISText(properties["gnis_id"]),
			name: arcGISText(properties["name"]),
			addressbuildingname: arcGISText(properties["addressbuildingname"]),
			address: arcGISText(properties["address"]),
			city: arcGISText(properties["city"]),
			state,
			...structureZIPCode(properties["zipcode"], state),
			loaddate: dateField(properties["loaddate"]),
			source_originator: arcGISText(properties["source_originator"]),
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
 * @throws When {@link pageArcGISLayer} refuses the pull, or a feature isn't one the adapter can read.
 */
async function pullLayer(
	client: Pick<APIClient, "fetch">,
	layer: USGSStructureLayer,
	staging: PathBuilderLike,
	options: Pick<DownloadUSGSStructuresOptions, "signal" | "report">
): Promise<number> {
	const { signal, report } = options
	let written = 0

	const pages = pageArcGISLayer(
		client,
		{ serviceURL: USGS_STRUCTURES_SERVICE_URL, layerID: layer.layerID },
		{
			outFields: USGS_STRUCTURE_FIELDS,
			pageSize: USGS_STRUCTURES_PAGE_SIZE,
			context: SLUG,
			signal,
			onCount: (count) => report?.(`  ${layer.layerID} ${layer.name}: ${count.toLocaleString()} features`),
			onPage: (done, count) => report?.(`    ${done.toLocaleString()} / ${count.toLocaleString()}`),
		}
	)

	for await (const page of pages) {
		const features = page.map((feature) => normalizeStructureFeature(feature, layer))

		await appendLocalTextFile(`${features.map((feature) => stringifyJSON(feature)).join("\n")}\n`, staging)
		written += features.length
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

	const service = await readArcGISJSON<StructuresService>(client, `${USGS_STRUCTURES_SERVICE_URL}?f=json`, SLUG, signal)

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
