/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ordnance Survey **Code-Point Open** acquisition — the GB unit-postcode register, and the licensed
 *   replacement for the GeoNames `GB_full` rows the tail shard has been riding on (see
 *   `../geonames-tail.ts`, whose `GB_LICENSE_NOTE` is the reason this module exists).
 *
 *   Code-Point Open is an OS OpenData product: no API key, no account, no click-through. The OS Data
 *   Hub exposes it through the public **OS Downloads API**, which is two GETs —
 *   `/products/CodePointOpen` for the version stamp, `/products/CodePointOpen/downloads` for the file
 *   list. The list is the useful one: it carries the upstream **md5 and byte size**, so a download can
 *   be verified against OS's own digest rather than against a number we wrote down. That is what
 *   {@link downloadCodePointOpen} does, and it is why the acquisition doesn't just `curl` a static URL.
 *
 *   VERIFIED 2026-08-05: both endpoints answer unauthenticated. Product version `2026-05`, CSV archive
 *   `codepo_gb.zip`, 14,446,552 bytes, md5 `ad0e258f056cee7bd81a50dc626c4f69`. The same md5 was already
 *   sitting in `$MAILWOMAN_DATA_ROOT/codepoint/2026-07-22/` from an earlier manual pull, which dates the
 *   release: OS has not re-cut the file between 2026-07-22 and 2026-08-05.
 *
 *   ## Layout
 *
 *   This is an `sdk/`-shaped trio (fetch → extract → parse, exactly like `ban/sdk`) that deliberately
 *   does NOT live in its own workspace. Code-Point Open has one consumer — the GB postcode shard
 *   builder two directories up — and `gazetteer-pipeline/postcode/` already owns every other postcode
 *   shard's build. A top-level `codepoint/` workspace would add a publish surface, an exports map, two
 *   tsconfigs and a row in the AGENTS.md table to acquire one 14 MB zip that nothing outside this
 *   pipeline will ever import.
 *
 *   ## Licence
 *
 *   OGL v3, and the attribution is NOT optional — see {@link codePointAttribution}. The year in the
 *   block is the year of OUR publication, which is why it is a function and not a string constant.
 */

import { createWriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { APIClient } from "@mailwoman/core/api"
import { md5File } from "@mailwoman/core/utils"
import { join } from "path-ts"

/**
 * The OS Downloads API root. Public, unauthenticated for OpenData products.
 */
export const OS_DOWNLOADS_API_BASE = "https://api.os.uk/downloads/v1"

/**
 * The OS Data Hub product id for Code-Point Open.
 */
export const CODEPOINT_PRODUCT_ID = "CodePointOpen"

/**
 * The licence Code-Point Open is published under. Named exactly as OS names it, because the shard's `meta` table stores
 * this verbatim and a consumer greps it.
 */
export const CODEPOINT_LICENSE = "Open Government Licence v3.0"

/**
 * The OGL v3 deed.
 */
export const CODEPOINT_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * The THREE-LINE attribution block OS requires of anyone redistributing Code-Point Open, plus the OGL reference.
 *
 * All three lines are mandatory and each names a different rightsholder: OS for the geometry, **Royal Mail** for the
 * postcodes themselves, and **National Statistics** for the ONS administrative codes carried on every row. Shipping
 * only the OS line — the common mistake, and the one GeoNames' readme makes in reverse by naming only Royal Mail — is
 * not compliance.
 *
 * `year` is the year of YOUR publication, not the year of the OS release; OGL attribution tracks the redistribution.
 * That is the whole reason this is a function. The archive's own `Doc/licence.txt` in the 2026-05 cut reads `2026` on
 * all three lines.
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
	 * Upstream md5 of the archive — the digest {@link downloadCodePointOpen} verifies against.
	 */
	md5: string
	/**
	 * Archive size in bytes.
	 */
	size: number
	/**
	 * The download URL. Ends in `&redirect`; OS 302s to a CDN object.
	 */
	url: string
	/**
	 * `CSV` or `GeoPackage`.
	 */
	format: string
	/**
	 * Coverage area. Code-Point Open publishes a single `GB` area — see {@link CODEPOINT_COVERAGE_NOTE}.
	 */
	area: string
	/**
	 * The archive filename, e.g. `codepo_gb.zip`.
	 */
	fileName: string
}

