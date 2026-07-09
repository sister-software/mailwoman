/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the full TIGER 2024 ADDRFEAT dataset — all US counties.
 *
 *   TIGER ADDRFEAT 2024 source:
 *
 *   - https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT/
 *   - Files: `tl_2024_<statefips><countyfips>_addrfeat.zip`
 *
 *   Each state's ZIPs land in `<outRoot>/tiger/addrfeat/state-<statefips>/` with a per-state
 *   `MANIFEST.json` recording filename, sha256, and bytes for every county ZIP so re-runs can skip
 *   already-verified files. (Extraction + ogr2ogr ingestion happen later, in the `tiger` adapter;
 *   this module is download + provenance only.)
 *
 *   Invoke via `mailwoman corpus fetch tiger-full --out-root <path>`. Native `fetch` streams each
 *   county ZIP to disk (no curl subprocess).
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { isTransientStatus, readManifest, writeManifest } from "./download.ts"

const TIGER_BASE_URL = "https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT"

export interface FetchTigerFullOptions extends BaseFetchOptions {
	/**
	 * Space-separated list of 2-digit state FIPS codes to skip entirely. Default `"50"` — Vermont, already fetched in
	 * v0.1.1.
	 */
	skipStateFips?: string
	/** Seconds to sleep between downloads. Default `0.2`. */
	rateSleep?: number
	/** Max concurrent download workers per state. Default `4`. */
	maxParallel?: number
	/** Print planned downloads without fetching. Default `false`. */
	dryRun?: boolean
}

interface CountyEntry {
	filename: string
	sha256: string
	bytes: number
}

function humanBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"]
	let value = bytes
	let unit = 0

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}

	return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

/**
 * Stream an HTTP download to disk, returning the final HTTP status (0 on network error after retries).
 *
 * NOTE(phase1): kept local instead of the shared `downloadToFile` — this one streams each county ZIP to disk (the
 * shared util buffers via `arrayBuffer()`) and returns the HTTP status instead of throwing, which the per-county result
 * collector consumes.
 */
async function streamDownload(
	url: string,
	dest: string,
	opts: { timeoutMs: number; retries: number; retryDelayMs: number }
): Promise<number> {
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs) })

			if (res.ok && res.body) {
				await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))

				return res.status
			}

			if (attempt < opts.retries && isTransientStatus(res.status)) {
				await sleep(opts.retryDelayMs)
				continue
			}

			return res.status
		} catch {
			if (attempt < opts.retries) {
				await sleep(opts.retryDelayMs)
				continue
			}

			return 0
		}
	}

	return 0
}

/** Read a per-state MANIFEST.json into a filename → entry map. */
async function readCountyManifest(manifestPath: string): Promise<Map<string, CountyEntry>> {
	const map = new Map<string, CountyEntry>()
	const parsed = await readManifest<{ counties?: CountyEntry[] }>(manifestPath)

	for (const c of parsed?.counties ?? []) {
		if (c.filename) {
			map.set(c.filename, { filename: c.filename, sha256: c.sha256, bytes: c.bytes })
		}
	}

	return map
}

/** Check whether a file already matches a recorded sha256 and byte count. */
async function fileMatchesSha(path: string, expectedSha: string, expectedBytes: number): Promise<boolean> {
	if (!existsSync(path)) return false

	if (statSync(path).size !== expectedBytes) return false

	return (await sha256File(path)) === expectedSha
}

type CountyResult =
	| { ok: true; filename: string; sha256: string; bytes: number }
	| { ok: false; filename: string; reason: string }

/** Download one county ZIP (size sanity check + sha256). */
async function downloadCounty(url: string, dest: string): Promise<CountyResult> {
	const filename = basename(dest)
	const status = await streamDownload(url, dest, { timeoutMs: 600_000, retries: 3, retryDelayMs: 5_000 })

	if (status < 200 || status >= 300) {
		return { ok: false, filename, reason: `HTTP ${status}` }
	}

	const bytes = statSync(dest).size

	if (bytes < 1024) {
		rmSync(dest, { force: true })

		return { ok: false, filename, reason: `too small (${bytes} bytes)` }
	}

	const sha256 = await sha256File(dest)

	return { ok: true, filename, sha256, bytes }
}

