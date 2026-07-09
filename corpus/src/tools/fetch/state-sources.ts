/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the state-level open-data sources (NY/TX/DE/OR notaries, IA contractors, WA health
 *   providers, HI lobbyists). Reproducible recovery if `$MAILWOMAN_DATA_ROOT` is lost.
 *
 *   HI public schools is fetched separately by `mailwoman corpus fetch state-hi-schools` — its
 *   upstream is an XLSX workbook that requires an openpyxl-driven sheet-concatenation pre-step
 *   before the adapter can consume it.
 *
 *   Each source lands in its own subdirectory of `<outRoot>/<slug>/` along with a `MANIFEST.json`
 *   recording origin URL + download timestamp + sha256 so downstream adapters can verify provenance.
 *
 *   Invoke via `mailwoman corpus fetch state-sources --out-root <path>`. Uses Node's built-in fetch
 *   (gzip/brotli) and streaming sha256 instead of curl + sha256sum.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, writeManifest } from "./download.ts"

export type FetchStateSourcesOptions = BaseFetchOptions

interface Source {
	slug: string
	filename: string
	url: string
}

const SOURCES: readonly Source[] = [
	{
		slug: "state-ny-notaries",
		filename: "NY_Commissioned_Notaries.csv",
		url: "https://data.ny.gov/api/views/rwbv-mz6z/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-tx-notaries",
		filename: "TX_Notary_Public_Commissions.csv",
		url: "https://data.texas.gov/api/views/gmd3-bnrd/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-de-notaries",
		filename: "DE_Notaries_Commissioned.csv",
		url: "https://data.delaware.gov/api/views/q8dr-mj6p/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-or-notaries",
		filename: "OR_Active_Notaries.csv",
		url: "https://data.oregon.gov/api/views/j2pk-zk6z/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-ia-contractors",
		filename: "IA_Active_Construction_Contractor_Registrations.csv",
		url: "https://data.iowa.gov/api/views/dpf3-iz94/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-wa-health-providers",
		filename: "WA_Health_Care_Provider_Credential_Data.csv",
		url: "https://data.wa.gov/api/views/qxh8-f4bd/rows.csv?accessType=DOWNLOAD",
	},
	{
		slug: "state-hi-lobbyists",
		filename: "HI_Lobbyist_Registration_Statements.csv",
		url: "https://data.hawaii.gov/api/views/cm7c-skav/rows.csv?accessType=DOWNLOAD",
	},
]

interface SourceManifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
}

export async function fetchStateSources(
	options: FetchStateSourcesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	mkdirSync(options.outRoot, { recursive: true })

	let fetched = 0
	let failed = 0
	const failedCodes: string[] = []

	for (const { slug, filename, url } of SOURCES) {
		const destDir = join(options.outRoot, slug)
		mkdirSync(destDir, { recursive: true })
		const dest = join(destDir, filename)

		report?.(`=== ${slug} / ${filename}`)

		let bytes: number

		try {
			;({ bytes } = await downloadToFile({
				url,
				dest,
				timeoutMs: 600_000,
				headers: { "Accept-Encoding": "gzip, br" },
				report,
			}))
		} catch (err) {
			report?.(`  ✗ download failed for ${url}: ${(err as Error).message}`)
			failed++
			failedCodes.push(slug)
			continue
		}

		if (bytes < 1024) {
			report?.(`  ✗ response too small (${bytes} bytes) — probable 404 / error page`)
			failed++
			failedCodes.push(slug)
			continue
		}

		const sha = await sha256File(dest)
		const manifest: SourceManifest = {
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename,
			sha256: sha,
			bytes,
		}
		await writeManifest(join(destDir, "MANIFEST.json"), manifest)

		report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)
		fetched++
	}

	report?.(`=== summary ===`)
	report?.(`fetched: ${fetched}`)
	report?.(`failed:  ${failed}`)

	return { fetched, skipped: 0, failed, failedCodes }
}