/**
 * The product record, for the version stamp that goes into the shard's provenance.
 */
export interface CodePointProduct {
	id: string
	name: string
	/**
	 * OS's release label, e.g. `2026-05`. Distinct from the internal `DATASET VERSION NUMBER` in the archive's
	 * `Doc/metadata.txt` (`2026.2.0` for this cut) — both are recorded.
	 */
	version: string
}

/**
 * What "GB" means on this product, stated here because it is the single most consequential fact about it and the one a
 * reader is most likely to assume wrongly.
 *
 * Code-Point Open covers **England, Scotland and Wales only**. It does NOT cover Northern Ireland, and it does not
 * cover the Isle of Man or the Channel Islands. The country codes on the 2026-05 rows are exactly three — `E92000001`,
 * `S92000003`, `W92000004` — with no `N92000002` among 1,747,841 rows. NI postcodes (the `BT` area) are administered by
 * Land & Property Services and are not in any OS OpenData product; ONS's OGL grant for postcode products explicitly
 * excludes NI data. So a shard built from this source has a real, permanent `BT` hole, and the hole is a licensing fact
 * rather than a data-quality one. Report it; do not fill it from an unlicensed source.
 */
export const CODEPOINT_COVERAGE_NOTE =
	"Code-Point Open covers England, Scotland and Wales only (country codes E92000001/S92000003/W92000004). " +
	"Northern Ireland (BT postcodes), the Isle of Man and the Channel Islands are NOT included — NI postcode " +
	"data is administered by Land & Property Services and lies outside OS OpenData and outside ONS's OGL grant. " +
	"See NORTHERN_IRELAND_OPTIONS_NOTE for why the gap cannot be filled from a free source."

