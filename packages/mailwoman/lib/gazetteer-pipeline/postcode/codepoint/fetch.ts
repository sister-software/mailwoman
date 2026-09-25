/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads and verifies the Ordnance Survey Code-Point Open archive.
 */

import { APIClient } from "@mailwoman/core/api"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The root of the OS Downloads API, which serves OpenData products without authentication.
 */
export const OS_DOWNLOADS_API_BASE = "https://api.os.uk/downloads/v1"

/**
 * The OS Data Hub product ID for Code-Point Open.
 */
export const CODEPOINT_PRODUCT_ID = "CodePointOpen"

/**
 * The licence Code-Point Open is published under, spelled exactly as OS spells it.
 */
export const CODEPOINT_LICENSE = "Open Government Licence v3.0"

/**
 * The URL of the OGL v3 licence text.
 */
export const CODEPOINT_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * Builds the attribution OS requires for redistributing Code-Point Open.
 *
 * `year` is the year of redistribution, which can differ from the OS release year.
 */
export function codePointAttribution(year: number): string {
	return [
		`Contains OS data © Crown copyright and database right ${year}.`,
		`Contains Royal Mail data © Royal Mail copyright and database right ${year}.`,
		`Contains National Statistics data © Crown copyright and database right ${year}.`,
		`Licensed under the ${CODEPOINT_LICENSE} (${CODEPOINT_LICENSE_URL}).`,
	].join(" ")
}

/**
 * One downloadable file for a product, as the Downloads API reports it.
 */
export interface CodePointDownload {
	/**
	 * The OS-published MD5 of the archive.
	 */
	md5: string

	/**
	 * The archive size in bytes.
	 */
	size: number

	/**
	 * The download URL, which redirects to a CDN object.
	 */
	url: string

	/**
	 * The archive format, such as `CSV` or `GeoPackage`.
	 */
	format: string

	/**
	 * The coverage area.
	 *
	 * Code-Point Open publishes only `GB`, which excludes Northern Ireland.
	 */
	area: string

	/**
	 * The archive file name, such as `codepo_gb.zip`.
	 */
	fileName: string
}

/**
 * The Downloads API product record.
 */
export interface CodePointProduct {
	id: string
	name: string

	/**
	 * The OS release label, such as `2026-05`.
	 *
	 * It differs from the dataset version in the archive's `Doc/metadata.txt`.
	 */
	version: string
}

/**
 * A note stating that Code-Point Open covers England, Scotland, and Wales only.
 *
 * The missing `BT` postcodes are a licensing gap.
 * Reports must state the gap instead of filling it from another source.
 */
export const CODEPOINT_COVERAGE_NOTE =
	"Code-Point Open covers England, Scotland and Wales only (country codes E92000001/S92000003/W92000004). " +
	"Northern Ireland (BT postcodes), the Isle of Man and the Channel Islands are NOT included — NI postcode " +
	"data is administered by Land & Property Services and lies outside OS OpenData and outside ONS's OGL grant. " +
	"See NORTHERN_IRELAND_OPTIONS_NOTE for why the gap cannot be filled from a free source."

/**
 * A note explaining why no free source can fill Northern Ireland postcode centroids,
 * and which options remain.
 *
 * ONSPD and NSPL exclude their `BT` coordinates from the OGL, so this published database keeps its `BT` gap.
 */
export const NORTHERN_IRELAND_OPTIONS_NOTE =
	"Northern Ireland (BT) postcode centroids CANNOT be filled from a free source. ONSPD/NSPL carry BT coordinates " +
	"(from LPS Pointer) but carve them out of OGL: ONS grants re-use 'not including logos or Northern Ireland data', " +
	"and BT rows come only under an LPS Northern Ireland End User Licence that is personal (§1.2), internal-business-use " +
	"only (§2), and non-sublicensable (§9) — so redistribution in a published artifact is barred regardless of " +
	"commercial intent, including via re-publishers such as doogal/FreeMapTools. NISRA's Central Postcode Directory is " +
	"free but equally non-redistributable. LPS's OSNI Open Data catalogue (77 datasets, all OGL v3) contains NO postcode " +
	"centroids or address points — verified against the catalogue. Options: (a) licence Pointer from LPS (~£9,224 excl. " +
	"VAT full NI coverage; >£3,000 orders need a formal >=12-month licence) — the only route to complete NI centroids in " +
	"a permissively-licensed package; (b) ship NI as ODbL from OpenStreetMap addr:postcode — partial coverage plus " +
	"share-alike contamination; (c) ship no NI centroids and use the OGL-clean OSNI Streetnames gazetteer for " +
	"street-level NI resolution. (c) is what THIS database does and must keep doing — its BT hole is a licensing fact, and " +
	"filling it from an ODbL source would contaminate a published artifact. (b) landed separately on 2026-08-05 as the " +
	"BUILD-LOCAL database postalcode-ni-osm.db (`mailwoman gazetteer build postcode-ni-osm`), which is never published and " +
	"covers 4,757 of the 50,032 live NI postcodes (9.5 %), 250/886 sectors, 80/80 districts. Scale: ONSPD Feb 2025 " +
	"counts 50,032 live NI postcodes."

