/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches the OCP Data Registry. In the slow suite, so the fast suite stays offline.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { createITANACAdapter, IT_ANAC_LICENSE } from "#it/adapters/anac/adapter"
import { type ANACEditionManifest, anacEditionURL, downloadITANAC, readANACEditionHead } from "#it/tools/fetch/anac"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { type SourceCollectionManifest, readManifest } from "#tools/fetch/download"

/**
 * The smallest edition the publication serves, so the live checks cost one small transfer.
 *
 * `undated.jsonl.gz` answered `content-length` 4,282 on 2026-10-02 against `full.jsonl.gz`'s 183,974,254.
 */
const SMALL_EDITION = "undated"

/**
 * The edition the register's coverage measurement was taken over.
 */
const MEASURED_EDITION = "2025"

const TIMEOUT_MS = 180_000

describe.runIf(LIVE_PUBLISHER_TESTS)("it-anac against data.open-contracting.org", () => {
	it(
		"serves both the measured edition and the all-time one, with the headers the re-run check reads",
		async () => {
			await using client = new APIClient({ displayName: "it-anac integration", retry: true })

			for (const edition of [MEASURED_EDITION, "full"]) {
				const head = await readANACEditionHead(client, edition)

				// The host states both.
				// That holds a re-run to one small request per edition.
				expect(head.lastModified).not.toBeNull()
				expect(head.contentLength).not.toBeNull()
				expect(head.contentLength ?? 0).toBeGreaterThan(0)
				expect(head.contentType).toContain("gzip")
			}
		},
		TIMEOUT_MS
	)

	it(
		"leaves a directory `createITANACAdapter` reads, under the license the register elected",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-it-anac-live-")
			await using client = new APIClient({ displayName: "it-anac integration", retry: true })

			const summary = await downloadITANAC(client, {
				outputDir: scratch.path,
				editions: [SMALL_EDITION],
			})

			expect(summary).toMatchObject({ fetched: 1, failed: 0 })

			const manifest = await readManifest<SourceCollectionManifest>(scratch.path("MANIFEST.json"))

			expect(manifest?.license).toBe(IT_ANAC_LICENSE)
			expect(manifest?.files).toHaveLength(1)

			const [file] = (manifest?.files ?? []) as ANACEditionManifest[]

			expect(file?.source_url).toBe(anacEditionURL(SMALL_EDITION))
			expect(file?.filename).toBe(`${SMALL_EDITION}.jsonl`)
			// The byte count is the delivered one and the digest is over the same bytes.
			expect(file?.bytes).toBeGreaterThan(0)
			expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/u)
			expect(file?.last_modified).not.toBeNull()

			// The compressed copy is removed by default, so the directory holds only editions.
			const rows = await Array.fromAsync(createITANACAdapter().rows({ inputPath: scratch.path, limit: 5 }))

			expect(rows.every((row) => row.country === "IT")).toBe(true)
			expect(rows.every((row) => row.license === IT_ANAC_LICENSE)).toBe(true)
			expect(rows.every((row) => row.raw.length > 0)).toBe(true)
		},
		TIMEOUT_MS
	)

	it(
		"asks for no body on a second run over the same directory",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-it-anac-live-rerun-")
			await using client = new APIClient({ displayName: "it-anac integration", retry: true })

			const options = { outputDir: scratch.path, editions: [SMALL_EDITION] }

			expect(await downloadITANAC(client, options)).toMatchObject({ fetched: 1, skipped: 0 })
			expect(await downloadITANAC(client, options)).toMatchObject({ fetched: 0, skipped: 1 })

			// The digest check reaches the same conclusion through the file's bytes rather than its length.
			expect(await downloadITANAC(client, { ...options, verifyDigest: true })).toMatchObject({
				fetched: 0,
				skipped: 1,
			})
		},
		TIMEOUT_MS
	)

	it(
		"still publishes the three party roles the register's addressRoles was written from",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-it-anac-live-roles-")
			await using client = new APIClient({ displayName: "it-anac integration", retry: true })

			expect(await downloadITANAC(client, { outputDir: scratch.path, editions: [MEASURED_EDITION] })).toMatchObject({
				failed: 0,
			})

			const rows = await Array.fromAsync(
				createITANACAdapter().rows({ inputPath: scratch.path(`${MEASURED_EDITION}.jsonl`), limit: 500 })
			)

			// A loose bound rather than a pinned count: ANAC republishes monthly and the 2025 edition grows.
			// The assertion is that the reader still finds Italian addresses in it.
			expect(rows).toHaveLength(500)
			expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)
			expect(rows.some((row) => Boolean(row.components.house_number))).toBe(true)
			expect(rows.some((row) => Boolean(row.components.postcode))).toBe(true)
			expect(rows.some((row) => Boolean(row.components.venue))).toBe(true)
			expect(rows.some((row) => row.components.postcode === "N.A.")).toBe(false)
		},
		TIMEOUT_MS
	)
})
