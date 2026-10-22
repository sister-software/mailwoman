/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads PLATEAU VIEW's dataset catalog, the CKAN record of each building dataset, and each tileset's root extent.
 */

import { APIClient, API_CLIENT_DEFAULTS, type APIClientConfig } from "@mailwoman/core/api"
import { ResourceError } from "@mailwoman/core/errors"
import { StatusCodes } from "http-status-codes"
import { setTimeout as sleep } from "node:timers/promises"

import type { PlateauTileset } from "#jp/plateau"

/**
 * PLATEAU VIEW's catalog of every published PLATEAU dataset.
 */
export const PLATEAU_CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets"

const CKAN_PACKAGE_SHOW = "https://www.geospatial.jp/ckan/api/3/action/package_show"

/**
 * Bytes read from the start of a `tileset.json`.
 *
 * The root bounding volume follows the `properties` summary, which runs past 4 KB in most PLATEAU tilesets.
 */
const TILESET_HEAD_BYTES = 65_536

const GSI_GEOID_CALC = "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl"

const GSI_BUSY_ATTEMPTS = 6

const GSI_BUSY_DELAY_MS = 5000

interface CatalogEntry {
	city: string
	city_code: string
	pref: string
	year: number
	type_en: string
	url: string
}

/**
 * A client for the catalog, geospatial.jp's CKAN API and the tileset host.
 */
export class PlateauClient extends APIClient<APIClientConfig> {
	public async getJSON<T>(url: string): Promise<T> {
		return (await this.fetch<T>({ url })).data
	}

	public async getHead(url: string): Promise<string> {
		const response = await this.fetch<string>({
			url,
			responseType: "text",
			headers: { Range: `bytes=0-${TILESET_HEAD_BYTES - 1}` },
		})

		return response.data
	}
}

export function createPlateauClient(): PlateauClient {
	return new PlateauClient({
		displayName: "PLATEAU",
		minRequestIntervalMs: 200,
		retry: { maxAttempts: API_CLIENT_DEFAULTS.maxAttempts, baseDelayMs: API_CLIENT_DEFAULTS.baseRetryDelayMs },
	})
}

/**
 * The CKAN dataset name a tileset URL belongs to: `13101_chiyoda-ku_pref_2025_…`
 * is `plateau-13101-chiyoda-ku-2025`.
 */
export function datasetNameFromTilesetURL(url: string): string | null {
	const match = /\/(\d{5})_([a-z0-9-]+)_(?:city|pref)_(\d{4})_/.exec(url)

	return match ? `plateau-${match[1]}-${match[2]}-${match[3]}` : null
}

/**
 * The `[west, south, east, north]` extent in degrees of a tileset whose root bounding volume is a `region`.
 */
export function boundsFromTilesetHead(head: string): [number, number, number, number] | null {
	const match = /"region"\s*:\s*\[([^\]]+)\]/.exec(head)

	if (!match) return null
	const [west, south, east, north] = match[1]!.split(",").map((value) => (Number(value) * 180) / Math.PI)

	return [west!, south!, east!, north!].every(Number.isFinite) ? [west!, south!, east!, north!] : null
}

/**
 * The `license_title` of a CKAN dataset, or null when geospatial.jp holds no dataset of that name.
 *
 * The catalog's romanization can differ from the dataset's (`oumihachiman` against `omihachiman`),
 * and CKAN answers 404 for the name built from the tileset URL.
 */
async function readLicenseTitle(client: PlateauClient, dataset: string): Promise<string | null> {
	try {
		const record = await client.getJSON<{ result?: { license_title?: string } }>(`${CKAN_PACKAGE_SHOW}?id=${dataset}`)

		return record.result?.license_title ?? null
	} catch (error) {
		if (error instanceof ResourceError && error.status === StatusCodes.NOT_FOUND) return null

		throw error
	}
}

/**
 * Every untextured LoD2 building tileset in the catalog, with its CKAN license and root extent.
 *
 * A tileset whose extent cannot be read is reported through `onSkip` and left out.
 */
/**
 * The geoid height in meters at a point, from GSI's geoid calculation service.
 */
export async function readGeoidHeight(client: PlateauClient, longitude: number, latitude: number): Promise<number> {
	const url = `${GSI_GEOID_CALC}?outputType=json&latitude=${latitude}&longitude=${longitude}`
	// The service answers a busy server with `ExportData.ErrMsg` and HTTP 200, which the client's own retry never sees.
	for (let attempt = 1; ; attempt++) {
		const response = await client.getJSON<GeoidCalcResponse>(url)
		const height = Number.parseFloat(response.OutputData?.geoidHeight ?? "")

		if (Number.isFinite(height)) return height

		if (attempt >= GSI_BUSY_ATTEMPTS) {
			throw new ResourceError(
				StatusCodes.BAD_GATEWAY,
				"gsi:geoid",
				`GSI returned no geoid height for ${latitude},${longitude}: ${JSON.stringify(response)}`
			)
		}

		await sleep(GSI_BUSY_DELAY_MS * attempt)
	}
}

interface GeoidCalcResponse {
	OutputData?: { geoidHeight?: string }
	ExportData?: { ErrMsg?: string }
}

export async function readPlateauTilesets(
	client: PlateauClient,
	onSkip: (url: string, reason: string) => void
): Promise<PlateauTileset[]> {
	const catalog = await client.getJSON<{ datasets: CatalogEntry[] }>(PLATEAU_CATALOG_URL)
	const entries = catalog.datasets.filter((entry) => entry.type_en === "bldg" && /lod2_no_texture/.test(entry.url))
	const tilesets: PlateauTileset[] = []
	// Wards of one designated city share one dataset, so each dataset's license is read once.
	const licenses = new Map<string, Promise<string | null>>()

	for (const entry of entries) {
		const dataset = datasetNameFromTilesetURL(entry.url)
		const bounds = boundsFromTilesetHead(await client.getHead(entry.url))

		if (!bounds) {
			onSkip(entry.url, "the tileset's root has no region bounding volume")

			continue
		}

		if (dataset && !licenses.has(dataset)) {
			licenses.set(dataset, readLicenseTitle(client, dataset))
		}

		const [west, south, east, north] = bounds

		tilesets.push({
			cityCode: entry.city_code,
			city: entry.city,
			prefecture: entry.pref,
			year: entry.year,
			dataset: dataset ?? "",
			licenseTitle: dataset ? await licenses.get(dataset)! : null,
			url: entry.url,
			bounds,
			geoidHeight: await readGeoidHeight(client, (west + east) / 2, (south + north) / 2),
		})
	}

	return tilesets.toSorted((a, b) => a.cityCode.localeCompare(b.cityCode))
}
