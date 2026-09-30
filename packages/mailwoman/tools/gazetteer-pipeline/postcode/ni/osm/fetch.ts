/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetches Northern Ireland postcodes from OpenStreetMap through Overpass for a build-local database.
 */

import { APIClient } from "@mailwoman/core/api"
import { tryStat } from "@mailwoman/core/fs/readers"
import { writeLocalBuffer, writeLocalJSONFile, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { md5Hex } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The public, volunteer-run Overpass API endpoint.
 */
export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

/**
 * The Kumi Systems Overpass mirror.
 *
 * It is not the default because it has timed out on queries that the main instance answered.
 */
export const OVERPASS_ENDPOINT_KUMI = "https://overpass.kumi.systems/api/interpreter"

/**
 * The Overpass query for every OSM element tagged with a `BT` postcode.
 * Its MD5 is recorded as provenance.
 *
 * The query filters by bounding box because only Northern Ireland uses `BT`,
 * and a bounding box uses Overpass's spatial index.
 * The match is case-sensitive, so lowercase postcodes are not returned.
 */
export const NI_POSTCODE_OVERPASS_QUERY = [
	"[out:json][timeout:300];",
	'nwr["addr:postcode"~"^BT"](53.95,-8.30,55.40,-5.30);',
	"out center;",
].join("\n")

/**
 * The licence of the acquired OSM data.
 */
export const OSM_LICENSE = "Open Database License (ODbL) 1.0"

/**
 * The URL of the ODbL licence text.
 */
export const OSM_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * The attribution OSM requires in redistributed data and derived works.
 * The database embeds it.
 */
export const OSM_ATTRIBUTION =
	"© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0 " +
	"(https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright."

/**
 * A metadata note explaining why the NI OSM postcode database is built locally and never published.
 *
 * ODbL share-alike applies to derived databases.
 * Shipped gazetteers use only permissive sources so consumers take on no such obligation.
 */
export const NI_OSM_BUILD_LOCAL_NOTE =
	"BUILD-LOCAL TIER — this artifact is never published. OSM data is ODbL 1.0, whose share-alike clause (§4.4) binds a " +
	"Derived Database, and every shipped mailwoman gazetteer artifact is built from permissive sources specifically so " +
	"that installing the package imposes no share-alike obligation on a consumer. This database is therefore built on the " +
	"operator's own machine, is excluded from every npm tarball / R2 publish / demo asset, and is picked up at runtime " +
	"only because `DEFAULT_POSTCODE_DATABASES` is existsSync-filtered. An operator who builds it takes the ODbL obligation " +
	"on their own copy. Same posture as @mailwoman/osm's address-point databases and the poi.db layer."

/**
 * One element as Overpass returns it under `out center`.
 */
export interface OverpassElement {
	type: string
	id: number

	/**
	 * The node's coordinate.
	 * Ways and relations use `center` instead.
	 */
	lat?: number
	lon?: number

	/**
	 * The geometry's centre on ways and relations.
	 */
	center?: { lat: number; lon: number }
	tags?: Record<string, string>
}

/**
 * The Overpass JSON response.
 * `osm3s.timestamp_osm_base` records the OSM data timestamp.
 */
export interface OverpassResponse {
	version?: number
	generator?: string
	osm3s?: {
		timestamp_osm_base?: string
		timestamp_areas_base?: string
		copyright?: string
	}
	elements: OverpassElement[]
}

/**
 * Creates a paced `APIClient` for Overpass requests with retries disabled.
 *
 * An Overpass 429 or 504 means the volunteer host is shedding load,
 * so an operator should retry later by hand.
 */
export function createOverpassClient(): APIClient {
	return new APIClient({
		displayName: "overpass",
		minRequestIntervalMs: 2000,
		axios: {
			timeout: 600_000,
			headers: {
				"User-Agent": "mailwoman-gazetteer/1.0 (+https://mailwoman.ai)",
			},
		},
	})
}

/**
 * Options for {@link acquireNIPostcodes}.
 */
export interface AcquireNIPostcodesOptions {
	/**
	 * The directory for `response.json` and its sidecars.
	 *
	 * Use a new dated directory per acquisition so an earlier extract is kept.
	 */
	destDir: PathBuilderLike

	/**
	 * Whether to reuse an existing `response.json` instead of querying.
	 * Defaults to true.
	 *
	 * The saved response is what makes a build reproducible.
	 * Set this to `false` only when taking a new extract into a new directory.
	 */
	reuseExisting?: boolean
	client?: APIClient

	/**
	 * The Overpass instance to query.
	 * Defaults to {@link OVERPASS_ENDPOINT}.
	 */
	endpoint?: string

	/**
	 * The retrieval time written to `acquisition.json`.
	 * Defaults to the current time.
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * The saved Overpass response from {@link acquireNIPostcodes} and its checksums.
 */
export interface AcquireNIPostcodesResult {
	/**
	 * The path of the saved `response.json`.
	 */
	responsePath: PathBuilder

	/**
	 * The path of the `acquisition.json` sidecar.
	 */
	acquisitionPath: PathBuilder
	bytes: number

	/**
	 * The MD5 of the response bytes on disk.
	 */
	md5: string

	/**
	 * The MD5 of the current {@link NI_POSTCODE_OVERPASS_QUERY}.
	 */
	queryMD5: string

	/**
	 * The configured Overpass instance.
	 *
	 * For a reused response, this is the option value and may differ from the instance that answered.
	 * The original `acquisition.json` records the instance that answered.
	 */
	endpoint: string

	/**
	 * True when the response was already on disk and no request was made.
	 */
	reused: boolean
}

/**
 * Returns the MD5 of {@link NI_POSTCODE_OVERPASS_QUERY}.
 */
export function niPostcodeQueryMD5(): string {
	return md5Hex(NI_POSTCODE_OVERPASS_QUERY)
}

/**
 * Runs the NI postcode Overpass query and saves the response to `<destDir>/response.json`,
 * with an MD5 sidecar and an `acquisition.json` provenance record.
 *
 * The response bytes are saved unparsed so the recorded MD5 matches what Overpass sent.
 * When an existing response is reused without a sidecar, the sidecar is rebuilt from the file's mtime.
 */
export async function acquireNIPostcodes(options: AcquireNIPostcodesOptions): Promise<AcquireNIPostcodesResult> {
	const { reuseExisting = true, endpoint = OVERPASS_ENDPOINT } = options
	const destDir = PathBuilder.from(options.destDir)
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const responsePath = destDir("response.json")
	const acquisitionPath = destDir("acquisition.json")
	const queryMD5 = niPostcodeQueryMD5()

	await makeDirectories(destDir)

	if (reuseExisting) {
		const stats = await tryStat(responsePath)

		if (stats) {
			const md5 = await md5File(responsePath)

			phase("reuse", `${responsePath} already present (md5 ${md5})`)

			if (!(await tryStat(acquisitionPath))) {
				phase("sidecar", "acquisition.json missing — reconstructing from the response file's mtime")

				await writeAcquisitionSidecar(acquisitionPath, {
					endpoint,
					queryMD5,
					retrievedAt: stats.mtime.toISOString(),
					bytes: stats.size,
					md5,
					reconstructed: true,
				})
			}

			return { responsePath, acquisitionPath, bytes: stats.size, md5, queryMD5, endpoint, reused: true }
		}
	}

	const client = options.client ?? createOverpassClient()

	phase("query", `${endpoint} (one request; query md5 ${queryMD5})`)

	const response = await client.fetch<ArrayBuffer>({
		url: endpoint,
		method: "POST",

		data: new URLSearchParams({ data: NI_POSTCODE_OVERPASS_QUERY }).toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		responseType: "arraybuffer",

		cache: false,
	} as Parameters<APIClient["fetch"]>[0])

	const body = Buffer.from(response.data)
	await writeLocalBuffer(body, responsePath)
	const md5 = await md5File(responsePath)

	phase("saved", `${body.byteLength.toLocaleString()} bytes → ${responsePath} (md5 ${md5})`)

	await writeLocalTextFile(`${md5}  response.json\n`, destDir("response.json.md5"))

	await writeAcquisitionSidecar(acquisitionPath, {
		endpoint,
		queryMD5,
		retrievedAt: now.toISOString(),
		bytes: body.byteLength,
		md5,
	})

	return { responsePath, acquisitionPath, bytes: body.byteLength, md5, queryMD5, endpoint, reused: false }
}

/**
 * The `acquisition.json` sidecar written beside the response.
 */
export interface NIAcquisitionSidecar {
	endpoint: string
	query: string
	queryMD5: string
	retrievedAt: string
	bytes: number
	md5: string
	license: string
	licenseURL: string
	attribution: string
	tier: string

	/**
	 * True when the sidecar was rebuilt for an existing response.
	 * `retrievedAt` is then the file's mtime.
	 */
	reconstructed?: boolean
}

async function writeAcquisitionSidecar(
	path: PathBuilder,
	input: {
		endpoint: string
		queryMD5: string
		retrievedAt: string
		bytes: number
		md5: string
		reconstructed?: boolean
	}
): Promise<void> {
	const sidecar: NIAcquisitionSidecar = {
		endpoint: input.endpoint,
		query: NI_POSTCODE_OVERPASS_QUERY,
		queryMD5: input.queryMD5,
		retrievedAt: input.retrievedAt,
		bytes: input.bytes,
		md5: input.md5,
		license: OSM_LICENSE,
		licenseURL: OSM_LICENSE_URL,
		attribution: OSM_ATTRIBUTION,
		tier: "build-local",
		...(input.reconstructed ? { reconstructed: true } : {}),
	}

	await writeLocalJSONFile(sidecar, path)
}
