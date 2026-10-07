/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { appendLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	collectionOpeningTag,
	harvestPagedWFS,
	readCurrentHarvest,
	readMarkupRoot,
	rootContent,
	statedFeatureCount,
	type HarvestedPayload,
	type PagedWFSHarvestOptions,
	type WFSHarvestManifest,
} from "#tools/fetch/wfs-harvest"

const PAGE_ROOT =
	'<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" ' +
	'numberMatched="unknown" numberReturned="2" timeStamp="2026-10-02T16:25:34">'

/**
 * A service holding `total` features.
 * It answers a page of at most `pageCap` of them.
 *
 * The features differ by index, so two pages are never byte-identical and the harvest's
 * repeated-page check is not satisfied by the fixture itself.
 */
function fakeService(options: { total: number; pageCap?: number; header?: string; footer?: string }) {
	const asked: number[] = []

	const readPage = async ({ startIndex, count }: { startIndex: number; count: number }): Promise<HarvestedPayload> => {
		asked.push(startIndex)

		const size = Math.max(0, Math.min(count, options.pageCap ?? count, options.total - startIndex))
		const payload = Array.from({ length: size }, (_, index) => `feature-${startIndex + index}\n`).join("")

		return {
			payload,
			header: options.header,
			footer: options.footer,
			numberReturned: size,
			numberMatched: options.total,
			retrievedAt: "2026-10-02T16:25:34",
		}
	}

	return { asked, readPage }
}

function harvestOptions(
	outputDir: PathBuilderLike,
	service: { readPage: PagedWFSHarvestOptions["readPage"] },
	overrides: Partial<PagedWFSHarvestOptions> = {}
): PagedWFSHarvestOptions {
	return {
		context: "test wfs",
		source: "test",
		outputDir,
		filename: "address.jsonl",
		request: {
			wfsURL: "https://example.invalid/wfs",
			typeName: "ad:Address",
			outputFormat: "application/json",
			sortBy: "gml_id",
		},
		license: "CC0-1.0",
		attribution: "",
		featureCount: { count: null, because: "the service stated no count" },
		pageSize: 2,
		readPage: service.readPage,
		...overrides,
	}
}

describe("readMarkupRoot", () => {
	it("reads the first element tag past the XML declaration", () => {
		const root = readMarkupRoot(`<?xml version='1.0' encoding="UTF-8" ?>\n${PAGE_ROOT}</wfs:FeatureCollection>`, "test")

		expect(root.name).toBe("wfs:FeatureCollection")
		expect(root.tag).toBe(PAGE_ROOT)
	})

	it("refuses a body that is not markup, rather than reading it as a page of nothing", () => {
		expect(() => readMarkupRoot("Service temporarily unavailable", "test")).toThrow(/carried no element tag/u)
	})
})

describe("rootContent", () => {
	it("returns the members between the root tags", () => {
		const body = `${PAGE_ROOT}<wfs:member>one</wfs:member></wfs:FeatureCollection>`
		const root = readMarkupRoot(body, "test")

		expect(rootContent(body, root, "test")).toBe("<wfs:member>one</wfs:member>")
	})

	it("refuses an unclosed root, so a truncated transfer is not read as empty", () => {
		const body = `${PAGE_ROOT}<wfs:member>one</wfs:mem`
		const root = readMarkupRoot(body, "test")

		expect(() => rootContent(body, root, "test")).toThrow(/is not closed/u)
	})
})

describe("collectionOpeningTag", () => {
	it("keeps the namespace declarations and drops what describes one page", () => {
		const tag = collectionOpeningTag(readMarkupRoot(PAGE_ROOT, "test"))

		expect(tag).toContain('xmlns:ms="http://mapserver.gis.umn.edu/mapserver"')
		expect(tag).toContain('xmlns:wfs="http://www.opengis.net/wfs/2.0"')
		expect(tag).not.toContain("numberMatched")
		expect(tag).not.toContain("numberReturned")
		expect(tag).not.toContain("timeStamp")
	})
})

describe("statedFeatureCount", () => {
	it("carries a checked count the service reported", () => {
		const stated = statedFeatureCount({ reported: 729_973, usable: true, because: "a page agreed" }, 1_000_000)

		expect(stated.count).toBe(729_973)
	})

	it("refuses a count equal to the service's advertised page cap", () => {
		// Poland reports numberMatched=1000 against a CountDefault of 1000, and no page can
		// return more than the cap, so the page that checks the count agrees with it every time.
		const stated = statedFeatureCount({ reported: 1000, usable: true, because: "a page agreed" }, 1000)

		expect(stated.count).toBeNull()
		expect(stated.because).toMatch(/cap it advertises as CountDefault/u)
	})

	it("carries an unusable count as no count, with the service's reason", () => {
		const stated = statedFeatureCount({ reported: null, usable: false, because: "it answered unknown" }, 1000)

		expect(stated.count).toBeNull()
		expect(stated.because).toMatch(/it answered unknown/u)
	})
})

