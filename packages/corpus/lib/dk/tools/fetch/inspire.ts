/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch Denmark's INSPIRE Addresses GeoPackage for the `dk-inspire` adapter.
 *
 * Denmark is one of the member states that serves the Addresses (AD) theme as a predefined-dataset
 * ATOM feed rather than as a WFS, so `#tools/fetch/inspire-addresses` — which pages a WFS and joins
 * its feature types locally — does not reach it. This module reads the feed, downloads the one
 * dataset it offers and extracts the GeoPackage.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`, so
 * this module sits beside `#fr/tools/fetch/ban` rather than in an `sdk/` root the workspace does
 * not declare.
 *
 * Klimadatastyrelsen states CC BY 4.0 for this theme, and the address-source register elects it. The
 * model card must attribute Klimadatastyrelsen.
 *
 * Five properties of this host were measured, and each one breaks a reader that assumes otherwise:
 *
 * 1. `content-length` on the feed is the gzip-compressed length. The header reports 1,455 while 3,130
 *    bytes are delivered, so a reader that trusts it truncates the feed. Every byte count here is
 *    counted off the delivered body.
 * 2. The entry's `rel="alternate"` href is a Wing FTP weblink landing page, HTTP 200 `text/html`,
 *    3,811 bytes. The file needs `&realfilename=DK_INSPIRE_Addresses.zip` appended. That query answers
 *    HTTP 200 `application/zip`.
 * 3. The host ignores `Range`. `bytes=0-4095` answers HTTP 200 with no `content-range` and the whole
 *    101 MB body, so the one-byte range GET that sizes an OpenAddresses source cannot be used here.
 * 4. The entry's own `length="4291699"` understates the real 101,406,038 bytes by 23 times. The
 *    download is never sized from the feed.
 * 5. The feed's `<updated>` is 2020-12-24 and the entry's 2022-10-06, both stale against the file's
 *    own 2026-09-27 modification date, so a freshness check cannot read the feed's timestamps. This
 *    module compares the downloaded zip's sha256 against its manifest instead.
 *
 * The linked OpenSearch description parameterises only `spatial_dataset_identifier_code`, `crs` and
 * `language`, and offers no spatial subsetting, so there is no way to fetch part of Denmark. The
 * feed holds one entry covering the whole country.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { childElement, childElements, type MarkupElement, streamMarkupElements } from "@mailwoman/core/html/elements"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { readManifest, streamBodyToFile, writeManifest } from "#tools/fetch/download"

/**
 * The ATOM service document for Denmark's Addresses theme.
 */
export const DK_ADDRESSES_FEED_URL = "https://www2.sdfe.dk/INSPIRE/feeds/Addresses.xml"

/**
 * The adapter slug this module fetches for, and the directory it writes under.
 */
const SLUG = "dk-inspire"

/**
 * The zip member the adapter reads.
 */
export const DK_ADDRESSES_GEOPACKAGE_MEMBER = "ad_inspire.gpkg"

/**
 * The query parameter that turns the entry's weblink landing page into the file itself.
 *
 * Wing FTP serves the file only when the request asks for the member.
 */
const REAL_FILENAME_PARAMETER = "realfilename"

/**
 * The smallest plausible zip.
 * Anything smaller is an error page rather than the dataset.
 *
 * The real file is 101,406,038 bytes, and this floor only separates a body from a page.
 */
const MINIMUM_DATASET_BYTES = 1_000_000

/**
 * What the feed states about its one dataset.
 */
export interface AddressesFeedEntry {
	/**
	 * The entry's title, `DK INSPIRE Addresses` in the measured feed.
	 */
	title: string
	/**
	 * The download URL, with the member in the query so the host serves the file.
	 */
	downloadURL: string
	/**
	 * The media type the entry advertises, `application/geopackage+sqlite3` in the measured feed.
	 */
	mediaType: string | null
}

/**
 * Read the one dataset entry out of the feed.
 *
 * Parsed with `@mailwoman/core/html/elements` rather than matched with a pattern.
 *
 * The feed needs both of the things a pattern handles badly.
 * Its entry tag has an `xml:lang` attribute, so a reader has to keep attributes.
 *
 * Its hrefs escape the ampersand between query parameters, so a reader has to decode entities.
 *
 * The parser does both.
 * XML mode is required: the entry's links self-close, and HTML mode leaves them open.
 *
 * @param xml The whole feed, 3,130 bytes, taken as one string rather than as a stream.
 * @throws When the feed holds no entry, or its entry no usable link.
 * A feed holding neither reads as a change at the publisher.
 * A caller has to see that.
 */
export async function readAddressesFeed(xml: string, feedURL: string): Promise<AddressesFeedEntry> {
	async function* oneChunk(): AsyncIterable<string> {
		yield xml
	}

	// The feed holds one entry covering the whole country, so the first is the dataset.
	let entry: MarkupElement | null = null

	for await (const found of streamMarkupElements(oneChunk(), "entry", { xml: true })) {
		entry ??= found
	}

	if (!entry) {
		throw new Error(`${feedURL}: the feed holds no <entry>, so the dataset it offers could not be read.`)
	}

	const title = childElement(entry, "title")?.text ?? ""

	// The alternate link is the dataset.
	// The same entry also has a `describedby` link to the ISO 19139 record.
	// Either would download as a dataset without this check.
	const alternate = childElements(entry, "link").find(
		(link: MarkupElement) => (link.attributes.rel ?? "").toLowerCase() === "alternate"
	)

	if (!alternate) {
		throw new Error(
			`${feedURL}: the entry titled "${title}" carries no rel="alternate" link, so its dataset URL could not be read.`
		)
	}

	const href = alternate.attributes.href

	if (!href) {
		throw new Error(`${feedURL}: the entry titled "${title}" carries an alternate link with no href.`)
	}

	return {
		title,
		// The parser decodes `&amp;` in an attribute value, so the href arrives with
		// its query parameters already separated by a bare `&`.
		downloadURL: datasetURLOf(href),
		mediaType: alternate.attributes.type ?? null,
	}
}