/**
 * What it would actually take to fill the Northern Ireland hole — researched 2026-08-05, because the obvious answer is
 * wrong in a way that would get us in trouble.
 *
 * The obvious answer is ONSPD: the ONS Postcode Directory is free, is published on the Open Geography Portal under OGL,
 * and DOES carry BT postcodes with coordinates (derived from LPS's Pointer, on the Irish National Grid). Take it and
 * the gap closes. That reading is wrong, and the wrongness is explicit in ONS's own words rather than a matter of
 * interpretation. From the ONS licences page, covering ONSPD and NSPL alike: "You may re-use this information **(not
 * including logos or Northern Ireland data)** free of charge", and BT rows ship only with "a Northern Ireland End User
 * Licence (for internal business use only)". The ONSPD User Guide (May 2021, §3) said it flatter still: "Open
 * Government Licensing terms do not apply to NI postcodes."
 *
 * And the LPS End User Licence itself is not merely a commercial-use gate. It is PERSONAL (§1.2 "personal to you and
 * the licence granted herein is for your benefit only"), INTERNAL-ONLY (§2 "solely for your own internal business use …
 * all other uses are prohibited"), and NON-SUBLICENSABLE (§9 "you may not novate, assign, transfer, sub-contract or
 * otherwise part with this Licence"). Shipping BT rows in a published package is therefore out under any reading,
 * commercial or not — and that applies equally to the ONSPD re-publishers (doogal, FreeMapTools), whose own terms
 * reproduce the same exclusion. NISRA's Central Postcode Directory is free but no better: its MOU forbids passing
 * copies to third parties and permits only internal use and non-commercial statistics.
 *
 * There is also no NI counterpart to Code-Point Open to fall back on. LPS's OSNI Open Data catalogue is 77 datasets,
 * all OGL v3, and contains boundaries, terrain, raster mapping and two gazetteers (place names, street names) — no
 * postcode centroids and no address points. That is a checked negative from the catalogue, not an assumption.
 *
 * So the real options are three, and only one of them is free:
 *
 * (a) LICENCE POINTER FROM LPS. The authoritative NI address database, ~1 M points with UPRNs. The OSNI mapshop lists
 * full NI coverage at £9,224 excl. VAT; orders over £3,000 need a formal licence application with a ≥12-month term.
 * This is the ONLY route to complete NI centroids in a permissively-licensed package. (b) SHIP NI AS ODbL from
 * OpenStreetMap `addr:postcode`. Coverage is partial and uneven, and ODbL's share-alike would infect the artifact — the
 * same posture `@mailwoman/osm` already sits in, awaiting counsel. Note the OSM community explicitly forbids importing
 * LPS/ONSPD centroids into OSM, so this cannot be laundered. (c) SHIP NO NI POSTCODE CENTROIDS. Fall back to the
 * OGL-clean OSNI Streetnames gazetteer (every NI street with Irish Grid coordinates) for street-level NI resolution.
 *
 * **(b) LANDED 2026-08-05, at the build-local tier** — `../ni-osm-shard.ts`, `mailwoman gazetteer build
 * postcode-ni-osm`. The share-alike problem is solved by not publishing: the shard is built on the operator's own
 * machine and reaches the resolver only through `DEFAULT_POSTCODE_SHARDS`'s `existsSync` filter, so no npm consumer
 * ever receives an ODbL byte. Measured coverage is 4,757 of the 50,032 live NI postcodes (9.5 %), across 250 of 886
 * sectors and 80 of 80 districts, from 12,327 OSM address elements. Partial, and additive rather than risky: since
 * #1480 an unknown postcode ABSTAINS, so a `BT` code the shard lacks behaves exactly as it did when there was no shard
 * at all.
 *
 * THIS shard — Code-Point Open, the published one — still does (c), and must: its `BT` hole is a licensing fact and
 * filling it from an ODbL source would be exactly the contamination the tier split exists to prevent. Scale of what (c)
 * gives up: ONSPD Feb 2025 counts 50,032 LIVE NI postcodes (62,980 including terminated). The incumbent GeoNames
 * snapshot's 48,990 BT rows sit between the May 2020 and May 2021 live figures, i.e. a live-only extract roughly five
 * years stale and ~2 % short of current.
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
	"street-level NI resolution. (c) is what THIS shard does and must keep doing — its BT hole is a licensing fact, and " +
	"filling it from an ODbL source would contaminate a published artifact. (b) landed separately on 2026-08-05 as the " +
	"BUILD-LOCAL shard postalcode-ni-osm.db (`mailwoman gazetteer build postcode-ni-osm`), which is never published and " +
	"covers 4,757 of the 50,032 live NI postcodes (9.5 %), 250/886 sectors, 80/80 districts. Scale: ONSPD Feb 2025 " +
	"counts 50,032 live NI postcodes."

/**
 * Build the OS Downloads API client.
 *
 * `APIClient` per `AGENTS.md`: these are small JSON API requests, which is exactly the population the rule binds.
 * Pacing is set anyway even though OS publishes no documented limit for the open Downloads API — two requests per
 * acquisition cannot approach any ceiling, and an unpaced client is a trap for the next caller who loops it. Retry is
 * bounded because a transient 5xx on a metadata call should not fail a 14 MB acquisition that has not started yet.
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
 * List the downloadable archives. Two entries as of 2026-05: CSV and GeoPackage, both whole-GB.
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

export interface DownloadCodePointOptions {
	/**
	 * Directory the archive lands in. The caller owns it — the convention is a NEW dated directory per acquisition
	 * (`$MAILWOMAN_DATA_ROOT/codepoint/<YYYY-MM-DD>/`) so an acquisition never overwrites an earlier one.
	 */
	destDir: string
	/**
	 * Which archive to take. `CSV` is what the shard builder parses; `GeoPackage` carries the same rows behind a GDAL
	 * dependency we do not need.
	 */
	format?: "CSV" | "GeoPackage"
	/**
	 * Reuse an existing client (and its pacer) instead of constructing one.
	 */
	client?: APIClient
	/**
	 * Skip the download when the destination already exists AND matches the upstream md5. The default. Set `false` to
	 * force a re-pull.
	 */
	reuseExisting?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

