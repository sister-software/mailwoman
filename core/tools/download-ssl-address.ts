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
 *   mailwoman dev download ssl-address [--concurrency 16]
 *   ```
 *
 *   ## Flags
 *
 *   - `--out-dir <path>` — destination directory; default `./ssl-address` (next to this script)
 *   - `--concurrency <n>` — parallel per-country fetches; default `8`
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { corePackagePath } from "@mailwoman/core/utils"

const BASE_URL = "https://chromium-i18n.appspot.com/ssl-address/data"

/** Flag-shaped options for {@linkcode downloadSSLAddress}. */
export interface DownloadSSLAddressOptions {
	/** Destination directory. Default: the checked-in `core/data/chromium-i18n/ssl-address`. */
	outDir?: string
	/** Parallel per-country fetches. Default 8. */
	concurrency?: number
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

/**
 * Download every country's ssl-address metadata record. Returns the failure count (the command maps `failed > 0` to
 * exit 1).
 */
export async function downloadSSLAddress(
	options: DownloadSSLAddressOptions = {},
	report?: (line: string) => void
): Promise<{ written: number; failed: number }> {
	const outDir = options.outDir ?? corePackagePath("data", "chromium-i18n", "ssl-address")
	const concurrency = options.concurrency ?? 8
	await mkdir(outDir, { recursive: true })

	const codes = await fetchCountryCodes()
	report?.(`=== ssl-address: ${codes.length} countries → ${outDir}`)

	let nextSlot = 0
	let failures = 0
	const workers = Array.from({ length: Math.min(concurrency, codes.length) }, async () => {
		while (true) {
			const slot = nextSlot++

			if (slot >= codes.length) return
			const cc = codes[slot]!

			try {
				await fetchCountry(cc, outDir)
				report?.(`  ✓ ${cc}`)
			} catch (err) {
				failures++
				report?.(`  ✗ ${cc}: ${(err as Error).message}`)
			}
		}
	})
	await Promise.all(workers)

	report?.(`=== done: ${codes.length - failures}/${codes.length} written, ${failures} failed`)

	return { written: codes.length - failures, failed: failures }
}
