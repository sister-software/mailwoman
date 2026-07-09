/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the HRSA Health Center Service Delivery Sites CSV. Source for the `usgov-hrsa-fqhc`
 *   adapter. US Public Domain.
 *
 *   Uses Node's built-in fetch (gzip/brotli) and streaming sha256 instead of curl + sha256sum, and
 *   writes the same sibling `MANIFEST.json` (origin URL + fetch timestamp + byte count + sha256) so
 *   downstream adapters can verify provenance.
 *
 *   Invoke via `mailwoman corpus fetch hrsa --out-root <path>`.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, writeManifest } from "./download.ts"

const SLUG = "usgov-hrsa-fqhc"
const FILENAME = "Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
const SOURCE_URL = `https://data.hrsa.gov/DataDownload/DD_Files/${FILENAME}`

export type FetchHRSAOptions = BaseFetchOptions

interface SourceManifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
}

export async function fetchHRSA(options: FetchHRSAOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const dest = join(destDir, FILENAME)

	report?.(`=== ${SLUG} / ${FILENAME}`)
	const { bytes } = await downloadToFile({
		url: SOURCE_URL,
		dest,
		timeoutMs: 600_000,
		headers: { "Accept-Encoding": "gzip, br" },
		report,
	})
	const sha = await sha256File(dest)

	const manifest: SourceManifest = {
		source_url: SOURCE_URL,
		downloaded_at: new Date().toISOString(),
		filename: FILENAME,
		sha256: sha,
		bytes,
	}
	await writeManifest(join(destDir, "MANIFEST.json"), manifest)

	report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