/**
 * Name the zip member on a weblink URL, so the host serves the file instead of its landing page.
 *
 * A URL that already names one is answered unchanged, so a publisher that starts writing
 * the complete URL into the feed does not get the parameter twice.
 */
export function datasetURLOf(href: string): string {
	if (href.includes(`${REAL_FILENAME_PARAMETER}=`)) return href

	return `${href}&${REAL_FILENAME_PARAMETER}=${encodeURIComponent("DK_INSPIRE_Addresses.zip")}`
}

export type FetchDKAddressesOptions = BaseFetchOptions

/**
 * Download Denmark's Addresses GeoPackage and leave it beside a manifest recording its sha256.
 *
 * Re-runnable: a run whose manifest sha256 still matches the extracted GeoPackage
 * reuses that file and makes no request.
 */
export async function fetchDKAddresses(
	options: FetchDKAddressesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)

	await makeDirectories(destDir)

	const gpkgDest = destDir(DK_ADDRESSES_GEOPACKAGE_MEMBER)
	const zipDest = destDir("DK_INSPIRE_Addresses.zip")
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}`)

	// MARK: Idempotency check
	//
	// The feed's own timestamps are older than the file it serves, so they cannot decide this.
	// The extracted GeoPackage's digest can.

	const recorded = await readManifest<Partial<SourceManifest>>(manifestPath)

	if (recorded?.sha256 && recorded.filename) {
		const recordedPath = destDir(recorded.filename)

		if ((await pathExists(recordedPath)) && (await sha256File(recordedPath)) === recorded.sha256) {
			report?.("  ✓ Already current (sha256 matches MANIFEST) — skipping download.")

			return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
		}
	}

	// MARK: Read the feed

	report?.(`  Reading ${DK_ADDRESSES_FEED_URL} ...`)

	const feedResponse = await fetch(DK_ADDRESSES_FEED_URL, { redirect: "follow" })

	if (!feedResponse.ok) {
		report?.(`  ✗ HTTP ${feedResponse.status} reading the feed`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// `text()` reads the whole decoded body.
	// The `content-length` header on this host reports the compressed length,
	// so it is neither read nor checked against what arrived.
	const xml = await feedResponse.text()

	// Characters rather than bytes: the feed's 3,130 bytes decode to 3,125 characters,
	// because the Danish text in it is multi-byte.
	// Its content-length header reports the compressed length, 1,455, rather than either of those.
	report?.(`  Feed decoded to ${xml.length} characters`)

	const entry = await readAddressesFeed(xml, DK_ADDRESSES_FEED_URL)

	report?.(`  Entry: ${entry.title} (${entry.mediaType ?? "no advertised type"})`)
	report?.(`  Dataset: ${entry.downloadURL}`)

	// MARK: Download the dataset
	//
	// Streamed rather than buffered, and the byte count comes from the body
	// rather than from the entry's `length` attribute.
	// That attribute understates the file by 23 times.

	const datasetResponse = await fetch(entry.downloadURL, { redirect: "follow" })

	if (!datasetResponse.ok) {
		report?.(`  ✗ HTTP ${datasetResponse.status} downloading the dataset`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const contentType = datasetResponse.headers.get("content-type") ?? ""

	// The bare weblink href answers HTTP 200 `text/html` with a landing page.
	// A write to disk would fail later as a corrupt zip.
	if (contentType.includes("text/html")) {
		report?.(`  ✗ The dataset URL answered ${contentType}, which is the weblink's landing page rather than the file`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const zipBytes = await streamBodyToFile(datasetResponse, zipDest)

	report?.(`  Downloaded: ${ByteFormatter.formatIEC(zipBytes)} (${zipBytes} bytes)`)

	if (zipBytes < MINIMUM_DATASET_BYTES) {
		report?.(`  ✗ Response too small (${zipBytes} bytes) — probable error page`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// MARK: Extract the GeoPackage

	const entries = await listZipEntries(zipDest)
	const member = entries.find((zipEntry) => zipEntry.name.endsWith(".gpkg"))

	if (!member) {
		report?.("  Members in the archive:")

		for (const zipEntry of entries) {
			report?.(`    ${zipEntry.name}`)
		}

		report?.("  ✗ The archive holds no .gpkg member — inspect the listing above and update this module")

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Extracting ${member.name} (${ByteFormatter.formatIEC(member.uncompressedSize)}) ...`)

	await extractZipEntry(zipDest, member.name, gpkgDest)

	const gpkgSize = (await statPath(gpkgDest)).size
	const gpkgSha = await sha256File(gpkgDest)

	await removePathIfPresent(zipDest)

	report?.("  Removed the archive (the GeoPackage is kept)")

	// MARK: Write the manifest

	const manifest: SourceManifest = {
		source_url: entry.downloadURL,
		downloaded_at: new Date().toISOString(),
		filename: DK_ADDRESSES_GEOPACKAGE_MEMBER,
		sha256: gpkgSha,
		bytes: gpkgSize,
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${ByteFormatter.formatIEC(gpkgSize)}  sha256=${gpkgSha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
