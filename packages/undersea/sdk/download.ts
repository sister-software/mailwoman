/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pulls the GEBCO undersea gazetteer's three service layers as GeoJSON, page by page.
 *
 *   The service returns at most {@link UNDERSEA_SERVICE_PAGE_SIZE} records a query, so each layer is read in
 *   pages ordered by `OBJECTID`. The pull asks the service for each layer's count first and refuses a result
 *   that holds a different number of features. A short read would otherwise build a layer missing features
 *   and report success.
 */

import { APIClient } from "@mailwoman/core/api"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import type { PathBuilder } from "path-ts"

import {
	UNDERSEA_SERVICE_LAYERS,
	UNDERSEA_SERVICE_PAGE_SIZE,
	UNDERSEA_SERVICE_URL,
	type UnderseaGeometryKind,
} from "#vocabulary"

/**
 * One gazetteer record as the service returns it in GeoJSON.
 */
export interface UnderseaSourceFeature {
	type: "Feature"
	geometry: { type: string; coordinates: unknown } | null
	properties: { NAME: string | null; TYPE: string | null; FEATURE_ID: number | null; OBJECTID: number }
}

/**
 * One service layer's pull.
 */
export interface UnderseaLayerPull {
	kind: UnderseaGeometryKind
	layerID: number
	/**
	 * The count the service declared before the pull.
	 */
	declaredCount: number
	features: UnderseaSourceFeature[]
}

/**
 * What a download wrote, kept beside the files as `receipt.json`.
 */
export interface UnderseaDownloadReceipt {
	serviceURL: string
	/**
	 * The date the service was read, `YYYY-MM-DD` in UTC.
	 */
	sourceVintage: string
	layers: Array<{ kind: UnderseaGeometryKind; layerID: number; count: number; file: string; sha256: string }>
}

/**
 * The client for the NOAA NCEI feature service.
 *
 * A full pull is six requests, so it sets no pacing.
 */
const serviceClient = new APIClient({ displayName: "gebco-undersea", retry: true, axios: { timeout: 120_000 } })

/**
 * Reads JSON from the service and throws on an ArcGIS error body.
 * The service sends an error body with status 200.
 */
async function readServiceJSON<T>(url: string): Promise<T> {
	const { data: body } = await serviceClient.fetch<T & { error?: { message?: string } }>({ url })

	if (body.error) {
		throw new Error(`undersea download: ${url} answered an error: ${body.error.message ?? "unknown"}`)
	}

	return body
}

/**
 * Pulls one service layer in full.
 *
 * @throws When the pulled feature count differs from the count the service declared.
 */
export async function pullUnderseaLayer(
	layer: { id: number; kind: UnderseaGeometryKind },
	serviceURL: string = UNDERSEA_SERVICE_URL
): Promise<UnderseaLayerPull> {
	const base = `${serviceURL}/${layer.id}/query`
	const { count } = await readServiceJSON<{ count: number }>(`${base}?where=1%3D1&returnCountOnly=true&f=json`)
	const features: UnderseaSourceFeature[] = []

	for (let offset = 0; offset < count; offset += UNDERSEA_SERVICE_PAGE_SIZE) {
		const page = await readServiceJSON<{ features: UnderseaSourceFeature[] }>(
			`${base}?where=1%3D1&outFields=NAME,TYPE,FEATURE_ID,OBJECTID&outSR=4326&orderByFields=OBJECTID` +
				`&resultOffset=${offset}&resultRecordCount=${UNDERSEA_SERVICE_PAGE_SIZE}&f=geojson`
		)

		features.push(...page.features)
	}

	if (features.length !== count) {
		throw new Error(
			`undersea download: layer ${layer.id} (${layer.kind}) declared ${count} features and the pull returned ${features.length}`
		)
	}

	return { kind: layer.kind, layerID: layer.id, declaredCount: count, features }
}

/**
 * Pulls all three layers and writes them, with a receipt, under `directory`.
 */
export async function downloadUnderseaGazetteer(
	directory: PathBuilder,
	options: { sourceVintage: string; serviceURL?: string; log?: (line: string) => void }
): Promise<UnderseaDownloadReceipt> {
	await makeDirectories(directory)

	const serviceURL = options.serviceURL ?? UNDERSEA_SERVICE_URL
	const receipt: UnderseaDownloadReceipt = { serviceURL, sourceVintage: options.sourceVintage, layers: [] }

	for (const layer of UNDERSEA_SERVICE_LAYERS) {
		const pull = await pullUnderseaLayer(layer, serviceURL)
		const file = `${layer.kind}.geojson`

		await writeLocalJSONFile({ type: "FeatureCollection", features: pull.features }, directory(file))

		// The digest is of the bytes on disk, so the build checks the file it reads against the receipt.
		receipt.layers.push({
			kind: layer.kind,
			layerID: layer.id,
			count: pull.features.length,
			file,
			sha256: await sha256File(directory(file)),
		})

		options.log?.(`${layer.kind}: ${pull.features.length.toLocaleString()} features → ${directory(file)}`)
	}

	await writeLocalJSONFile(receipt, directory("receipt.json"))

	return receipt
}
