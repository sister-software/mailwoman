/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the GeoNames per-country postal-code exports — the only source in this family that carries a
 *   `(postcode, locality, region)` triple with the NAMES inline.
 *
 *   Source : https://download.geonames.org/export/zip/<CC>.zip
 *   License: CC-BY-4.0, attribute "GeoNames". Tier B.
 *
 *   ## Why this source and not a join
 *
 *   A postcode slice is only useful to the corpus if a postcode reaches a locality and a region. Two routes exist and
 *   only one of them works everywhere:
 *
 *   - **`parent_id`** — `postalcode-intl.db` carries a real parent that resolves in the admin gazetteer (measured: NL
 *     97.5% of rows linked, FR 90.7%, DE 66.1%, ES 34.9%, IT 27.4%, and 93.8–100% of those resolve to a
 *     `locality`/`localadmin`). It is also the ONLY slice that does: `postalcode-geonames-intl.db` and every
 *     `postalcode-<cc>-overture.db` carry `parent_id = 0` on every row, so five countries have this route and the rest
 *     have none.
 *   - **Nearest locality centroid** — the obvious fallback, and it does not work. Scored against the `parent_id` truth
 *     on 1,000–1,500 postcodes per country: NL 81.1%, DE 44.7%, ES 35.1%, FR 29.0%, IT 13.5%. A locality's centroid
 *     sits at its middle, so a postcode near the edge is routinely closer to a neighbouring town's centroid than to its
 *     own. Under 50% for four of the five, which is not a join.
 *
 *   The GeoNames export sidesteps both: columns 3 and 4 ARE the place and admin1 names, so there is nothing to join and
 *   nothing to approximate. `@mailwoman/corpus`'s `geonames-postal` adapter consumes it directly.
 *
 *   ## Coverage is not universal, and the gap is the point
 *
 *   GeoNames publishes ~80 countries, NOT all of them. Venezuela returns 404 — so a VE postcode slice cannot be built
 *   from this source at any effort, and that is an acquisition question rather than a build one. Ask for a country
 *   before assuming it is there; an absent country fails as one entry, never as the whole run.
 *
 *   ## Row counts from this source overstate, for some countries by exactly 2×
 *
 *   Countries whose postcode format contains a hyphen are published TWICE — once `3750-000`, once `3750000`. Measured
 *   on the slice built from this source: PT 395,544 rows over 197,772 distinct codes and PL 40,598 over 20,299, both
 *   exactly 2.00×, while AU, CZ and AT (no hyphen in the format) are 1.00×. A consumer sizing a slice from the row
 *   count doubles its estimate for those countries.
 *
 *   ## Why `downloadToFile` and not `APIClient`
 *
 *   Same split `AGENTS.md` draws and the `ourairports` sibling explains: these are static file transfers from a plain
 *   file host, run once per refresh. The pacing, retry and caching `APIClient` exists for have nothing to act on here.
 *
 *   Invoke via `mailwoman corpus fetch geonames-postal --countries pt,au,nz`.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/utils"
import { join } from "path-ts"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { downloadToFile, HTTPStatusError, writeManifest } from "#tools/fetch/download"

/**
 * The one status that means "the source does not publish this country" rather than "the transfer failed".
 */
const HTTP_NOT_FOUND = 404

const SLUG = "geonames-postal"

/**
 * GeoNames' own export directory. One zip per ISO alpha-2 code, each holding `<CC>.txt` plus the shared `readme.txt`.
 */
const BASE_URL = "https://download.geonames.org/export/zip"

/**
 * Countries fetched when the caller names none.
 *
 * These are the ones the corpus wants and cannot get from `postalcode-intl.db`'s `parent_id` route — see the header for
 * why that route covers exactly five countries. Venezuela is deliberately absent because GeoNames does not publish it.
 */
export const GEONAMES_POSTAL_DEFAULT_COUNTRIES = ["PT", "AU", "NZ", "IE", "BR", "ZA", "MX"] as const

export interface FetchGeonamesPostalOptions extends BaseFetchOptions {
	/**
	 * ISO alpha-2 codes, in any casing. Defaults to {@linkcode GEONAMES_POSTAL_DEFAULT_COUNTRIES}.
	 */
	countries?: readonly string[]
	/**
	 * Export directory to read from. Defaults to GeoNames' own. Exists so the 404-is-a-coverage-finding behaviour can be
	 * exercised against a local server rather than by asking GeoNames for a country it does not have.
	 */
	baseURL?: string
}

interface GeonamesPostalFileEntry {
	country: string
	filename: string
	source_url: string
	sha256: string
	bytes: number
}

interface GeonamesPostalManifest {
	source: string
	base_url: string
	license: string
	attribution: string
	downloaded_at: string
	files: GeonamesPostalFileEntry[]
	/**
	 * Countries asked for and NOT published by GeoNames, recorded so a later reader does not spend the fetch again to
	 * rediscover it. An absence here is a fact about the source, not about the run.
	 */
	unavailable: string[]
}

/**
 * Download the requested GeoNames postal zips into `<outRoot>/geonames-postal/`, with a sibling `MANIFEST.json`
 * carrying each file's origin URL, sha256 and byte count, plus the countries the source does not publish.
 *
 * A country the source does not carry is counted as failed and named in `failedCodes` — it does not stop the rest.
 */
export async function fetchGeonamesPostal(
	options: FetchGeonamesPostalOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)

	const countries = (options.countries ?? GEONAMES_POSTAL_DEFAULT_COUNTRIES).map((code) => code.trim().toUpperCase())
	const baseURL = options.baseURL ?? BASE_URL
	const retryDelayMs = options.retryDelayMs
	const entries: GeonamesPostalFileEntry[] = []
	const failedCodes: string[] = []
	const unavailable: string[] = []
	let fetched = 0
	let failed = 0

	for (const country of countries) {
		const filename = `${country}.zip`
		const url = `${baseURL}/${filename}`
		const dest = join(destDir, filename)

		report?.(`=== ${SLUG} / ${country}`)

		try {
			const { bytes } = await downloadToFile({ url, dest, timeoutMs: 300_000, retries: 2, retryDelayMs, report })

			entries.push({ country, filename, source_url: url, sha256: await sha256File(dest), bytes })

			fetched++
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)

			// A 404 here means GeoNames does not publish the country at all, which is a different finding from a failed
			// transfer and the one a caller planning a slice needs to see. Branch on the TYPED status: matching message
			// prose classified a 500 as "unpublished" whenever the URL happened to contain the substring 404 — an
			// ephemeral test-server port did exactly that in CI.
			if (error instanceof HTTPStatusError && error.status === HTTP_NOT_FOUND) {
				report?.(`✗ ${country}: GeoNames does not publish a postal export for this country`)
				unavailable.push(country)
			} else {
				report?.(`✗ ${country}: ${message}`)
			}

			failedCodes.push(country)

			failed++
		}
	}

	const manifest: GeonamesPostalManifest = {
		source: "GeoNames postal codes",
		base_url: baseURL,
		license: "CC-BY-4.0",
		attribution: "GeoNames",
		downloaded_at: new Date().toISOString(),
		files: entries,
		unavailable,
	}

	await writeManifest(join(destDir, "MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
