/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch GeoNames per-country GAZETTEER dumps — the 19-column `<CC>.txt` files under
 *   `https://download.geonames.org/export/dump/` (NOT the postal exports; those are `export/zip/` and
 *   `geonames-postal.ts`'s job). The dumps carry feature classes and codes (column 8: `PPLC` national capital,
 *   `PPLA` first-order administrative seat), which is what the capitals reference build consumes (#1880).
 *
 *   The catalog question is answered by the SOURCE, not by an ISO list: `countryInfo.txt` in the same directory
 *   enumerates every country GeoNames publishes, one row per ISO alpha-2 code, and also names each country's
 *   capital — the cross-check the capitals build grades its `PPLC` extraction against. Fetch that first; derive
 *   the country set from it; then a dump absent from disk is a measured gap against the source's own catalog
 *   rather than a silent hole. The dump directory may hold files this tool did not fetch: present files are never
 *   overwritten, and a present `<CC>.txt` that is NOT a 19-column gazetteer dump (GeoNames' postal exports share
 *   the basename) is reported as `wrong_format_present`, never counted as coverage.
 */

import { pathExists, readFileHead, readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/utils"
import { join } from "@mailwoman/platform/path"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, HTTPStatusError, writeManifest } from "./download.ts"

/**
 * The one status that means "the source does not publish this country" rather than "the transfer failed".
 */
const HTTP_NOT_FOUND = 404

const SLUG = "geonames-dump"

/**
 * GeoNames' gazetteer-dump directory — one zip per ISO alpha-2 code holding `<CC>.txt`, plus `countryInfo.txt` as a
 * bare text file.
 */
const BASE_URL = "https://download.geonames.org/export/dump"

export interface FetchGeonamesDumpOptions extends BaseFetchOptions {
	/**
	 * ISO alpha-2 codes, any casing. Absent → every country `countryInfo.txt` enumerates.
	 */
	countries?: readonly string[]
	/**
	 * Dump directory to read from. Defaults to GeoNames' own; exists so the 404 and coverage behaviour can be exercised
	 * against a local server.
	 */
	baseURL?: string
	/**
	 * Refetch a dump whose `<CC>.txt` already exists. Default false — the tool fills gaps.
	 */
	force?: boolean
}

interface GeonamesDumpFileEntry {
	country: string
	filename: string
	source_url: string
	sha256: string
	bytes: number
}

export interface GeonamesDumpManifest {
	source: string
	base_url: string
	license: string
	attribution: string
	downloaded_at: string
	files: GeonamesDumpFileEntry[]
	/**
	 * `<CC>.txt` files already on disk and left alone — the hand-fetched population this tool extends.
	 */
	skipped_present: string[]
	/**
	 * Countries in the source catalog that the source's dump directory nonetheless 404s — a fact about the source,
	 * recorded so a later reader does not spend the fetch to rediscover it.
	 */
	unavailable: string[]
	/**
	 * Present `<CC>.txt` files that are NOT 19-column gazetteer dumps — GeoNames' postal exports share the same basename,
	 * and seven tier-1 postal files sat at these paths reading as "present" until the capitals build found them
	 * capital-less. Left in place (this tool never overwrites data it did not fetch); the fix is to move the file to its
	 * own home and rerun.
	 */
	wrong_format_present: string[]
}

/**
 * Column count of a gazetteer dump row — the discriminator against GeoNames' 12-column postal exports, which share the
 * `<CC>.txt` basename.
 */
const GAZETTEER_DUMP_COLUMNS = 19

/**
 * True when the first non-empty line carries the gazetteer dump's 19 tab-separated columns. Accepts a partial head read
 * — the first line is the whole question, so callers need not hand it a resident 350 MB dump.
 *
 * Walk the string directly rather than constructing a spliterator: the capitals builder already holds whole country
 * dumps as strings, and a byte-oriented spliterator would UTF-8 encode that input — allocating up to another 350 MB —
 * merely to inspect its first non-empty line.
 */
export function looksLikeGazetteerDump(text: string): boolean {
	let start = 0

	while (start < text.length) {
		const end = text.indexOf("\n", start)
		const line = end === -1 ? text.slice(start) : text.slice(start, end)

		if (line.trim()) {
			let tabs = 0

			for (let i = line.indexOf("\t"); i !== -1; i = line.indexOf("\t", i + 1)) {
				tabs++
			}

			return tabs === GAZETTEER_DUMP_COLUMNS - 1
		}

		if (end === -1) break

		start = end + 1
	}

	return false
}

/**
 * Parse the ISO codes (column 1) and capital names (column 6) out of `countryInfo.txt` — `#`-prefixed lines are the
 * file's own commentary.
 */
export function parseCountryInfo(text: string): Array<{ country: string; capital: string }> {
	const rows: Array<{ country: string; capital: string }> = []

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- countryInfo.txt is ~40 KB, one row per country on Earth; it cannot grow past that
	for (const line of text.split("\n")) {
		if (line.startsWith("#") || !line.trim()) continue

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- one bounded 19-column catalog row
		const cols = line.split("\t")
		const country = cols[0]?.trim().toUpperCase()

		if (country?.length === 2) {
			rows.push({ country, capital: cols[5]?.trim() ?? "" })
		}
	}

	return rows
}

/**
 * Bytes read to classify a present file: enough to cover a first dump row whose alternate-names column runs long (they
 * reach several KB), a fraction of the largest dumps (US.txt is ~350 MB).
 */
const FORMAT_SNIFF_BYTES = 65_536

/**
 * Download `countryInfo.txt` plus every missing `<CC>.zip`, extracting each to `<outRoot>/<CC>.txt` beside the
 * hand-fetched dumps, with a `MANIFEST.json` naming fetched, skipped-present, and source-unavailable countries.
 */
export async function fetchGeonamesDumps(
	options: FetchGeonamesDumpOptions,
	report?: (line: string) => void
): Promise<FetchSummary & { skippedPresent: string[] }> {
	await makeDirectories(options.outRoot)

	const baseURL = options.baseURL ?? BASE_URL
	const countryInfoDest = join(options.outRoot, "countryInfo.txt")

	await downloadToFile({
		url: `${baseURL}/countryInfo.txt`,
		dest: countryInfoDest,
		timeoutMs: 120_000,
		retries: 2,
		report,
	})

	const catalog = parseCountryInfo(await readLocalTextFile(countryInfoDest))
	const countries = options.countries?.map((code) => code.trim().toUpperCase()) ?? catalog.map((row) => row.country)

	const entries: GeonamesDumpFileEntry[] = []
	const failedCodes: string[] = []
	const unavailable: string[] = []
	const skippedPresent: string[] = []
	const wrongFormatPresent: string[] = []
	let fetched = 0

	for (const country of countries) {
		const txtDest = join(options.outRoot, `${country}.txt`)

		if (!options.force && (await pathExists(txtDest))) {
			if (looksLikeGazetteerDump(await readFileHead(txtDest, FORMAT_SNIFF_BYTES))) {
				skippedPresent.push(country)
			} else {
				report?.(`✗ ${country}.txt is present but is not a 19-column gazetteer dump — move it aside and rerun`)
				wrongFormatPresent.push(country)
			}

			continue
		}

		const filename = `${country}.zip`
		const url = `${baseURL}/${filename}`
		const zipDest = join(options.outRoot, filename)

		report?.(`=== ${SLUG} / ${country}`)

		try {
			await downloadToFile({ url, dest: zipDest, timeoutMs: 300_000, retries: 2, report })
			await extractZipEntry(zipDest, `${country}.txt`, txtDest)
			await removePathIfPresent(zipDest)

			entries.push({
				country,
				filename: `${country}.txt`,
				source_url: url,
				sha256: await sha256File(txtDest),
				bytes: (await readLocalBuffer(txtDest)).byteLength,
			})

			fetched++
		} catch (error) {
			await removePathIfPresent(zipDest)

			const message = error instanceof Error ? error.message : String(error)

			// Branch on the TYPED status (the geonames-postal lesson): message prose contains the URL, and a URL
			// can contain any substring.
			if (error instanceof HTTPStatusError && error.status === HTTP_NOT_FOUND) {
				report?.(`✗ ${country}: GeoNames publishes no gazetteer dump for this country`)
				unavailable.push(country)
			} else {
				report?.(`✗ ${country}: ${message}`)
			}

			failedCodes.push(country)
		}
	}

	const manifest: GeonamesDumpManifest = {
		source: SLUG,
		base_url: baseURL,
		license: "CC-BY-4.0",
		attribution: "GeoNames",
		downloaded_at: new Date().toISOString(),
		files: entries,
		skipped_present: skippedPresent.toSorted(),
		unavailable,
		wrong_format_present: wrongFormatPresent.toSorted(),
	}

	await writeManifest(join(options.outRoot, "MANIFEST.json"), manifest)

	return { fetched, skipped: skippedPresent.length, failed: failedCodes.length, failedCodes, skippedPresent }
}
