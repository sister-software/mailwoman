import { APIClient, pluckResponseData } from "@mailwoman/core/api"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch the full TIGER 2024 addrfeat dataset for all US counties from
 * `https://www2.census.gov/geo/tiger/TIGER2024/addrfeat/`, where files are named
 * `tl_2024_<statefips><countyfips>_addrfeat.zip`.
 *
 * Each state's ZIPs land in `<outRoot>/tiger/addrfeat/state-<statefips>/` with a per-state
 * `manifest.json` recording filename, sha256 and bytes so re-runs skip already-verified files;
 * extraction and ogr2ogr ingestion happen later, in the `tiger` adapter.
 */
/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */
import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { isoSeconds } from "@mailwoman/core/utils"
import { sleep } from "@mailwoman/core/utils/sleep"
import type { PathBuilder } from "path-ts"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download/index"
import { readManifest, streamDownload, writeManifest } from "#tools/fetch/download/index"

const HTTP_OK = 200
const HTTP_REDIRECT = 300

const TIGER_BASE_URL = "https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT"

export interface FetchTigerFullOptions extends BaseFetchOptions {
	skipStateFips?: string
	rateSleep?: number
	maxParallel?: number
	dryRun?: boolean
}

interface CountyEntry {
	filename: string
	sha256: string
	bytes: number
}

async function readCountyManifest(manifestPath: PathBuilder): Promise<Map<string, CountyEntry>> {
	const map = new Map<string, CountyEntry>()
	const parsed = await readManifest<{ counties?: CountyEntry[] }>(manifestPath)

	for (const c of parsed?.counties ?? []) {
		if (c.filename) {
			map.set(c.filename, { filename: c.filename, sha256: c.sha256, bytes: c.bytes })
		}
	}

	return map
}

async function fileMatchesSha(path: PathBuilder, expectedSha: string, expectedBytes: number): Promise<boolean> {
	if (!(await pathExists(path))) return false

	if ((await statPath(path)).size !== expectedBytes) return false

	return (await sha256File(path)) === expectedSha
}

type CountyResult =
	| { ok: true; filename: string; sha256: string; bytes: number }
	| { ok: false; filename: string; reason: string }

async function downloadCounty(url: string, dest: PathBuilder): Promise<CountyResult> {
	const filename = dest.basename()
	const status = await streamDownload(url, dest, { timeoutMs: 600_000, retries: 3, retryDelayMs: 5000 })

	if (status < HTTP_OK || status >= HTTP_REDIRECT) {
		return { ok: false, filename, reason: `HTTP ${status}` }
	}

	const bytes = (await statPath(dest)).size

	if (bytes < BYTES_PER_KIB) {
		await removePathIfPresent(dest)

		return { ok: false, filename, reason: `too small (${bytes} bytes)` }
	}

	const sha256 = await sha256File(dest)

	return { ok: true, filename, sha256, bytes }
}