export interface DownloadCodePointResult {
	/**
	 * Absolute path of the downloaded archive.
	 */
	archivePath: string
	/**
	 * Bytes on disk.
	 */
	bytes: number
	/**
	 * Md5 computed from the bytes we wrote — verified equal to {@link CodePointDownload.md5}.
	 */
	md5: string
	/**
	 * OS's release label for the product at acquisition time.
	 */
	version: string
	/**
	 * The Downloads API record this came from.
	 */
	download: CodePointDownload
	/**
	 * True when the bytes were already on disk and matched, so no request was made.
	 */
	reused: boolean
}

/**
 * Download the Code-Point Open archive into `destDir`, verifying it against OS's published md5.
 *
 * RAW `fetch` FOR THE ARCHIVE BODY IS DELIBERATE, and `AGENTS.md` draws exactly this line: the rule binds API requests
 * — small bodies, repeated calls, rate-limited hosts — and the two metadata GETs above honour it through
 * {@link createOSDownloadsClient}. The archive is a file transfer streamed to disk. Caching a 14 MB body in the response
 * cache is pointless when the dated directory IS the cache, there is one request to pace, and axios buffers a
 * non-stream response type in memory. Same call as `osm/sdk/fetch.ts` and `tiger/sdk/download.ts`.
 *
 * The md5 check is not ceremony. A truncated or CDN-corrupted archive still unzips far enough to yield plausible CSVs,
 * and the failure would surface as a quietly short postcode count in a 1.7 M-row shard — the kind of defect that reads
 * as a data change rather than a transfer error.
 */
export async function downloadCodePointOpen(options: DownloadCodePointOptions): Promise<DownloadCodePointResult> {
	const { destDir, format = "CSV", reuseExisting = true } = options
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

	await mkdir(destDir, { recursive: true })
	const archivePath = String(join(destDir, download.fileName))

	if (reuseExisting) {
		const existing = await md5File(archivePath).catch(() => null)

		if (existing === download.md5) {
			phase("reuse", `${download.fileName} already matches upstream md5`)

			return { archivePath, bytes: download.size, md5: existing, version: product.version, download, reused: true }
		}
	}

	phase("download", `${download.fileName} (${download.size.toLocaleString()} bytes)`)

	// Raw `fetch`: an OS Code-Point Open archive, streamed to disk below rather than held in memory.
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

	await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(archivePath))

	phase("verify", `md5 vs OS-published ${download.md5}`)
	const md5 = await md5File(archivePath)

	if (md5 !== download.md5) {
		throw new Error(
			`downloadCodePointOpen: md5 mismatch for ${download.fileName} — OS published ${download.md5}, ` +
				`downloaded bytes hash to ${md5} (${bytes.toLocaleString()} of an expected ${download.size.toLocaleString()})`
		)
	}

	// The sidecar makes the archive self-describing on disk: a later reader can tell WHICH OS release these
	// bytes are without re-querying an API whose answer will have moved on.
	await writeFile(`${archivePath}.md5`, `${md5}  ${download.fileName}\n`, "utf8")

	await writeFile(
		String(join(destDir, "acquisition.json")),
		`${JSON.stringify({ product, download, bytes, md5, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
		"utf8"
	)

	return { archivePath, bytes, md5, version: product.version, download, reused: false }
}