/**
 * Creates a paced OS Downloads API client with bounded retries.
 */
export function createOSDownloadsClient(): APIClient {
	return new APIClient({
		displayName: "os-downloads",
		axios: { baseURL: OS_DOWNLOADS_API_BASE },
		minRequestIntervalMs: 250,
		retry: { maxAttempts: 3 },
	})
}

/**
 * Fetches the Code-Point Open product record, which carries the release `version`.
 */
export async function fetchCodePointProduct(client: APIClient = createOSDownloadsClient()): Promise<CodePointProduct> {
	const { data } = await client.fetch<CodePointProduct>({ url: `/products/${CODEPOINT_PRODUCT_ID}`, method: "GET" })

	return data
}

/**
 * Lists the Code-Point Open archives that the OS Downloads API offers, one per format.
 */
export async function fetchCodePointDownloads(
	client: APIClient = createOSDownloadsClient()
): Promise<CodePointDownload[]> {
	const { data } = await client.fetch<CodePointDownload[]>({
		url: `/products/${CODEPOINT_PRODUCT_ID}/downloads`,
		method: "GET",
	})

	return data
}

/**
 * Options for {@link downloadCodePointOpen}.
 */
export interface DownloadCodePointOptions {
	/**
	 * The directory for the archive, its `.md5` sidecar, and `acquisition.json`.
	 *
	 * A later download into the same directory overwrites these files.
	 * Use a new directory per acquisition to keep earlier ones.
	 */
	destDir: PathBuilderLike

	/**
	 * The archive format.
	 *
	 * Defaults to `CSV`, the only format the database builder parses.
	 */
	format?: "CSV" | "GeoPackage"

	/**
	 * An existing client to reuse, including its request pacing.
	 */
	client?: APIClient

	/**
	 * Whether to skip the download when the existing file already matches the upstream MD5.
	 * Defaults to `true`.
	 */
	reuseExisting?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * The archive that {@link downloadCodePointOpen} downloaded or reused.
 */
export interface DownloadCodePointResult {
	archivePath: PathBuilder

	/**
	 * The archive size in bytes.
	 */
	bytes: number

	/**
	 * The MD5 of the archive on disk, which matches {@link CodePointDownload.md5}.
	 */
	md5: string

	/**
	 * The product's OS release label at acquisition time.
	 */
	version: string

	/**
	 * The Downloads API record for the archive.
	 */
	download: CodePointDownload

	/**
	 * True when the existing archive already matched and nothing was downloaded.
	 */
	reused: boolean
}

/**
 * Downloads a Code-Point Open archive into `destDir` and verifies its MD5 against the Downloads API record.
 *
 * It also writes an `.md5` sidecar and an `acquisition.json` provenance file beside the archive.
 * A reused archive gets neither file rewritten.
 */
export async function downloadCodePointOpen(options: DownloadCodePointOptions): Promise<DownloadCodePointResult> {
	const { format = "CSV", reuseExisting = true } = options
	const destDir = PathBuilder.from(options.destDir)
	const phase = options.onPhase ?? (() => {})
	const client = options.client ?? createOSDownloadsClient()

	phase("discover", `${OS_DOWNLOADS_API_BASE}/products/${CODEPOINT_PRODUCT_ID}`)
	const [product, downloads] = await Promise.all([fetchCodePointProduct(client), fetchCodePointDownloads(client)])
	const download = downloads.find((d) => d.format === format)

	if (!download) {
		throw new Error(
			`downloadCodePointOpen: OS Downloads API offers no ${format} archive for ${CODEPOINT_PRODUCT_ID} ` +
				`(got: ${downloads.map((d) => d.format).join(", ") || "nothing"})`
		)
	}

	await makeDirectories(destDir)
	const archivePath = destDir(download.fileName)

	if (reuseExisting) {
		const existing = await md5File(archivePath).catch(() => null)

		if (existing === download.md5) {
			phase("reuse", `${download.fileName} already matches upstream md5`)

			return { archivePath, bytes: download.size, md5: existing, version: product.version, download, reused: true }
		}
	}

	phase("download", `${download.fileName} (${download.size.toLocaleString()} bytes)`)

	const response = await fetch(download.url)

	if (!response.ok || !response.body) {
		throw new Error(`downloadCodePointOpen: OS download failed (${response.status}) for ${download.url}`)
	}

	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), openWriteStream(archivePath))

	phase("verify", `md5 vs OS-published ${download.md5}`)
	const md5 = await md5File(archivePath)

	if (md5 !== download.md5) {
		throw new Error(
			`downloadCodePointOpen: md5 mismatch for ${download.fileName} — OS published ${download.md5}, ` +
				`downloaded bytes hash to ${md5} (${bytes.toLocaleString()} of an expected ${download.size.toLocaleString()})`
		)
	}

	await writeLocalTextFile(`${md5}  ${download.fileName}\n`, destDir(`${download.fileName}.md5`))

	await writeLocalTextFile(
		prettyJSON({ product, download, bytes, md5, acquiredAt: new Date().toISOString() }),
		destDir("acquisition.json")
	)

	return { archivePath, bytes, md5, version: product.version, download, reused: false }
}
