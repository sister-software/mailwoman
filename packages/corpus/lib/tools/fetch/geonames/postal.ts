/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the GeoNames per-country postal-code exports — the only source in this family that carries a
 *   `(postcode, locality, region)` triple with the names inline.
 *
 *   Source : https://download.geonames.org/export/zip/<CC>.zip
 *   License: CC-BY-4.0, attribute "GeoNames". Tier B.
 *
 *   GeoNames publishes roughly 80 countries; an absent country fails as one entry, never as the whole run.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download/index"
import { downloadToFile, HTTPStatusError, writeManifest } from "#tools/fetch/download/index"

/**
 * The status that means the source does not publish this country rather than that the transfer failed.
 */
const HTTP_NOT_FOUND = 404

const SLUG = "geonames-postal"

/**
 * GeoNames' own export directory, one zip per ISO alpha-2 code holding `<CC>.txt`
 * plus the shared `readme.txt`.
 */
const BASE_URL = "https://download.geonames.org/export/zip"

/**
 * Countries fetched when the caller names none.
 *
 * Venezuela is deliberately absent because GeoNames does not publish it.
 */
export const GEONAMES_POSTAL_DEFAULT_COUNTRIES = ["PT", "AU", "NZ", "IE", "BR", "ZA", "MX"] as const

export interface FetchGeonamesPostalOptions extends BaseFetchOptions {
	/**
	 * ISO alpha-2 codes in any casing; defaults to `{@linkcode GEONAMES_POSTAL_DEFAULT_COUNTRIES}`.
	 */
	countries?: readonly string[]
	/**
	 * Export directory to read from.
	 *
	 * Defaults to GeoNames' own, so the 404-is-coverage behaviour can be exercised against a local server.
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
	 * Countries asked for and not published by GeoNames.
	 *
	 * An absence here is a fact about the source rather than about the run.
	 */
	unavailable: string[]
}

/**
 * Download the requested GeoNames postal zips into `<outRoot>/geonames-postal/` with
 * a sibling `manifest.json`; a country the source does not carry is counted as failed
 * and named in `failedCodes` without stopping the rest.
 */
export async function fetchGeonamesPostal(
	options: FetchGeonamesPostalOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
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
		const dest = destDir(filename)

		report?.(`=== ${SLUG} / ${country}`)

		try {
			const { bytes } = await downloadToFile({ url, dest, timeoutMs: 300_000, retries: 2, retryDelayMs, report })

			entries.push({ country, filename, source_url: url, sha256: await sha256File(dest), bytes })

			fetched++
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)

			// A 404 means GeoNames does not publish the country at all, a different finding
			// from a failed transfer; branch on the typed status rather than message prose.
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

	await writeManifest(destDir("MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
