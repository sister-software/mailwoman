/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads PLATEAU VIEW's dataset catalog, the CKAN record of each building dataset, and each tileset's root extent.
 */

import { setTimeout as sleep } from "node:timers/promises"

import { APIClient, API_CLIENT_DEFAULTS, type APIClientConfig } from "@mailwoman/core/api"
import { ResourceError } from "@mailwoman/core/errors"
import { StatusCodes } from "http-status-codes"

import type { PlateauTileset } from "#jp/plateau"

/**
 * PLATEAU VIEW's catalog of every published PLATEAU dataset.
 */
export const PLATEAU_CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets"

const CKAN_PACKAGE_SHOW = "https://www.geospatial.jp/ckan/api/3/action/package_show"

/**
 * Bytes read from the start of a `tileset.json`.
 *
 * The root bounding volume follows the `properties` summary.
 * That summary exceeds 4 KB in most PLATEAU tilesets.
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

	/**
	 * A file's bytes, such as a tile of a 3D Tiles tileset.
	 */
	public async getBytes(url: string): Promise<Uint8Array> {
		const response = await this.fetch<ArrayBuffer>({ url, responseType: "arraybuffer" })

		return new Uint8Array(response.data)
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

/**
 * A client used only for the tileset host, `assets.cms.plateau.reearth.io`,
 * a CDN that the converter reads tens of thousands of tiles from.
 *
 * It keeps the retries and drops the request spacing the catalog and CKAN API get.
 */
export function createPlateauTileClient(): PlateauClient {
	return new PlateauClient({
		displayName: "PLATEAU tiles",
		minRequestIntervalMs: 0,
		retry: { maxAttempts: API_CLIENT_DEFAULTS.maxAttempts, baseDelayMs: API_CLIENT_DEFAULTS.baseRetryDelayMs },
	})
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

	// A busy server returns `ExportData.ErrMsg` with HTTP 200.
	// The client retry does not see this response as an error.
	for (let attempt = 1; ; attempt++) {
		const response = await client.getJSON<GeoidCalcResponse>(url)
		const height = Number.parseFloat(response.OutputData?.geoidHeight ?? "")

		if (Number.isFinite(height)) return height

		if (attempt >= GSI_BUSY_ATTEMPTS) {
			throw new ResourceError(
				StatusCodes.BAD_GATEWAY,
				"gsi:geoid",
				`GSI returned no geoid height for ${latitude},${longitude}: ${response.ExportData?.ErrMsg ?? "no OutputData"}`
			)
		}

		await sleep(GSI_BUSY_DELAY_MS * attempt)
	}
}

interface GeoidCalcResponse {
	OutputData?: { geoidHeight?: string }
	ExportData?: { ErrMsg?: string }
}

/**
 * A tileset's directory name, such as `13100_tokyo23-ku_city_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2`.
 *
 * The catalog serves each variant of one ward's buildings under a different asset path,
 * so only the directory names pair them.
 */
function tilesetDirectory(url: string): string {
	return url.split("/").at(-2) ?? ""
}

/**
 * The building tilesets to draw: one LoD2 tileset per ward, textured where the
 * catalog has a textured LoD2 tileset beside the untextured one.
 *
 * An untextured tileset's glTF sets no base color, vertex color or texture, so it renders as one flat gray.
 * A textured tileset's glTF holds photographic textures or vertex colors.
 *
 * Each selected tileset also records `untexturedURL`, the ward's untextured tileset.
 * The city model converter reads that one, because Earth's own layer draws every
 * building in the map's style and uses only the geometry.
 *
 * Each tileset appears once.
 * The catalog can list one ward's untextured tileset twice under two asset paths,
 * as it does Mashiki-machi's 2023 buildings, and both pair with the one textured tileset.
 * The first of the two becomes `untexturedURL`.
 */
export function selectBuildingTilesets<T extends Pick<CatalogEntry, "type_en" | "url">>(
	datasets: readonly T[]
): Array<T & { untexturedURL: string }> {
	const buildings = datasets.filter((entry) => entry.type_en === "bldg")
	const byDirectory = new Map(buildings.map((entry) => [tilesetDirectory(entry.url), entry]))
	const selected = new Map<string, T & { untexturedURL: string }>()

	for (const untextured of buildings) {
		if (!tilesetDirectory(untextured.url).endsWith("_lod2_no_texture")) continue

		const drawn = byDirectory.get(tilesetDirectory(untextured.url).replace(/_lod2_no_texture$/u, "_lod2")) ?? untextured

		if (!selected.has(drawn.url)) {
			selected.set(drawn.url, { ...drawn, untexturedURL: untextured.url })
		}
	}

	return [...selected.values()]
}

export async function readPlateauTilesets(
	client: PlateauClient,
	onSkip: (url: string, reason: string) => void
): Promise<PlateauTileset[]> {
	const catalog = await client.getJSON<{ datasets: CatalogEntry[] }>(PLATEAU_CATALOG_URL)
	const entries = selectBuildingTilesets(catalog.datasets)
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
			untexturedURL: entry.untexturedURL,
			bounds,
			geoidHeight: await readGeoidHeight(client, (west + east) / 2, (south + north) / 2),
		})
	}

	return tilesets.toSorted((a, b) => a.cityCode.localeCompare(b.cityCode))
}
