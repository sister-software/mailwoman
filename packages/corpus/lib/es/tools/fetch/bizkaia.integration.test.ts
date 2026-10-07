/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches `apli.bizkaia.eus` and `geo.bizkaia.eus`. In the slow suite, so the fast suite stays
 *   offline.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { listZipEntries } from "@mailwoman/core/fs/zip"
import { describe, expect, it } from "vitest"

import { createESBizkaiaAdapter } from "#es/adapters/bizkaia/adapter"
import {
	ES_BIZKAIA_COMPONENT_TYPES,
	ES_BIZKAIA_REQUEST_INTERVAL_MS,
	type ESBizkaiaHarvestManifest,
	bizkaiaComponentFilename,
	harvestESBizkaia,
	readESBizkaiaServiceFeed,
} from "#es/tools/fetch/bizkaia"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

/**
 * The municipality the adapter's own documentation quotes, 48001 Abadiño.
 */
const MUNICIPALITY = "48001"

/**
 * The component documents total about 14 MB and the WFS answers each one in a single request.
 */
const TIMEOUT_MS = 300_000

function liveClient(): APIClient {
	return new APIClient({
		displayName: "es-bizkaia integration",
		minRequestIntervalMs: ES_BIZKAIA_REQUEST_INTERVAL_MS,
		retry: true,
	})
}

describe.runIf(LIVE_PUBLISHER_TESTS)("harvestESBizkaia against apli.bizkaia.eus", () => {
	it(
		"harvests one municipality's archive and every component document, and records both",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-bizkaia-live-")
			await using client = liveClient()

			const summary = await harvestESBizkaia(client, {
				outputDir: scratch.path,
				municipalities: [MUNICIPALITY],
			})

			expect(summary).toMatchObject({ failed: 0, failedCodes: [] })

			const manifest = await readManifest<ESBizkaiaHarvestManifest>(scratch.path("MANIFEST.json"))

			// The denominator comes from the feed.
			// The publisher merges and adds municipalities, so the assertion is that it
			// listed more than this run asked for rather than a number.
			expect(manifest?.municipalities_listed).toBeGreaterThan(1)
			expect(manifest?.files.map((file) => file.municipality_code)).toStrictEqual([MUNICIPALITY])

			const archive = manifest?.files[0]

			expect(archive?.bytes).toBeGreaterThan(0)
			expect(archive?.sha256).toMatch(/^[0-9a-f]{64}$/u)
			expect(archive?.feed_updated).not.toBe("")

			// The host states a modification time for the archive.
			// That is the record against which the feed's single `<updated>` reads as a per-municipality signal.
			expect(archive?.last_modified).not.toBeNull()

			const members = await listZipEntries(scratch.path(archive?.filename ?? ""))

			expect(members.filter((member) => member.name.toLowerCase().endsWith(".gml")).length).toBeGreaterThan(0)

			expect(manifest?.components.map((entry) => entry.type_name)).toStrictEqual(
				[...ES_BIZKAIA_COMPONENT_TYPES].toSorted()
			)

			for (const component of manifest?.components ?? []) {
				// The whole type in one document: the service advertises
				// ImplementsResultPaging=FALSE, so a shortfall cannot be paged.
				expect(component.features_returned).toBe(component.feature_count)
				expect(component.bytes).toBeGreaterThan(0)
				expect(component.filename).toBe(bizkaiaComponentFilename(component.type_name))
			}

			const streets = manifest?.components.find((entry) => entry.type_name === "ad:ThoroughfareName")

			// The streets are the reason the WFS is harvested at all: the archives hold
			// addresses whose every component reference addresses this service.
			expect(streets?.feature_count).toBeGreaterThan(0)
		},
		TIMEOUT_MS
	)

	it(
		"asks for the archive once over the same directory, and reads the component documents again",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-bizkaia-live-rerun-")
			await using client = liveClient()

			const options = { outputDir: scratch.path, municipalities: [MUNICIPALITY], components: false }

			expect(await harvestESBizkaia(client, options)).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })
			expect(await harvestESBizkaia(client, options)).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })

			// The digest check reaches the same conclusion through the file's bytes rather than its length.
			expect(await harvestESBizkaia(client, { ...options, verifyDigests: true })).toMatchObject({
				fetched: 0,
				skipped: 1,
			})
		},
		TIMEOUT_MS
	)

	it(
		"lists one archive per municipality, each through a rel=enclosure link",
		async () => {
			await using client = liveClient()

			const { data } = await client.fetch<string>({
				method: "GET",
				url: "https://apli.bizkaia.eus/apps/Danok/INSPIRE/addresses.xml",
				responseType: "text",
			})

			const datasets = readESBizkaiaServiceFeed(await readAtomFeed(feedChunks(String(data))))

			expect(datasets.length).toBeGreaterThan(1)
			expect(new Set(datasets.map((dataset) => dataset.filename)).size).toBe(datasets.length)

			// Every entry of this service repeats the feed document's own modification time.
			// That makes one request state the freshness of every archive.
			expect(new Set(datasets.map((dataset) => dataset.updated)).size).toBe(1)
			expect(datasets.every((dataset) => dataset.downloadURL.endsWith(dataset.filename))).toBe(true)
		},
		TIMEOUT_MS
	)

	it(
		"leaves a directory `createESBizkaiaAdapter` emits rows from",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-bizkaia-live-adapter-")
			await using client = liveClient()

			expect(await harvestESBizkaia(client, { outputDir: scratch.path, municipalities: [MUNICIPALITY] })).toMatchObject(
				{ failed: 0 }
			)

			// The harvest's whole purpose: the adapter's `inputPath` is this directory,
			// and the streets it joins against come from the saved WFS documents in it.
			const rows = await Array.fromAsync(createESBizkaiaAdapter().rows({ inputPath: scratch.path, limit: 5 }))

			expect(rows.length).toBeGreaterThan(0)
			expect(rows.every((row) => row.country === "ES")).toBe(true)
			expect(rows.every((row) => row.raw.length > 0)).toBe(true)
		},
		TIMEOUT_MS
	)
})
