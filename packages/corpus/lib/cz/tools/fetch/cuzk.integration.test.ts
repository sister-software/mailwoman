/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches ČÚZK. In the slow suite, so the fast suite stays offline.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { listZipEntries } from "@mailwoman/core/fs/zip"
import { describe, expect, it } from "vitest"

import { createCzCuzkAdapter } from "#cz/adapters/cuzk/adapter"
import { CZ_CUZK_REQUEST_INTERVAL_MS, type CzCuzkHarvestManifest, harvestCzCuzk } from "#cz/tools/fetch/cuzk"
import { readManifest } from "#tools/fetch/download"

/**
 * Two municipalities whose archives the adapter's own documentation already quotes.
 */
const MUNICIPALITIES = ["584061", "584282"]

/**
 * The service document is 8.4 MB and the archives are small, so the bound is the round trips.
 */
const TIMEOUT_MS = 180_000

describe("harvestCzCuzk against atom.cuzk.gov.cz", () => {
	it(
		"harvests the named municipalities and leaves archives the adapter can open",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-cuzk-live-")

			await using client = new APIClient({
				displayName: "cz-cuzk integration",
				minRequestIntervalMs: CZ_CUZK_REQUEST_INTERVAL_MS,
				retry: true,
			})

			const summary = await harvestCzCuzk(client, {
				outputDir: scratch.path,
				municipalities: MUNICIPALITIES,
			})

			expect(summary).toMatchObject({ fetched: MUNICIPALITIES.length, failed: 0 })

			const manifest = await readManifest<CzCuzkHarvestManifest>(scratch.path("MANIFEST.json"))

			// The denominator comes from the feed.
			// The publisher merges and adds municipalities, so the assertion is that it listed
			// more than this run asked for rather than that it listed a particular number.
			expect(manifest?.municipalities_listed).toBeGreaterThan(MUNICIPALITIES.length)
			expect(manifest?.files.map((file) => file.municipality_code)).toEqual(MUNICIPALITIES)

			for (const file of manifest?.files ?? []) {
				// The byte count is the delivered one, and the digest is over the same bytes.
				expect(file.bytes).toBeGreaterThan(0)
				expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u)

				// The service document's `<updated>` is this archive's modification time.
				// The host's own header is the second statement of it, and the harvest's
				// resumability rests on the two agreeing.
				expect(file.last_modified).not.toBeNull()
				expect(new Date(file.last_modified ?? "").toISOString()).toBe(new Date(file.feed_updated).toISOString())

				const members = await listZipEntries(scratch.path(file.filename))
				const gml = members.filter((member) => member.name.toLowerCase().endsWith(".xml"))

				expect(gml.length).toBeGreaterThan(0)
			}
		},
		TIMEOUT_MS
	)

	it(
		"asks for nothing on a second run over the same directory",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-cuzk-live-rerun-")

			await using client = new APIClient({
				displayName: "cz-cuzk integration",
				minRequestIntervalMs: CZ_CUZK_REQUEST_INTERVAL_MS,
				retry: true,
			})

			const options = { outputDir: scratch.path, municipalities: ["584061"] }

			expect(await harvestCzCuzk(client, options)).toMatchObject({ fetched: 1, skipped: 0 })
			expect(await harvestCzCuzk(client, options)).toMatchObject({ fetched: 0, skipped: 1 })

			// The digest check reaches the same conclusion through the file's bytes rather than its length.
			expect(await harvestCzCuzk(client, { ...options, verifyDigests: true })).toMatchObject({
				fetched: 0,
				skipped: 1,
			})
		},
		TIMEOUT_MS
	)

	it(
		"composes the same archive URL the publisher's own dataset feed states",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-cuzk-live-twolevel-")

			await using client = new APIClient({
				displayName: "cz-cuzk integration",
				minRequestIntervalMs: CZ_CUZK_REQUEST_INTERVAL_MS,
				retry: true,
			})

			const composed = await harvestCzCuzk(client, { outputDir: scratch.path, municipalities: ["584061"] })
			const composedManifest = await readManifest<CzCuzkHarvestManifest>(scratch.path("MANIFEST.json"))

			await using resolved = await temporaryDirectory("mailwoman-cuzk-live-resolved-")

			const throughFeed = await harvestCzCuzk(client, {
				outputDir: resolved.path,
				municipalities: ["584061"],
				resolveThroughDatasetFeed: true,
			})

			const resolvedManifest = await readManifest<CzCuzkHarvestManifest>(resolved.path("MANIFEST.json"))

			expect(composed).toMatchObject({ failed: 0 })
			expect(throughFeed).toMatchObject({ failed: 0 })

			// The composed URL is what makes the harvest 6,259 requests rather than 12,517.
			// This is the check that the composition is the publisher's own URL.
			expect(composedManifest?.files[0]?.source_url).toBe(resolvedManifest?.files[0]?.source_url)
			expect(composedManifest?.files[0]?.sha256).toBe(resolvedManifest?.files[0]?.sha256)
		},
		TIMEOUT_MS
	)

	it(
		"leaves a directory `createCzCuzkAdapter` emits rows from",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-cuzk-live-adapter-")

			await using client = new APIClient({
				displayName: "cz-cuzk integration",
				minRequestIntervalMs: CZ_CUZK_REQUEST_INTERVAL_MS,
				retry: true,
			})

			expect(await harvestCzCuzk(client, { outputDir: scratch.path, municipalities: ["584061"] })).toMatchObject({
				failed: 0,
			})

			// The harvest's whole purpose: the adapter's `inputPath` is this directory,
			// and it globs the archives in it.
			const rows = await Array.fromAsync(createCzCuzkAdapter().rows({ inputPath: scratch.path, limit: 5 }))

			expect(rows.length).toBeGreaterThan(0)
			expect(rows.every((row) => row.country === "CZ")).toBe(true)
			expect(rows.every((row) => row.raw.length > 0)).toBe(true)
		},
		TIMEOUT_MS
	)
})
