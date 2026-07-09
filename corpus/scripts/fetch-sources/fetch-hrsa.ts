#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the HRSA Health Center Service Delivery Sites CSV. Source for the `usgov-hrsa-fqhc`
 *   adapter. US Public Domain.
 *
 *   Replaces the bash `fetch-sources/fetch-hrsa.sh` with a TypeScript pipeline matching the style of
 *   the other corpus scripts (fetch-nad, ingest-csv). Uses Node's built-in fetch (gzip/brotli) and
 *   `node:crypto` sha256 instead of curl + sha256sum, and writes the same sibling `MANIFEST.json`
 *   (origin URL + fetch timestamp + byte count + sha256) so downstream adapters can verify
 *   provenance.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/data/corpus/sources npx tsx packages/corpus/scripts/fetch-sources/fetch-hrsa.ts
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

const SLUG = "usgov-hrsa-fqhc"
const FILENAME = "Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
const SOURCE_URL = `https://data.hrsa.gov/DataDownload/DD_Files/${FILENAME}`

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
	const destDir = join(outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const dest = join(destDir, FILENAME)

	process.stderr.write(`=== ${SLUG} / ${FILENAME}\n`)
	const bytes = await downloadToFile(SOURCE_URL, dest, 600_000)
	const sha = await sha256OfFile(dest)

	const manifest: SourceManifest = {
		source_url: SOURCE_URL,
		downloaded_at: new Date().toISOString(),
		filename: FILENAME,
		sha256: sha,
		bytes,
	}
	await writeFile(join(destDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")

	process.stderr.write(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}\n`)
}

runIfScript(import.meta, main)
