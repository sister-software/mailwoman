/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Points at the root of the OS Downloads API, which serves OpenData products without authentication.
 */
export const OS_DOWNLOADS_API_BASE = "https://api.os.uk/downloads/v1"

/**
 * The OS Data Hub product id for Code-Point Open.
 */
export const CODEPOINT_PRODUCT_ID = "CodePointOpen"

/**
 * Names the licence Code-Point Open is published under.
 *
 * The spelling matches OS exactly, because the database `meta` table stores it verbatim.
 */
export const CODEPOINT_LICENSE = "Open Government Licence v3.0"

/**
 * The OGL v3 deed.
 */
export const CODEPOINT_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * Builds the attribution OS requires for redistributing Code-Point Open: one line
 * each for OS, Royal Mail and National Statistics, plus the OGL.
 *
 * `year` is the year of the redistribution rather than of the OS release.
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
 * One downloadable file OS offers for a product, as the Downloads API reports it.
 */
export interface CodePointDownload {
	/**
	 * Holds the OS-published MD5 of the archive, which {@link downloadCodePointOpen}
	 * verifies the downloaded bytes against.
	 */
	md5: string

	/**
	 * Gives the archive size in bytes.
	 */
	size: number

	/**
	 * Gives the download URL, which redirects to a CDN object.
	 */
	url: string

	/**
	 * Names the archive format, such as `CSV` or `GeoPackage`.
	 */
	format: string

	/**
	 * Names the coverage area; Code-Point Open publishes only `GB`, which excludes
	 * Northern Ireland (see {@link CODEPOINT_COVERAGE_NOTE}).
	 */
	area: string

	/**
	 * Gives the archive file name, such as `codepo_gb.zip`.
	 */
	fileName: string
}

/**
 * The product record, for the version stamp that goes into the database's provenance.
 */
export interface CodePointProduct {
	id: string
	name: string

	/**
	 * Gives the OS release label, such as `2026-05`, which differs from the dataset
	 * version in the archive's `Doc/metadata.txt`.
	 */
	version: string
}

/**
 * States that Code-Point Open covers England, Scotland and Wales only,
 * not Northern Ireland, the Isle of Man or the Channel Islands.
 *
 * The missing `BT` postcodes are a licensing gap, so they must be reported
 * rather than filled from another source.
 */
export const CODEPOINT_COVERAGE_NOTE =
	"Code-Point Open covers England, Scotland and Wales only (country codes E92000001/S92000003/W92000004). " +
	"Northern Ireland (BT postcodes), the Isle of Man and the Channel Islands are NOT included — NI postcode " +
	"data is administered by Land & Property Services and lies outside OS OpenData and outside ONS's OGL grant. " +
	"See NORTHERN_IRELAND_OPTIONS_NOTE for why the gap cannot be filled from a free source."

/**
 * Explains why Northern Ireland postcode centroids cannot be filled from a
 * free source, and which options remain.
 *
 * ONSPD and NSPL exclude their `BT` coordinates from the OGL, so this published
 * database must keep its `BT` gap.
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
 * Create a paced API client with bounded retries for metadata requests.
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
 * Read the product record (for its `version` stamp).
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
 * Configures {@link downloadCodePointOpen}.
 *
 * By default it fetches the CSV archive and reuses an existing file whose MD5
 * already matches the published one.
 */
export interface DownloadCodePointOptions {
	/**
	 * Names the directory that receives the archive, its `.md5` sidecar and `acquisition.json`.
	 *
	 * A later download into the same directory overwrites them, so use a new
	 * directory per acquisition to keep earlier ones.
	 */
	destDir: PathBuilderLike

	/**
	 * Selects the archive format, defaulting to `CSV`, the only format the database builder parses.
	 */
	format?: "CSV" | "GeoPackage"

	/**
	 * Supplies an existing client to reuse, including its request pacing.
	 */
	client?: APIClient

	/**
	 * Skip the download when the destination file already matches the upstream MD5; defaults to `true`.
	 */
	reuseExisting?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Describes the archive that {@link downloadCodePointOpen} downloaded or reused,
 * with its verified MD5 and the product version.
 */
export interface DownloadCodePointResult {
	archivePath: PathBuilder

	/**
	 * Gives the archive size in bytes.
	 */
	bytes: number

	/**
	 * Holds the MD5 of the archive on disk, already verified equal to {@link CodePointDownload.md5}.
	 */
	md5: string

	/**
	 * Gives the product's OS release label at acquisition time.
	 */
	version: string

	/**
	 * Holds the Downloads API record the archive came from.
	 */
	download: CodePointDownload

	/**
	 * Is true when the archive on disk already matched, so nothing was downloaded.
	 */
	reused: boolean
}

/**
 * Downloads a Code-Point Open archive into `destDir` and verifies its MD5 against the Downloads API record.
 *
 * The function also writes an `.md5` sidecar and an `acquisition.json` provenance file beside the archive.
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