describe("harvestPagedWFS", () => {
	it("appends every page to one file and records each page's byte range", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const service = fakeService({ total: 5 })
		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, service))

		expect(service.asked).toEqual([0, 2, 4, 5])
		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(5)
		expect(manifest.pages).toHaveLength(3)
		expect(manifest.sha256).not.toBeNull()

		const written = await readLocalTextFile(PathBuilder.from(scratch.path)("address.jsonl"))

		expect(written).toBe("feature-0\nfeature-1\nfeature-2\nfeature-3\nfeature-4\n")

		// Every recorded range hashes to what the manifest reports it holds.
		for (const page of manifest.pages) {
			const slice = Buffer.from(written, "utf8").subarray(page.offset, page.offset + page.bytes)

			expect(sha256Hex(slice)).toBe(page.sha256)
		}
	})

	it("stops at the stated count without asking for a page past it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const service = fakeService({ total: 4 })

		const manifest = await harvestPagedWFS(
			harvestOptions(scratch.path, service, {
				featureCount: { count: 4, because: "the service reported numberMatched" },
			})
		)

		expect(service.asked).toEqual([0, 2])
		expect(manifest.complete).toBe(true)
		expect(manifest.feature_count).toBe(4)
	})

	it("writes the header once and the footer when the type is read whole", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const service = fakeService({ total: 3, header: "HEAD\n", footer: "TAIL\n" })

		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, service, { filename: "address.gml" }))
		const written = await readLocalTextFile(PathBuilder.from(scratch.path)("address.gml"))

		expect(written).toBe("HEAD\nfeature-0\nfeature-1\nfeature-2\nTAIL\n")
		expect(manifest.header_bytes).toBe(5)
		expect(manifest.footer).toBe("TAIL\n")
		expect(manifest.pages[0]?.offset).toBe(5)
	})

	it("makes no request on a second run over a complete harvest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 5 })))

		const second = fakeService({ total: 5 })
		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, second))

		expect(second.asked).toEqual([])
		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(5)
	})

	it("makes no request on a second run that already holds its page cap", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 100 }), { maxPages: 1 }))

		const second = fakeService({ total: 100 })
		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, second, { maxPages: 1 }))

		expect(second.asked).toEqual([])
		expect(manifest.complete).toBe(false)
		expect(manifest.pages).toHaveLength(1)
	})

	it("resumes a partial harvest at the page after the last one on disk", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 5 }), { maxPages: 2 }))

		const resumed = fakeService({ total: 5 })
		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, resumed))

		expect(resumed.asked).toEqual([4, 5])
		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(5)

		const written = await readLocalTextFile(PathBuilder.from(scratch.path)("address.jsonl"))

		expect(written).toBe("feature-0\nfeature-1\nfeature-2\nfeature-3\nfeature-4\n")
	})

	it("cuts a partial append back to the last page boundary before resuming", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")
		const dataPath = PathBuilder.from(scratch.path)("address.jsonl")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 5 }), { maxPages: 2 }))

		// What an interrupted append leaves: bytes past the last page the manifest records.
		await appendLocalTextFile("feature-4\nfeatu", dataPath)

		const resumed = fakeService({ total: 5 })

		await harvestPagedWFS(harvestOptions(scratch.path, resumed))

		expect(resumed.asked).toEqual([4, 5])
		expect(await readLocalTextFile(dataPath)).toBe("feature-0\nfeature-1\nfeature-2\nfeature-3\nfeature-4\n")
	})

	it("refuses a service that answers a new startIndex with the previous page", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const repeating = {
			readPage: async (): Promise<HarvestedPayload> => ({
				payload: "feature-0\nfeature-1\n",
				numberReturned: 2,
				numberMatched: 100,
				retrievedAt: null,
			}),
		}

		await expect(harvestPagedWFS(harvestOptions(scratch.path, repeating))).rejects.toThrow(
			/byte-identical to the page at startIndex 0, so the service is answering a new startIndex/u
		)
	})

	it("refuses a page that states no numberReturned, rather than reading it as empty", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const silent = {
			readPage: async (): Promise<HarvestedPayload> => ({
				payload: "",
				numberReturned: null,
				numberMatched: null,
				retrievedAt: null,
			}),
		}

		await expect(harvestPagedWFS(harvestOptions(scratch.path, silent))).rejects.toThrow(/stated no numberReturned/u)
	})

	it("starts over when the manifest describes a different page size", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 4 }), { pageSize: 2 }))

		const second = fakeService({ total: 4 })
		const manifest = await harvestPagedWFS(harvestOptions(scratch.path, second, { pageSize: 4 }))

		expect(second.asked).toEqual([0, 4])
		expect(manifest.pages).toHaveLength(1)

		expect(await readLocalTextFile(PathBuilder.from(scratch.path)("address.jsonl"))).toBe(
			"feature-0\nfeature-1\nfeature-2\nfeature-3\n"
		)
	})
})

describe("readCurrentHarvest", () => {
	const expectation = { wfsURL: "https://example.invalid/wfs", sortBy: "gml_id", pageSize: 2 }

	it("answers with the manifest of a complete harvest whose file still hashes to it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 5 })))

		const current = await readCurrentHarvest({
			outputDir: scratch.path,
			filename: "address.jsonl",
			context: "test wfs",
			expect: expectation,
		})

		expect(current?.features_written).toBe(5)
	})

	it("answers with none when the data file no longer hashes to the manifest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		await harvestPagedWFS(harvestOptions(scratch.path, fakeService({ total: 5 })))
		await appendLocalTextFile("feature-5\n", PathBuilder.from(scratch.path)("address.jsonl"))

		const current = await readCurrentHarvest({
			outputDir: scratch.path,
			filename: "address.jsonl",
			context: "test wfs",
			expect: expectation,
		})

		expect(current).toBeNull()
	})

	it("answers with none when no harvest was written", async () => {
		await using scratch = await temporaryDirectory("mailwoman-wfs-harvest-")

		const current: WFSHarvestManifest | null = await readCurrentHarvest({
			outputDir: scratch.path,
			filename: "address.jsonl",
			context: "test wfs",
			expect: expectation,
		})

		expect(current).toBeNull()
	})
})
