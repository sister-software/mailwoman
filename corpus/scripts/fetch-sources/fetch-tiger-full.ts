#!/usr/bin/env npx tsx
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
 *   Each state's ZIPs land in `$OUT_ROOT/tiger/addrfeat/state-<statefips>/` with a per-state
 *   `MANIFEST.json` recording filename, sha256, and bytes for every county ZIP so re-runs can skip
 *   already-verified files. (Extraction + ogr2ogr ingestion happen later, in the `tiger` adapter; this
 *   script is download + provenance only.)
 *
 *   Replaces the bash `fetch-sources/fetch-tiger-full.sh` with a TypeScript pipeline matching the style
 *   of the other corpus scripts (fetch-nad, ingest-csv, run-corpus-build). Native `fetch` streams each
 *   county ZIP to disk (no curl subprocess); `zx` is used only for the `git rev-parse` repo-root default.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *     npx tsx corpus/scripts/fetch-sources/fetch-tiger-full.ts
 * ```
 *
 *   ## Options (env vars)
 *
 *   - `OUT_ROOT` — destination root (default: `<repo-root>/data/corpus/sources`)
 *   - `SKIP_STATE_FIPS` — space-separated list of 2-digit state FIPS to skip (default: `"50"` —
 *       Vermont, already fetched in v0.1.1)
 *   - `RATE_SLEEP` — seconds to sleep between downloads (default: `0.2`)
 *   - `MAX_PARALLEL` — max concurrent download workers per state (default: `4`)
 *   - `DRY_RUN` — set to `1` to print planned downloads without fetching
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { $public } from "@mailwoman/core/env"
import { $ } from "zx"

$.verbose = false

const TIGER_BASE_URL = "https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT"

function parseEnv() {
	return {
		outRoot: $public.OUT_ROOT,
		// Space-separated 2-digit state FIPS codes to skip entirely.
		// Default: skip 50 (Vermont) — already present from v0.1.1 build.
		skipStateFips: ($public.SKIP_STATE_FIPS ?? "50").split(/\s+/).filter(Boolean),
		rateSleepMs: Math.round(Number.parseFloat($public.RATE_SLEEP ?? "0.2") * 1000),
		maxParallel: Number.parseInt($public.MAX_PARALLEL ?? "4", 10),
		dryRun: ($public.DRY_RUN ?? "0") === "1",
	}
}

interface CountyEntry {
	filename: string
	sha256: string
	bytes: number
}

/** Repo-root toplevel, mirroring the bash default `$(git rev-parse --show-toplevel)/data/corpus/sources`. */
async function gitToplevel(): Promise<string> {
	return (await $`git rev-parse --show-toplevel`).stdout.trim()
}

/** Stream-hash a file with sha256 (matches `sha256sum`, memory-safe for large ZIPs). */
async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	await pipeline(createReadStream(path), hash)

	return hash.digest("hex")
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Mirror curl's `--retry` policy: only transient HTTP statuses are worth a retry. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/**
 * Stream an HTTP download to disk, returning the final HTTP status (0 on network error after retries). Replaces the
 * bash `curl -fsSL --max-time 600 --retry 3 --retry-delay 5 -o`.
 */
async function downloadToFile(
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
				await delay(opts.retryDelayMs)
				continue
			}

			return res.status
		} catch {
			if (attempt < opts.retries) {
				await delay(opts.retryDelayMs)
				continue
			}

			return 0
		}
	}

	return 0
}

/** Read a per-state MANIFEST.json into a filename → entry map (replaces the bash `jq` reader). */
function readManifest(manifestPath: string): Map<string, CountyEntry> {
	const map = new Map<string, CountyEntry>()

	if (!existsSync(manifestPath)) return map

	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { counties?: CountyEntry[] }

		for (const c of parsed.counties ?? []) {
			if (c.filename) {
				map.set(c.filename, { filename: c.filename, sha256: c.sha256, bytes: c.bytes })
			}
		}
	} catch {
		// Malformed manifest — treat as empty and re-fetch.
	}

	return map
}

/** Check whether a file already matches a recorded sha256 and byte count. */
async function fileMatchesSha(path: string, expectedSha: string, expectedBytes: number): Promise<boolean> {
	if (!existsSync(path)) return false

	if (statSync(path).size !== expectedBytes) return false

	return (await sha256OfFile(path)) === expectedSha
}

type CountyResult =
	| { ok: true; filename: string; sha256: string; bytes: number }
	| { ok: false; filename: string; reason: string }

/** Download one county ZIP, mirroring the bash per-file worker (size sanity check + sha256). */
async function downloadCounty(url: string, dest: string): Promise<CountyResult> {
	const filename = basename(dest)
	const status = await downloadToFile(url, dest, { timeoutMs: 600_000, retries: 3, retryDelayMs: 5_000 })

	if (status < 200 || status >= 300) {
		return { ok: false, filename, reason: "curl error" }
	}

	const bytes = statSync(dest).size

	if (bytes < 1024) {
		rmSync(dest, { force: true })

		return { ok: false, filename, reason: `too small (${bytes} bytes)` }
	}

	const sha256 = await sha256OfFile(dest)

	return { ok: true, filename, sha256, bytes }
}

async function main(): Promise<void> {
	const env = parseEnv()
	const outRoot = env.outRoot ?? join(await gitToplevel(), "data", "corpus", "sources")
	const addrfeatDir = join(outRoot, "tiger", "addrfeat")
	mkdirSync(addrfeatDir, { recursive: true })

	// -------------------------------------------------------------------------
	// Step 1: Discover the full county file list from the TIGER directory listing.
	// -------------------------------------------------------------------------
	process.stdout.write(`=== Fetching TIGER 2024 ADDRFEAT directory listing...\n`)
	const listingRes = await fetch(`${TIGER_BASE_URL}/`, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(60_000),
	})

	if (!listingRes.ok) throw new Error(`Failed to fetch TIGER directory listing: HTTP ${listingRes.status}`)
	const html = await listingRes.text()
	const allZips = [...new Set(html.match(/tl_2024_[0-9]{5}_addrfeat\.zip/g) ?? [])].sort()
	const totalCounties = allZips.length
	process.stdout.write(`  Found ${totalCounties} county ZIPs in the TIGER 2024 ADDRFEAT index.\n`)

	// Build a map: state_fips -> list of filenames.
	// tl_2024_SSCCC_addrfeat.zip — SS = 2-digit state FIPS (chars 8-9), CCC = county FIPS.
	const stateFiles = new Map<string, string[]>()

	for (const fname of allZips) {
		const stateFips = fname.slice(8, 10)
		const list = stateFiles.get(stateFips) ?? []
		list.push(fname)
		stateFiles.set(stateFips, list)
	}

	process.stdout.write(`  Spans ${stateFiles.size} state/territory FIPS codes.\n`)

	// -------------------------------------------------------------------------
	// Step 2: For each state, download missing/unverified county ZIPs.
	// -------------------------------------------------------------------------
	let totalFetched = 0
	let totalSkipped = 0
	let totalSkippedState = 0
	let totalFailed = 0
	let totalBytesFetched = 0

	// Process states in sorted FIPS order for predictable output.
	const sortedStates = [...stateFiles.keys()].sort()

	for (const stateFips of sortedStates) {
		const countyFiles = stateFiles.get(stateFips) ?? []

		// --- Skip entire state if requested ------------------------------------------
		if (env.skipStateFips.includes(stateFips)) {
			process.stdout.write(`--- State ${stateFips} — SKIPPED (in SKIP_STATE_FIPS, ${countyFiles.length} counties)\n`)
			totalSkippedState += countyFiles.length
			continue
		}

		const stateDir = join(addrfeatDir, `state-${stateFips}`)
		mkdirSync(stateDir, { recursive: true })
		const manifestPath = join(stateDir, "MANIFEST.json")

		// Load existing manifest for O(1) verified-skip lookup.
		const manifest = readManifest(manifestPath)

		process.stdout.write(`--- State ${stateFips} — ${countyFiles.length} counties\n`)

		// Build a list of URLs+dests that need fetching.
		const pending: Array<{ url: string; dest: string }> = []

		for (const fname of countyFiles) {
			const dest = join(stateDir, fname)
			const url = `${TIGER_BASE_URL}/${fname}`
			const known = manifest.get(fname)

			// Skip if already verified via MANIFEST.
			if (known && (await fileMatchesSha(dest, known.sha256, known.bytes))) {
				process.stdout.write(`  skip (verified) ${fname}\n`)
				totalSkipped++
				continue
			}

			if (env.dryRun) {
				process.stdout.write(`  would fetch: ${url}\n`)
				totalFetched++
				continue
			}

			pending.push({ url, dest })
		}

		if (env.dryRun) continue

		if (pending.length === 0) continue

		// --- Download pending files with bounded parallelism + rate-limit spacing ---
		const results: CountyResult[] = new Array(pending.length)
		let cursor = 0
		const workers = Array.from({ length: Math.min(env.maxParallel, pending.length) }, async () => {
			while (true) {
				const i = cursor++

				if (i >= pending.length) return
				const item = pending[i]!
				// Rate-limit: polite spacing before each fetch.
				await delay(env.rateSleepMs)
				results[i] = await downloadCounty(item.url, item.dest)
			}
		})
		await Promise.all(workers)

		// Collect results from this state.
		for (const result of results) {
			if (result.ok) {
				process.stdout.write(
					`  ok ${result.filename}  ${humanBytes(result.bytes)}  sha256=${result.sha256.slice(0, 12)}...\n`
				)
				manifest.set(result.filename, { filename: result.filename, sha256: result.sha256, bytes: result.bytes })
				totalFetched++
				totalBytesFetched += result.bytes
			} else {
				process.stdout.write(`  FAIL ${result.filename} -- ${result.reason}\n`)
				totalFailed++
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
		await writeFile(manifestPath, JSON.stringify(manifestDoc, null, 2) + "\n")
	}

	// -------------------------------------------------------------------------
	// Summary
	// -------------------------------------------------------------------------
	process.stdout.write(`\n`)
	process.stdout.write(`=== Summary ===\n`)
	process.stdout.write(`  Total counties in index   : ${totalCounties}\n`)
	process.stdout.write(
		`  State(s) fully skipped    : ${totalSkippedState} (SKIP_STATE_FIPS="${env.skipStateFips.join(" ")}")\n`
	)
	process.stdout.write(`  Counties already present  : ${totalSkipped}\n`)
	process.stdout.write(`  Counties fetched this run : ${totalFetched}\n`)
	process.stdout.write(`  Counties failed           : ${totalFailed}\n`)

	if (totalBytesFetched > 0) {
		process.stdout.write(`  Bytes fetched this run    : ${humanBytes(totalBytesFetched)} (${totalBytesFetched})\n`)
	}

	if (totalFailed > 0) {
		process.stdout.write(`\n`)
		process.stdout.write(`WARNING: ${totalFailed} download(s) failed. Re-run to retry.\n`)
		process.exitCode = 1
	}
}

runIfScript(main)
