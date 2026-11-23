// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches OPT-NC's agencies, the source of the `nc-opt-agences` adapter
 *   and New Caledonia's post offices in the structures layer.
 *
 *   The dataset record `localisation-des-agences-opt-nc` on `data.gouv.nc` states the publisher
 *   and the license, and its `references` point at OPT-NC's open-data GIS.
 *   That GIS serves the features from FeatureServer `Agences_opendata` layer 0.
 *
 *   The service itself states no license (`copyrightText` and the hub item's `licenseInfo` are empty),
 *   so the record is saved beside the features as `dataset.json`.
 *
 *   The layer is paged by `OBJECTID` with `pageArcGISLayer`, and a pull whose size
 *   differs from the count the service stated is refused.
 *
 *   Invoke via `mailwoman corpus fetch nc-opt-agences`.
 */

import { APIClient } from "@mailwoman/core/api"
import { arcGISFields, arcGISInteger, arcGISText, pageArcGISLayer } from "@mailwoman/core/api/arcgis"
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
import { stringifyJSON } from "@mailwoman/core/values/json"
import { readPointCoordinates } from "@mailwoman/spatial/geometries/point/coordinates"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	NC_OPT_AGENCES_ADAPTER_ID,
	NC_OPT_AGENCES_FILENAME,
	type OPTNCAgencyFeature,
} from "#nc/adapters/opt-nc/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"

/**
 * The FeatureServer that serves the agencies.
 */
export const OPT_NC_SERVICE_URL =
	"https://services6.arcgis.com/k3ZIRnRpeM4Ht4fG/arcgis/rest/services/Agences_opendata/FeatureServer"

/**
 * The dataset record on `data.gouv.nc`, which states the publisher and the license.
 */
export const OPT_NC_DATASET_URL =
	"https://data.gouv.nc/api/explore/v2.1/catalog/datasets/localisation-des-agences-opt-nc"

/**
 * The service's `maxRecordCount`.
 */
export const OPT_NC_PAGE_SIZE = 1000

/**
 * The service fields the fetcher asks for, in the service's spelling.
 */
export const OPT_NC_FIELDS = [
	"OBJECTID",
	"ID",
	"TEXTE",
	"TYPE",
	"NOM",
	"ADRESSE",
	"CODE_POSTAL",
	"VILLE",
	"GLOBALID",
] as const

/**
 * The file the dataset record is saved to, beside the features.
 */
export const OPT_NC_DATASET_FILENAME = "dataset.json"

const SLUG = NC_OPT_AGENCES_ADAPTER_ID

/**
 * The parts of the `data.gouv.nc` dataset record a fetch reads.
 */
interface OPTNCDatasetRecord {
	metas?: { default?: { modified?: string; license?: string; license_url?: string; publisher?: string } }
}

/**
 * What one run recorded.
 * `publisher_version` is the dataset record's `modified`.
 */
export interface OPTNCAgencesManifest extends SourceManifest {
	service_url: string
	dataset_url: string
	feature_count: number
	license: string | null
	license_url: string | null
	publisher: string | null
}

/**
 * One service feature in the shape the adapter reads.
 *
 * @throws When the value isn't a GeoJSON feature, or has no `OBJECTID`.
 */
export function normalizeOPTNCFeature(value: unknown): OPTNCAgencyFeature {
	if (value == null || typeof value !== "object" || (value as { type?: unknown }).type !== "Feature") {
		throw new Error(`${SLUG}: expected a GeoJSON Feature, got ${String(stringifyJSON(value)).slice(0, 200)}`)
	}

	const feature = value as { geometry?: unknown; properties?: unknown }
	const properties = arcGISFields(feature.properties)
	const objectid = arcGISInteger(properties["objectid"])

	if (objectid === null) throw new Error(`${SLUG}: the layer answered a feature with no OBJECTID`)

	const point = readPointCoordinates(feature.geometry)

	return {
		type: "Feature",
		geometry: point ? { type: "Point", coordinates: [point[0], point[1]] } : null,
		properties: {
			objectid,
			id: arcGISInteger(properties["id"]),
			texte: arcGISText(properties["texte"]),
			type: arcGISText(properties["type"]),
			nom: arcGISText(properties["nom"]),
			adresse: arcGISText(properties["adresse"]),
			code_postal: arcGISText(properties["code_postal"]),
			ville: arcGISText(properties["ville"]),
			globalid: arcGISText(properties["globalid"]),
		},
	}
}

export interface DownloadOPTNCAgencesOptions {
	outputDir: PathBuilderLike
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Pages the layer into `<outputDir>/agences.geojsonl` and writes the dataset record and the manifest.
 *
 * @throws When the service answers an error, or a pull whose size differs from its count.
 */
export async function downloadOPTNCAgences(
	client: Pick<APIClient, "fetch">,
	options: DownloadOPTNCAgencesOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const featuresPath = destDir(NC_OPT_AGENCES_FILENAME)

	report?.(`=== ${SLUG} / ${NC_OPT_AGENCES_FILENAME}`)

	const { data: dataset } = await client.fetch<OPTNCDatasetRecord>({ url: OPT_NC_DATASET_URL, signal })
	const metas = dataset?.metas?.default ?? {}

	report?.(
		`  ${metas.publisher ?? "no publisher"}; license ${metas.license ?? "absent"}; modified ${metas.modified ?? "unstated"}`
	)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(featuresPath)
	let written = 0

	try {
		await appendLocalTextFile("", staging)

		const pages = pageArcGISLayer(
			client,
			{ serviceURL: OPT_NC_SERVICE_URL, layerID: 0 },
			{
				outFields: OPT_NC_FIELDS,
				pageSize: OPT_NC_PAGE_SIZE,
				context: SLUG,
				signal,
				onCount: (count) => report?.(`  ${count.toLocaleString()} features`),
			}
		)

		for await (const page of pages) {
			const features = page.map(normalizeOPTNCFeature)

			await appendLocalTextFile(`${features.map((feature) => stringifyJSON(feature)).join("\n")}\n`, staging)
			written += features.length
		}

		await movePath(staging, featuresPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile((dataset ?? {}) as Record<string, unknown>, destDir(OPT_NC_DATASET_FILENAME))

	const sha256 = await sha256File(featuresPath)
	const { size: bytes } = await statPath(featuresPath)

	const manifest: OPTNCAgencesManifest = {
		source_url: OPT_NC_SERVICE_URL,
		service_url: OPT_NC_SERVICE_URL,
		dataset_url: OPT_NC_DATASET_URL,
		filename: NC_OPT_AGENCES_FILENAME,
		feature_count: written,
		license: metas.license ?? null,
		license_url: metas.license_url ?? null,
		publisher: metas.publisher ?? null,
		bytes,
		sha256,
		...(metas.modified ? { publisher_version: metas.modified } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${written.toLocaleString()} features, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#nc/adapters/opt-nc/adapter` reads, given the root a fetch wrote under.
 */
export function optNCAgencesInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, NC_OPT_AGENCES_FILENAME)
}

export interface FetchOPTNCAgencesOptions extends BaseFetchOptions {
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchOPTNCAgences(
	options: FetchOPTNCAgencesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true, minRequestIntervalMs: 500 })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadOPTNCAgences(client, { outputDir: options.outRoot(SLUG), signal: options.signal, report })
}
