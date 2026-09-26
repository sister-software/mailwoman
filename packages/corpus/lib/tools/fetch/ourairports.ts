/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch the OurAirports CSV dumps — the venue side of the sub-venue corpus arc.
 *
 * Source: https://davidmegginson.github.io/ourairports-data
 * License: public domain, with a courtesy credit requested.
 */

import { APIClient } from "@mailwoman/core/api"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download/index"
import { downloadToFile, writeManifest } from "#tools/fetch/download/index"

const SLUG = "ourairports"

/**
 * The project's own GitHub Pages mirror, which `ourairports.com/data/*.csv` redirects to.
 */
const BASE_URL = "https://davidmegginson.github.io/ourairports-data"

/**
 * `airports.csv` is the payload; the other three join its codes to text or carry the negative class.
 */
const FILES = ["airports.csv", "countries.csv", "regions.csv", "runways.csv"] as const

export type FetchOurAirportsOptions = BaseFetchOptions

interface OurAirportsFileEntry {
	filename: string
	source_url: string
	sha256: string
	bytes: number
	/**
	 * The upstream `Last-Modified`, when the CDN gave one.
	 *
	 * It is the data's vintage; `downloaded_at` is only when we asked.
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
 * @returns `null` on any failure, because provenance metadata must never fail
 * a download that otherwise succeeded.
 */
async function readLastModified(url: string): Promise<string | null> {
	try {
		const res = await new APIClient({ displayName: "ourairports", retry: true }).fetch({
			url,
			method: "head",
			timeout: 30_000,
		})

		return (res.headers["last-modified"] as string | undefined) ?? null
	} catch {
		return null
	}
}

/**
 * Download the OurAirports CSVs into `<outRoot>/ourairports/`, with a sibling `manifest.json`
 * carrying each file's origin URL, sha256, byte count and upstream `Last-Modified`.
 */
export async function fetchOurAirports(
	options: FetchOurAirportsOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)

	const entries: OurAirportsFileEntry[] = []
	const failedCodes: string[] = []
	let fetched = 0
	let failed = 0

	for (const filename of FILES) {
		const url = `${BASE_URL}/${filename}`
		const dest = destDir(filename)

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

	await writeManifest(destDir("MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