export async function fetchTigerFull(
	options: FetchTigerFullOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const skipStateFips = (options.skipStateFips ?? "50").split(/\s+/).filter(Boolean)
	const rateSleepMs = Math.round((options.rateSleep ?? 0.2) * 1000)
	const maxParallel = options.maxParallel ?? 4
	const dryRun = options.dryRun ?? false

	const addrfeatDir = join(options.outRoot, "tiger", "addrfeat")
	mkdirSync(addrfeatDir, { recursive: true })

	// -------------------------------------------------------------------------
	// Step 1: Discover the full county file list from the TIGER directory listing.
	// -------------------------------------------------------------------------
	report?.(`=== Fetching TIGER 2024 ADDRFEAT directory listing...`)
	const listingRes = await fetch(`${TIGER_BASE_URL}/`, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(60_000),
	})

	if (!listingRes.ok) throw new Error(`Failed to fetch TIGER directory listing: HTTP ${listingRes.status}`)
	const html = await listingRes.text()
	const allZips = [...new Set(html.match(/tl_2024_[0-9]{5}_addrfeat\.zip/g) ?? [])].sort()
	const totalCounties = allZips.length
	report?.(`  Found ${totalCounties} county ZIPs in the TIGER 2024 ADDRFEAT index.`)

	// Build a map: state_fips -> list of filenames.
	// tl_2024_SSCCC_addrfeat.zip — SS = 2-digit state FIPS (chars 8-9), CCC = county FIPS.
	const stateFiles = new Map<string, string[]>()

	for (const fname of allZips) {
		const stateFips = fname.slice(8, 10)
		const list = stateFiles.get(stateFips) ?? []
		list.push(fname)
		stateFiles.set(stateFips, list)
	}

	report?.(`  Spans ${stateFiles.size} state/territory FIPS codes.`)

	// -------------------------------------------------------------------------
	// Step 2: For each state, download missing/unverified county ZIPs.
	// -------------------------------------------------------------------------
	let totalFetched = 0
	let totalSkipped = 0
	let totalSkippedState = 0
	let totalFailed = 0
	let totalBytesFetched = 0
	const failedCodes: string[] = []

	// Process states in sorted FIPS order for predictable output.
	const sortedStates = [...stateFiles.keys()].sort()

	for (const stateFips of sortedStates) {
		const countyFiles = stateFiles.get(stateFips) ?? []

		// --- Skip entire state if requested ------------------------------------------
		if (skipStateFips.includes(stateFips)) {
			report?.(`--- State ${stateFips} — SKIPPED (in --skip-state-fips, ${countyFiles.length} counties)`)
			totalSkippedState += countyFiles.length
			continue
		}

		const stateDir = join(addrfeatDir, `state-${stateFips}`)
		mkdirSync(stateDir, { recursive: true })
		const manifestPath = join(stateDir, "MANIFEST.json")

		// Load existing manifest for O(1) verified-skip lookup.
		const manifest = await readCountyManifest(manifestPath)

		report?.(`--- State ${stateFips} — ${countyFiles.length} counties`)

		// Build a list of URLs+dests that need fetching.
		const pending: Array<{ url: string; dest: string }> = []

		for (const fname of countyFiles) {
			const dest = join(stateDir, fname)
			const url = `${TIGER_BASE_URL}/${fname}`
			const known = manifest.get(fname)

			// Skip if already verified via MANIFEST.
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

		if (pending.length === 0) continue

		// --- Download pending files with bounded parallelism + rate-limit spacing ---
		const results: CountyResult[] = new Array(pending.length)
		let cursor = 0
		const workers = Array.from({ length: Math.min(maxParallel, pending.length) }, async () => {
			while (true) {
				const i = cursor++

				if (i >= pending.length) return
				const item = pending[i]!
				// Rate-limit: polite spacing before each fetch.
				await sleep(rateSleepMs)
				results[i] = await downloadCounty(item.url, item.dest)
			}
		})
		await Promise.all(workers)

		// Collect results from this state.
		for (const result of results) {
			if (result.ok) {
				report?.(`  ok ${result.filename}  ${humanBytes(result.bytes)}  sha256=${result.sha256.slice(0, 12)}...`)
				manifest.set(result.filename, { filename: result.filename, sha256: result.sha256, bytes: result.bytes })
				totalFetched++
				totalBytesFetched += result.bytes
			} else {
				report?.(`  FAIL ${result.filename} -- ${result.reason}`)
				totalFailed++
				failedCodes.push(result.filename)
			}
		}

		// Rewrite per-state MANIFEST.json with all known-good counties (sorted for determinism).
		const counties = [...manifest.values()].sort((a, b) => a.filename.localeCompare(b.filename))
		const manifestDoc = {
			state_fips: stateFips,
			updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			tiger_base_url: TIGER_BASE_URL,
			counties,
		}
		await writeManifest(manifestPath, manifestDoc)
	}

	// -------------------------------------------------------------------------
	// Summary
	// -------------------------------------------------------------------------
	report?.(`=== Summary ===`)
	report?.(`  Total counties in index   : ${totalCounties}`)
	report?.(`  State(s) fully skipped    : ${totalSkippedState} (--skip-state-fips "${skipStateFips.join(" ")}")`)
	report?.(`  Counties already present  : ${totalSkipped}`)
	report?.(`  Counties fetched this run : ${totalFetched}`)
	report?.(`  Counties failed           : ${totalFailed}`)

	if (totalBytesFetched > 0) {
		report?.(`  Bytes fetched this run    : ${humanBytes(totalBytesFetched)} (${totalBytesFetched})`)
	}

	if (totalFailed > 0) {
		report?.(`WARNING: ${totalFailed} download(s) failed. Re-run to retry.`)
	}

	return { fetched: totalFetched, skipped: totalSkipped + totalSkippedState, failed: totalFailed, failedCodes }
}
