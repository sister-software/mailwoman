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
 *   Replaces the bash `ssl-address-download.sh` (curl + jq). The country list lives at
 *   `…/ssl-address/data` as a `~`-delimited `.countries` string; each country's record is then
 *   fetched from `…/ssl-address/data/<CC>` and written to `<out-dir>/<CC>.json`.
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

import { join } from "@mailwoman/platform/path"

import { makeDirectories, writeLocalFile } from "#fs/writers"
import { corePackagePath } from "#utils"

import { APIClient, pluckResponseData } from "../api/index.ts"

const BASE_URL = "https://chromium-i18n.appspot.com/ssl-address/data"

/**
 * One host, ~250 small records, fetched `concurrency`-wide.
 *
 * Retry is the point: a throttle or a dropped connection on ONE country previously counted as a permanent failure for
 * that country, and the run reported `written: 249, failed: 1` — indistinguishable from a country the source does not
 * carry. No `minRequestIntervalMs`: the concurrency-wide burst is what this tool has always done and the host has not
 * objected, and inventing a rate limit no measurement supports would only make a working tool slower.
 */
const sslAddressClient = new APIClient({
	displayName: "ssl-address",
	retry: true,
	axios: { timeout: 60_000 },
})

/**
 * Flag-shaped options for {@linkcode downloadSSLAddress}.
 */
export interface DownloadSSLAddressOptions {
	/**
	 * Destination directory. Default: the checked-in `core/data/chromium-i18n/ssl-address`.
	 */
	outDir?: string
	/**
	 * Parallel per-country fetches. Default 8.
	 */
	concurrency?: number
}

/**
 * Fetch the `~`-delimited country list and return it as an array of ISO codes.
 */
async function fetchCountryCodes(): Promise<string[]> {
	const data = await sslAddressClient.fetch<{ countries?: string }>({ url: BASE_URL }).then(pluckResponseData)

	return (data.countries ?? "").split("~").filter((code) => code.length > 0)
}

/**
 * Fetch a single country's metadata record and write its raw JSON body to `<outDir>/<cc>.json`.
 */
async function fetchCountry(cc: string, outDir: string): Promise<void> {
	// `responseType: "text"` keeps the RAW body: these records are written to disk verbatim, and letting
	// axios parse then re-serialize would rewrite key order and spacing in a checked-in artifact.
	const body = await sslAddressClient
		.fetch<string>({ url: `${BASE_URL}/${cc}`, responseType: "text" })
		.then(pluckResponseData)

	await writeLocalFile(body, join(outDir, `${cc}.json`))
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
	await makeDirectories(outDir)

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
			} catch (error) {
				failures++
				report?.(`  ✗ ${cc}: ${(error as Error).message}`)
			}
		}
	})

	await Promise.all(workers)

	report?.(`=== done: ${codes.length - failures}/${codes.length} written, ${failures} failed`)

	return { written: codes.length - failures, failed: failures }
}
