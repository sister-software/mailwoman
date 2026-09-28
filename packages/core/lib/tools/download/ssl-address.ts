/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download Google and Chromium's per-country `ssl-address` metadata.
 *   This is the {@link https://github.com/google/libaddressinput libaddressinput} AddressValidationMetadata.
 *   It supplies each locale's field order and required fields.
 *   It also supplies upper-casing conventions.
 *
 *   See: https://github.com/google/libaddressinput/wiki/AddressValidationMetadata
 *
 *   Replaces the bash `ssl-address-download.sh` (curl + jq). The country list lives at
 *   `…/ssl-address/data` as a `~`-delimited `.countries` string. each country's record is then
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
 *   - `--out-dir <path>` — destination directory. default `./ssl-address` (next to this script)
 *   - `--concurrency <n>` — parallel per-country fetches. default `8`
 */

import { PathBuilder, type PathBuilderLike } from "path-ts"

import { APIClient, pluckResponseData } from "#api/index"
import { makeDirectories, writeLocalFile } from "#fs/writers"
import { corePackagePathBuilder } from "#paths"

const BASE_URL = "https://chromium-i18n.appspot.com/ssl-address/data"

/**
 * One host, ~250 small records, fetched `concurrency`-wide.
 *
 * Retry prevents a temporary throttle or dropped connection from counting as a permanent country failure.
 * Without retry, the run reported `written: 249, failed: 1`.
 *
 * That result was indistinguishable from a country absent from the source.
 * This tool uses a concurrency-wide burst and has no `minRequestIntervalMs` setting.
 *
 * The host has not objected to that request pattern.
 * A rate limit without supporting measurements would slow the tool.
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
	 * Destination directory.
	 *
	 * Default: the checked-in `core/data/chromium-i18n/ssl-address`.
	 */
	outDir?: PathBuilderLike
	/**
	 * Parallel per-country fetches.
	 *
	 * Default 8.
	 */
	concurrency?: number
}

/**
 * Fetch the `~`-delimited country list and return it as an array of ISO codes.
 */
async function fetchCountryCodes(): Promise<string[]> {
	const data = await sslAddressClient.fetch<{ countries?: string }>({ url: BASE_URL }).then(pluckResponseData)

	return (data.countries ?? "").split("~").filter((code) => code.length)
}

/**
 * Fetch a single country's metadata record and write its raw JSON body to `<outDir>/<cc>.json`.
 */
async function fetchCountry(cc: string, outDir: PathBuilder): Promise<void> {
	// `responseType: "text"` preserves the raw body because the tool writes these records verbatim.
	// If Axios parsed and reserialized them, it would rewrite key order and spacing in a checked-in artifact.
	const body = await sslAddressClient
		.fetch<string>({ url: `${BASE_URL}/${cc}`, responseType: "text" })
		.then(pluckResponseData)

	await writeLocalFile(body, outDir(`${cc}.json`))
}

/**
 * Download every country's ssl-address metadata record.
 *
 * @returns The failure count (the command maps `failed > 0` to exit 1).
 */
export async function downloadSSLAddress(
	options: DownloadSSLAddressOptions = {},
	report?: (line: string) => void
): Promise<{ written: number; failed: number }> {
	const outDir = PathBuilder.from(options.outDir ?? corePackagePathBuilder("data", "chromium-i18n", "ssl-address"))
	const concurrency = options.concurrency ?? 8
	await makeDirectories(outDir)

	const codes = await fetchCountryCodes()
	report?.(`=== ssl-address: ${codes.length} countries → ${outDir}`)

	let nextSlot = 0
	let failures = 0

	// Deferred move: the worker-pool home is spliterator's `parallelMap`; this hand-rolled pool predates it.
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
