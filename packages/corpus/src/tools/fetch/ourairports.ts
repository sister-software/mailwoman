/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the OurAirports CSV dumps — the VENUE side of the sub-venue corpus arc (#35).
 *
 *   Source : https://davidmegginson.github.io/ourairports-data/ (the project's own GitHub Pages
 *            mirror of the nightly export; `ourairports.com/data/` redirects here).
 *   License: PUBLIC DOMAIN. OurAirports places its data in the public domain and asks only for a
 *            courtesy credit — no attribution obligation rides on a derived shard, which makes this
 *            the one transport source in the arc with no licensing question at all. Tier A.
 *
 *   ## What it is good for, and what it is not
 *
 *   `airports.csv` is every airport on earth with ICAO/IATA codes, coordinates, `municipality`, and
 *   `iso_country` — 12.7 MB, ~83,000 rows as of 2026-08-04. That is the CONTAINING VENUE for a
 *   `<sub-venue>, <venue>, <street>, <locality>, <postcode>` corpus line, and it is better at that job
 *   than OSM: every row is named, the name is canonical, and `municipality` gives the locality without
 *   a spatial join.
 *
 *   It carries NO interior structure. There is no terminal, concourse, gate or pier table — the
 *   corpus task says as much ("Good for the venue side of each pair, weaker on interior structure")
 *   and a row-level read confirms it. Pair it with the OSM `aeroway` extractor
 *   (`@mailwoman/osm/sdk`'s `extractOSMSubVenues`), which is where the sub-venue half comes from.
 *
 *   ## Why `downloadToFile` and not `APIClient`
 *
 *   `AGENTS.md` routes HTTP through `APIClient`, and that rule is about API REQUESTS — small bodies,
 *   repeated calls, rate-limited hosts. This is four static file transfers against a GitHub Pages CDN
 *   with no rate limit and nothing to pace, run once per refresh. It uses the same `downloadToFile`
 *   every other module in this `fetch/` family uses, which is where the retry and timeout live.
 *   The Wikidata sibling (`wikidata-subvenue.ts`) IS an API client and is built on `APIClient`
 *   accordingly; the split between the two is the one `AGENTS.md` draws.
 *
 *   Invoke via `mailwoman corpus fetch ourairports --out-root <path>`.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, writeManifest } from "./download.ts"

const SLUG = "ourairports"

/**
 * The GitHub Pages mirror the project itself publishes. `ourairports.com/data/*.csv` 302s here, so pointing at the
 * mirror directly saves a redirect and is the URL the project's own README gives.
 */
const BASE_URL = "https://davidmegginson.github.io/ourairports-data"

/**
 * The files worth having, and why each one.
 *
 * `airports.csv` is the payload. The other three are small joins that turn its codes into text: `countries.csv` and
 * `regions.csv` expand `iso_country`/`iso_region` into names (a corpus line needs "Germany", not "DE"), and
 * `runways.csv` is the only file carrying per-airport sub-structure of any kind — runway designators, which are NOT
 * sub-venue designators (nobody addresses mail to a runway) but are worth having on disk as the negative class if the
 * shard ever needs one.
 */
const FILES = ["airports.csv", "countries.csv", "regions.csv", "runways.csv"] as const

export type FetchOurAirportsOptions = BaseFetchOptions

interface OurAirportsFileEntry {
	filename: string
	source_url: string
	sha256: string
	bytes: number
	/**
	 * The upstream `Last-Modified`, when the CDN gave one. This is the DATA's vintage; `downloaded_at` is only when we
	 * asked. `corpus/AGENTS.md` has the standing warning that a file's mtime is not its data's vintage — recording the
	 * upstream header is how a later refresh decision gets made on the right number.
	 */
	last_modified: string | null
}

interface OurAirportsManifest {
	source: string
	base_url: string
	license: string
	downloaded_at: string
	files: OurAirportsFileEntry[]
}

/**
 * Read the upstream `Last-Modified` with a HEAD. Returns `null` on any failure — provenance metadata is nice to have
 * and must never fail a download that otherwise succeeded.
 */
async function readLastModified(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) })

		return res.ok ? res.headers.get("last-modified") : null
	} catch {
		return null
	}
}

/**
 * Download the OurAirports CSVs into `<outRoot>/ourairports/`, with a sibling `MANIFEST.json` carrying each file's
 * origin URL, sha256, byte count and upstream `Last-Modified`.
 */
export async function fetchOurAirports(
	options: FetchOurAirportsOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })

	const entries: OurAirportsFileEntry[] = []
	const failedCodes: string[] = []
	let fetched = 0
	let failed = 0

	for (const filename of FILES) {
		const url = `${BASE_URL}/${filename}`
		const dest = join(destDir, filename)

		report?.(`=== ${SLUG} / ${filename}`)

		try {
			const [{ bytes }, lastModified] = await Promise.all([
				downloadToFile({
					url,
					dest,
					timeoutMs: 600_000,
					retries: 2,
					headers: { "Accept-Encoding": "gzip, br" },
					report,
				}),
				readLastModified(url),
			])

			entries.push({
				filename,
				source_url: url,
				sha256: await sha256File(dest),
				bytes,
				last_modified: lastModified,
			})

			fetched++
		} catch (error) {
			report?.(`✗ ${filename}: ${error instanceof Error ? error.message : String(error)}`)
			failedCodes.push(filename)

			failed++
		}
	}

	const manifest: OurAirportsManifest = {
		source: "OurAirports",
		base_url: BASE_URL,
		license: "public domain (courtesy credit requested)",
		downloaded_at: new Date().toISOString(),
		files: entries,
	}

	await writeManifest(join(destDir, "MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