export async function fetchTigerFull(
	options: FetchTigerFullOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const skipStateFips = (options.skipStateFips ?? "50").split(/\s+/).filter((value) => value.length)
	const rateSleepMs = Math.round((options.rateSleep ?? 0.2) * 1000)
	const maxParallel = options.maxParallel ?? 4
	const dryRun = options.dryRun ?? false

	const addrfeatDir = options.outRoot("tiger", "addrfeat")
	await makeDirectories(addrfeatDir)

	// MARK: Step 1 — discover the county file list

	report?.(`=== Fetching TIGER 2024 ADDRFEAT directory listing...`)

	const listingRes = await new APIClient({
		displayName: "tiger-listing",
		retry: true,
		axios: { headers: { "Accept-Encoding": "gzip, br" } },
	})
		.fetch<string>({ url: `${TIGER_BASE_URL}/`, responseType: "text", timeout: 60_000 })
		.then(pluckResponseData)

	const html = listingRes
	const allZips = [...new Set(html.match(/tl_2024_[0-9]{5}_addrfeat\.zip/g))].toSorted()
	const totalCounties = allZips.length
	report?.(`  Found ${totalCounties} county ZIPs in the TIGER 2024 ADDRFEAT index.`)

	// `tl_2024_SSCCC_addrfeat.zip`: SS is the 2-digit state FIPS at chars 8-9.
	const stateFiles = new Map<string, string[]>()

	for (const fname of allZips) {
		const stateFips = fname.slice(8, 10)
		const list = stateFiles.get(stateFips) ?? []
		list.push(fname)
		stateFiles.set(stateFips, list)
	}

	report?.(`  Spans ${stateFiles.size} state/territory FIPS codes.`)

	// MARK: Step 2 — download the county ZIPs

	let totalFetched = 0
	let totalSkipped = 0
	let totalSkippedState = 0
	let totalFailed = 0
	let totalBytesFetched = 0
	const failedCodes: string[] = []

	const sortedStates = [...stateFiles.keys()].toSorted()

	for (const stateFips of sortedStates) {
		const countyFiles = stateFiles.get(stateFips) ?? []

		if (skipStateFips.includes(stateFips)) {
			report?.(`--- State ${stateFips} — SKIPPED (in --skip-state-fips, ${countyFiles.length} counties)`)
			totalSkippedState += countyFiles.length

			continue
		}

		const stateDir = addrfeatDir(`state-${stateFips}`)
		await makeDirectories(stateDir)
		const manifestPath = stateDir("MANIFEST.json")

		const manifest = await readCountyManifest(manifestPath)

		report?.(`--- State ${stateFips} — ${countyFiles.length} counties`)

		const pending: Array<{ url: string; dest: PathBuilder }> = []

		for (const fname of countyFiles) {
			const dest = stateDir(fname)
			const url = `${TIGER_BASE_URL}/${fname}`
			const known = manifest.get(fname)

			if (known && (await fileMatchesSha(dest, known.sha256, known.bytes))) {
				report?.(`  skip (verified) ${fname}`)

				totalSkipped++

				continue
			}

			if (dryRun) {
				report?.(`  would fetch: ${url}`)

				totalFetched++

				continue
			}

			pending.push({ url, dest })
		}

		if (dryRun) continue

		if (!pending.length) continue

		const results: CountyResult[] = Array.from({ length: pending.length })
		let cursor = 0

		const workers = Array.from({ length: Math.min(maxParallel, pending.length) }, async () => {
			while (true) {
				const i = cursor++

				if (i >= pending.length) return
				const item = pending[i]!
				await sleep(rateSleepMs)
				results[i] = await downloadCounty(item.url, item.dest)
			}
		})

		await Promise.all(workers)

		for (const result of results) {
			if (result.ok) {
				report?.(
					`  ok ${result.filename}  ${ByteFormatter.formatIEC(result.bytes)}  sha256=${result.sha256.slice(0, 12)}...`
				)

				manifest.set(result.filename, { filename: result.filename, sha256: result.sha256, bytes: result.bytes })

				totalFetched++
				totalBytesFetched += result.bytes
			} else {
				report?.(`  FAIL ${result.filename} -- ${result.reason}`)

				totalFailed++
				failedCodes.push(result.filename)
			}
		}

		const counties = [...manifest.values()].toSorted((a, b) => a.filename.localeCompare(b.filename))

		const manifestDoc = {
			state_fips: stateFips,
			updated_at: isoSeconds(),
			tiger_base_url: TIGER_BASE_URL,
			counties,
		}

		await writeManifest(manifestPath, manifestDoc)
	}

	// MARK: Summary

	report?.(`=== Summary ===`)
	report?.(`  Total counties in index   : ${totalCounties}`)
	report?.(`  State(s) fully skipped    : ${totalSkippedState} (--skip-state-fips "${skipStateFips.join(" ")}")`)
	report?.(`  Counties already present  : ${totalSkipped}`)
	report?.(`  Counties fetched this run : ${totalFetched}`)
	report?.(`  Counties failed           : ${totalFailed}`)

	if (totalBytesFetched > 0) {
		report?.(`  Bytes fetched this run    : ${ByteFormatter.formatIEC(totalBytesFetched)} (${totalBytesFetched})`)
	}

	if (totalFailed > 0) {
		report?.(`WARNING: ${totalFailed} download(s) failed. Re-run to retry.`)
	}

	return { fetched: totalFetched, skipped: totalSkipped + totalSkippedState, failed: totalFailed, failedCodes }
}
