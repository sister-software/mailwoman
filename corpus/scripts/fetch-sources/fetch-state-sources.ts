#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the state-level open-data sources tonight's adhoc download pulled (NY/TX/DE/OR
 *   notaries, IA contractors, WA health providers, HI lobbyists). Reproducible recovery if
 *   `$MAILWOMAN_DATA_ROOT` is lost.
 *
 *   HI public schools is fetched separately by `fetch-state-hi-schools.ts` — its upstream is an XLSX
 *   workbook that requires an openpyxl-driven sheet-concatenation pre-step before the adapter can
 *   consume it.
 *
 *   Each source lands in its own subdirectory of `$OUT_ROOT/$slug/` along with a `MANIFEST.json`
 *   recording origin URL + download timestamp + sha256 so downstream adapters can verify provenance.
 *
 *   Replaces the bash `fetch-sources/fetch-state-sources.sh` with a TypeScript pipeline matching the
 *   style of the other corpus scripts (fetch-nad, ingest-csv): Node's built-in fetch (gzip/brotli)
 *   and `node:crypto` sha256 instead of curl + sha256sum.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/data/corpus/sources npx tsx packages/corpus/scripts/fetch-sources/fetch-state-sources.ts
 *   ```
 *
 *   Defaults to writing under `./data/corpus/sources/` in the repo root.
 *
 *   ## Flags
 *
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `<repo-root>/data/corpus/sources`
 */

///<reference types="node" />

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { $public } from "@mailwoman/core/env"

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

/** Mirror the bash default of `$(git rev-parse --show-toplevel)/data/corpus/sources`. */
function repoRootDataSources(): string {
	const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

	return join(top, "data", "corpus", "sources")
}

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	hash.update(await readFile(path))

	return hash.digest("hex")
}

async function downloadToFile(url: string, dest: string, timeoutMs: number): Promise<number> {
	const res = await fetch(url, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(timeoutMs),
	})

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`)
	await writeFile(dest, Buffer.from(await res.arrayBuffer()))

	return statSync(dest).size
}

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			"out-root": { type: "string", default: $public.OUT_ROOT },
		},
	})

	return {
		outRoot: values["out-root"] ?? repoRootDataSources(),
	}
}

async function main(): Promise<void> {
	const { outRoot } = parseCLIArgs()
	mkdirSync(outRoot, { recursive: true })

	let fetched = 0
	let failed = 0

	for (const { slug, filename, url } of SOURCES) {
		const destDir = join(outRoot, slug)
		mkdirSync(destDir, { recursive: true })
		const dest = join(destDir, filename)

		process.stderr.write(`=== ${slug} / ${filename}\n`)

		let bytes: number

		try {
			bytes = await downloadToFile(url, dest, 600_000)
		} catch (err) {
			process.stderr.write(`  ✗ download failed for ${url}: ${(err as Error).message}\n`)
			failed++
			continue
		}

		if (bytes < 1024) {
			process.stderr.write(`  ✗ response too small (${bytes} bytes) — probable 404 / error page\n`)
			failed++
			continue
		}

		const sha = await sha256OfFile(dest)
		const manifest: SourceManifest = {
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename,
			sha256: sha,
			bytes,
		}
		await writeFile(join(destDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")

		process.stderr.write(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}\n`)
		fetched++
	}

	process.stderr.write(`\n=== summary ===\n`)
	process.stderr.write(`fetched: ${fetched}\n`)
	process.stderr.write(`failed:  ${failed}\n`)

	if (failed > 0) {
		process.exitCode = 1
	}
}

main().catch((err: Error) => {
	process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
	process.exitCode = 1
})
