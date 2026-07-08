#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download Google/Chromium's per-country `ssl-address` postal-address metadata — the
 *   {@link https://github.com/google/libaddressinput libaddressinput} AddressValidationMetadata that
 *   seeds the per-locale field order, required-field, and upper-casing conventions.
 *
 *   See: https://github.com/google/libaddressinput/wiki/AddressValidationMetadata
 *
 *   Replaces the bash `ssl-address-download.sh` (curl + jq) with native `fetch` + `JSON.parse`. The
 *   country list lives at `…/ssl-address/data` as a `~`-delimited `.countries` string; each country's
 *   record is then fetched from `…/ssl-address/data/<CC>` and written to `<out-dir>/<CC>.json`.
 *
 *   ## Usage
 *
 *   ```sh
 *   node core/data/chromium-i18n/ssl-address-download.ts
 *   node core/data/chromium-i18n/ssl-address-download.ts --concurrency 16
 *   ```
 *
 *   ## Flags
 *
 *   - `--out-dir <path>` — destination directory; default `./ssl-address` (next to this script)
 *   - `--concurrency <n>` — parallel per-country fetches; default `8`
 */

///<reference types="node" />

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { corePackagePathBuilder, runIfScript } from "@mailwoman/core/utils"

const BASE_URL = "https://chromium-i18n.appspot.com/ssl-address/data"

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			"out-dir": { type: "string", default: String(corePackagePathBuilder("data", "chromium-i18n", "ssl-address")) },
			concurrency: { type: "string", default: "8" },
		},
	})

	return {
		outDir: values["out-dir"]!,
		concurrency: Number.parseInt(values.concurrency!, 10),
	}
}

/** Fetch the `~`-delimited country list and return it as an array of ISO codes. */
async function fetchCountryCodes(): Promise<string[]> {
	const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(60_000) })

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching country list`)
	const data = (await res.json()) as { countries?: string }

	return (data.countries ?? "").split("~").filter(Boolean)
}

/** Fetch a single country's metadata record and write its raw JSON body to `<outDir>/<cc>.json`. */
async function fetchCountry(cc: string, outDir: string): Promise<void> {
	const res = await fetch(`${BASE_URL}/${cc}`, { signal: AbortSignal.timeout(60_000) })

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${cc}`)
	await writeFile(join(outDir, `${cc}.json`), await res.text())
}

async function main(): Promise<void> {
	const { outDir, concurrency } = parseCLIArgs()
	await mkdir(outDir, { recursive: true })

	const codes = await fetchCountryCodes()
	process.stderr.write(`=== ssl-address: ${codes.length} countries → ${outDir}\n`)

	let nextSlot = 0
	let failures = 0
	const workers = Array.from({ length: Math.min(concurrency, codes.length) }, async () => {
		while (true) {
			const slot = nextSlot++

			if (slot >= codes.length) return
			const cc = codes[slot]!

			try {
				await fetchCountry(cc, outDir)
				process.stderr.write(`  ✓ ${cc}\n`)
			} catch (err) {
				failures++
				process.stderr.write(`  ✗ ${cc}: ${(err as Error).message}\n`)
			}
		}
	})
	await Promise.all(workers)

	process.stderr.write(`\n=== done: ${codes.length - failures}/${codes.length} written, ${failures} failed\n`)

	if (failures > 0) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, main)
