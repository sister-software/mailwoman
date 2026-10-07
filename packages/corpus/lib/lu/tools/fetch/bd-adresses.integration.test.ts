/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches data.public.lu. In the slow suite, so the fast suite stays offline.
 *
 *   The CSV is 28 MB and republished weekly, so the default case measures what the dataset record
 *   states about it rather than transferring it. The three statements the module depends on are all
 *   here: that the record has a `csv` resource, that the resource's URL holds the edition's own
 *   timestamp, and that the record states an md5 the transfer can be checked against.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { md5File } from "@mailwoman/core/hash"
import { describe, expect, it } from "vitest"

import { BD_ADRESSES_REQUIRED_COLUMNS } from "#lu/adapters/bd-adresses/adapter"
import {
	type BDAdressesManifest,
	bdAdressesInputPath,
	fetchBDAdresses,
	LU_BD_ADRESSES_DATASET_URL,
	readBDAdressesResource,
} from "#lu/tools/fetch/bd-adresses"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { readManifest } from "#tools/fetch/download"

const TIMEOUT_MS = 120_000

/**
 * The whole transfer is 28 MB, so it runs only when asked for by name.
 *
 * `MAILWOMAN_BD_ADRESSES_FULL_FETCH=1 yarn vitest --run --config vitest.slow.config.ts <this file>`.
 */
// oxlint-disable-next-line sister-software/no-process-globals -- a per-run test switch rather than project configuration, so it has no entry in `@mailwoman/core/env`.
const FULL_FETCH = process.env.MAILWOMAN_BD_ADRESSES_FULL_FETCH === "1"

const FULL_FETCH_TIMEOUT_MS = 600_000

describe.runIf(LIVE_PUBLISHER_TESTS)("the BD-Adresses dataset record on data.public.lu", () => {
	it(
		"names a csv resource whose url carries the edition and whose checksum is an md5",
		async () => {
			await using client = new APIClient({ displayName: "bd-adresses integration", retry: true })

			const { data } = await client.fetch<Parameters<typeof readBDAdressesResource>[0]>({
				method: "GET",
				url: LU_BD_ADRESSES_DATASET_URL,
				responseType: "json",
			})

			const resource = readBDAdressesResource(data)

			// No measured value is asserted: the publisher rewrites the file weekly
			// and the URL, the length and the digest all move with it.
			expect(resource.url).toMatch(/^https:\/\/download\.data\.public\.lu\/resources\//)
			expect(resource.url.endsWith("/addresses.csv")).toBe(true)

			// The dated path segment is what rules out a hardcoded URL.
			expect(resource.url).toMatch(/\/\d{8}-\d{6}\/addresses\.csv$/)

			// Both are what the re-run check and the transfer check rest on.
			expect(resource.md5).not.toBeNull()
			expect(resource.filesize).toBeGreaterThan(0)
		},
		TIMEOUT_MS
	)
})

describe.runIf(LIVE_PUBLISHER_TESTS && FULL_FETCH)("fetchBDAdresses against data.public.lu", () => {
	it(
		"writes the CSV, verifies it against the publisher's md5, and records the columns",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-bd-adresses-live-")

			const summary = await fetchBDAdresses({ outRoot: scratch.path }, (line) => process.stderr.write(`${line}\n`))

			expect(summary).toMatchObject({ fetched: 1, failed: 0 })

			const manifest = await readManifest<BDAdressesManifest>(scratch.path("bd-adresses", "MANIFEST.json"))

			expect(manifest?.license).toBe("CC0-1.0")
			expect(manifest?.columns).toEqual(expect.arrayContaining([...BD_ADRESSES_REQUIRED_COLUMNS]))

			// The module accepted the transfer on this comparison, and this repeats it on disk.
			expect(await md5File(bdAdressesInputPath(scratch.path))).toBe(manifest?.publisher_md5)

			// A second run finds the manifest's md5 unchanged and transfers no bytes.
			expect(await fetchBDAdresses({ outRoot: scratch.path })).toMatchObject({ fetched: 0, skipped: 1 })
		},
		FULL_FETCH_TIMEOUT_MS
	)
})
