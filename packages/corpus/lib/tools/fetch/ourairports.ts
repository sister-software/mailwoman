// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Fetch the OurAirports CSV dumps: the venue side of the sub-venue corpus arc,
 * and the input of the structures layer's airports (`#structures/ourairports`).
 *
 * Source: https://davidmegginson.github.io/ourairports-data.
 * Terms: "All data is released to the Public Domain" (https://ourairports.com/data/),
 * with a credit requested and not required.
 *
 * `unchecked-access-free-ca-ourairports` records the decision.
 */

import { APIClient } from "@mailwoman/core/api"
import { sha256File } from "@mailwoman/core/crypto/hash"
import { makeDirectories } from "@mailwoman/core/fs/writers"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { downloadToFile, writeManifest } from "#tools/fetch/download"

/**
 * The source directory the fetcher writes.
 */
export const OURAIRPORTS_SOURCE_ID = "ourairports"

const SLUG = OURAIRPORTS_SOURCE_ID

/**
 * `ourairports.com/data/*.csv` redirects to the project's own GitHub Pages mirror.
 */
const BASE_URL = "https://davidmegginson.github.io/ourairports-data"

/**
 * `airports.csv` is the payload.
 *
 * The other three join its codes to text or provide the negative class.
 */
const FILES = ["airports.csv", "countries.csv", "regions.csv", "runways.csv"] as const

export type FetchOurAirportsOptions = BaseFetchOptions

/**
 * One downloaded file as the manifest records it.
 */
export interface OurAirportsFileEntry {
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

/**
 * What one run recorded.
 * `files` lists only the files that arrived.
 */
export interface OurAirportsManifest {
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
async function readLastModified(client: Pick<APIClient, "fetch">, url: string): Promise<string | null> {
	try {
		const res = await client.fetch({
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
	await using client = new APIClient({ displayName: SLUG, retry: true })
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
				readLastModified(client, url),
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
		license: "LicenseRef-OurAirports-Public-Domain",
		downloaded_at: new Date().toISOString(),
		files: entries,
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
