/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { tryStat } from "@mailwoman/core/fs/readers"
import { writeLocalBuffer, writeLocalJSONFile, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { md5Hex } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Points at the public, volunteer-run Overpass API, which the NI acquisition queries exactly once.
 */
export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

/**
 * Points at the Kumi Systems Overpass mirror, which is not the default because it
 * timed out on queries the main instance answered quickly.
 *
 * Pass it via {@link AcquireNIPostcodesOptions.endpoint} only if it has recovered.
 */
export const OVERPASS_ENDPOINT_KUMI = "https://overpass.kumi.systems/api/interpreter"

/**
 * Holds the Overpass query that fetches every OSM element tagged with a `BT` postcode,
 * whose md5 goes into the database's provenance.
 *
 * It filters by a bbox rather than an NI area because `BT` is exclusive to Northern
 * Ireland and a bbox uses Overpass's spatial index.
 * The match is case-sensitive, so a lowercase `bt3 9qq` in OSM is not returned.
 */
export const NI_POSTCODE_OVERPASS_QUERY = [
	"[out:json][timeout:300];",
	'nwr["addr:postcode"~"^BT"](53.95,-8.30,55.40,-5.30);',
	"out center;",
].join("\n")

/**
 * The licence every byte of this acquisition carries.
 */
export const OSM_LICENSE = "Open Database License (ODbL) 1.0"

/**
 * The ODbL deed.
 */
export const OSM_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * Holds the attribution OSM requires in any redistributed data or derived work,
 * which this pipeline embeds in the artifact itself.
 */
export const OSM_ATTRIBUTION =
	"© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0 " +
	"(https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright."

/**
 * Explains, for the database's metadata, why the NI OSM postcode database is
 * built locally and never published.
 *
 * ODbL share-alike binds derived databases, and shipped mailwoman gazetteers use only
 * permissive sources so consumers inherit no such obligation.
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
	 * The node's latitude; ways and relations carry `center` instead.
	 */
	lat?: number
	lon?: number

	/**
	 * The geometry's centre, present on ways and relations under `out center`.
	 */
	center?: { lat: number; lon: number }
	tags?: Record<string, string>
}

/**
 * Describes the Overpass JSON envelope, whose `osm3s.timestamp_osm_base` records
 * which OSM extract the response reflects.
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
 * Creates the paced, non-retrying `APIClient` used for Overpass requests.
 *
 * Retry stays off because an Overpass 429 or 504 means the volunteer host is
 * shedding load and should be retried later by hand.
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
 * Configures {@link acquireNIPostcodes}, including where to save the response
 * and whether to reuse an existing one.
 */
export interface AcquireNIPostcodesOptions {
	/**
	 * The directory that receives `response.json` and its sidecars.
	 *
	 * Use a new dated directory per acquisition so an earlier extract is never overwritten.
	 */
	destDir: PathBuilderLike

	/**
	 * Whether to reuse an existing `response.json` instead of querying, default true.
	 *
	 * Overpass is a volunteer endpoint and the saved response is the reproducibility artifact,
	 * so set `false` only to take a deliberate new extract into a new directory.
	 */
	reuseExisting?: boolean
	client?: APIClient

	/**
	 * The Overpass instance to query, default {@link OVERPASS_ENDPOINT},
	 * recorded in `acquisition.json` as provenance.
	 */
	endpoint?: string

	/**
	 * The retrieval time stamped into `acquisition.json`, default the current time.
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Describes the saved Overpass response from {@link acquireNIPostcodes},
 * with its checksums and whether an existing file was reused.
 */
export interface AcquireNIPostcodesResult {
	/**
	 * The path of the saved `response.json`.
	 */
	responsePath: PathBuilder

	/**
	 * The path of the `acquisition.json` retrieval-metadata sidecar.
	 */
	acquisitionPath: PathBuilder
	bytes: number

	/**
	 * The md5 of the response bytes on disk.
	 */
	md5: string

	/**
	 * The md5 of the current {@link NI_POSTCODE_OVERPASS_QUERY}.
	 */
	queryMD5: string

	/**
	 * The configured Overpass instance.
	 *
	 * On a reused response this is the option's value, not necessarily the instance that
	 * originally answered; a first-hand `acquisition.json` records that.
	 */
	endpoint: string

	/**
	 * True when the response was already on disk, so no request was made.
	 */
	reused: boolean
}

/**
 * Returns the md5 of {@link NI_POSTCODE_OVERPASS_QUERY}, which the builder records as provenance.
 */
export function niPostcodeQueryMD5(): string {
	return md5Hex(NI_POSTCODE_OVERPASS_QUERY)
}

/**
 * Runs the NI postcode Overpass query and saves the response to `<destDir>/response.json`
 * with an md5 sidecar and an `acquisition.json` provenance record.
 *
 * The response bytes are written unparsed, so the recorded md5 matches what Overpass actually sent.
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
 * The retrieval-metadata sidecar, as it lands on disk beside the response.
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
	 * True when the sidecar was rebuilt for a response already on disk, so `retrievedAt`
	 * is the file's mtime rather than an observed request time.
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
