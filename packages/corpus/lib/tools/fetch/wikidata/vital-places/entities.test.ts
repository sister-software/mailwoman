/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	buildEntitiesURL,
	createWikidataAPIClient,
	fetchVitalEntities,
	readCountryCodes,
	readEntityRecords,
	readVitalEntity,
	type VitalEntityRecord,
	WBGETENTITIES_BATCH,
	type WikidataEntityBody,
} from "#tools/fetch/wikidata/vital-places/entities"

function itemClaim(id: string, rank: "preferred" | "normal" | "deprecated" = "normal") {
	return { rank, mainsnak: { snaktype: "value", datavalue: { type: "wikibase-entityid", value: { id } } } }
}

/**
 * The Eiffel Tower as `wbgetentities` serializes it, reduced to the fields the module reads.
 */
const EIFFEL_TOWER: WikidataEntityBody = {
	id: "Q243",
	labels: { en: { value: "Eiffel Tower" }, fr: { value: "tour Eiffel" } },
	aliases: { en: [{ value: "La Tour Eiffel" }], fr: [] },
	claims: {
		P31: [itemClaim("Q1440476"), itemClaim("Q570116", "deprecated"), itemClaim("Q2319498")],
		P17: [itemClaim("Q142")],
		P625: [
			{
				rank: "normal",
				mainsnak: {
					snaktype: "value",
					datavalue: {
						type: "globecoordinate",
						value: { latitude: 48.858, longitude: 2.2945, globe: "http://www.wikidata.org/entity/Q2" },
					},
				},
			},
		],
		P1082: [
			{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { type: "quantity", value: { amount: "+100" } } } },
			{
				rank: "preferred",
				mainsnak: { snaktype: "value", datavalue: { type: "quantity", value: { amount: "+250" } } },
			},
		],
	},
	sitelinks: { enwiki: {}, frwiki: {}, dewiki: {} },
}

const ROW = { qid: "Q243", qrank: 5_000_000 }

describe("buildEntitiesURL", () => {
	it("asks for labels, aliases, claims and sitelinks in the named languages", () => {
		const url = new URL(buildEntitiesURL(["Q243", "Q42"], ["en", "fr"]))

		expect(url.origin + url.pathname).toBe("https://www.wikidata.org/w/api.php")
		expect(url.searchParams.get("action")).toBe("wbgetentities")
		expect(url.searchParams.get("ids")).toBe("Q243|Q42")
		expect(url.searchParams.get("props")).toBe("labels|aliases|claims|sitelinks")
		expect(url.searchParams.get("languages")).toBe("en|fr")
		expect(url.searchParams.get("format")).toBe("json")
	})

	it("refuses an empty batch and one over the API's limit", () => {
		expect(() => buildEntitiesURL([], ["en"])).toThrow(RangeError)

		expect(() =>
			buildEntitiesURL(
				Array.from({ length: WBGETENTITIES_BATCH + 1 }, (_, i) => `Q${i + 1}`),
				["en"]
			)
		).toThrow(RangeError)
	})
})

describe("readVitalEntity", () => {
	it("keeps the classes, country, Earth coordinate, preferred population, sitelinks, labels and aliases", () => {
		expect(readVitalEntity(ROW, EIFFEL_TOWER, ["en", "fr"])).toEqual({
			qid: "Q243",
			qrank: 5_000_000,
			classes: ["Q1440476", "Q2319498"],
			countries: ["Q142"],
			coordinate: { lat: 48.858, lon: 2.2945 },
			population: 250,
			sitelinks: 3,
			labels: { en: "Eiffel Tower", fr: "tour Eiffel" },
			aliases: { en: ["La Tour Eiffel"] },
		})
	})

	it("reads a coordinate on another globe as no coordinate", () => {
		const crater: WikidataEntityBody = {
			id: "Q1",
			claims: {
				P625: [
					{
						rank: "normal",
						mainsnak: {
							snaktype: "value",
							datavalue: {
								type: "globecoordinate",
								value: { latitude: 1, longitude: 2, globe: "http://www.wikidata.org/entity/Q111" },
							},
						},
					},
				],
			},
		}

		expect(readVitalEntity({ qid: "Q1", qrank: 1 }, crater, ["en"])).toMatchObject({
			coordinate: null,
			population: null,
		})
	})

	it("records a missing id as missing", () => {
		expect(readVitalEntity({ qid: "Q9", qrank: 1 }, { id: "Q9", missing: "" }, ["en"])).toEqual({
			qid: "Q9",
			qrank: 1,
			missing: true,
		})
	})
})

function stubAPI(results: StubResult[], cacheDir: string) {
	const transport = stubTransport(results)

	const client = createWikidataAPIClient({
		cacheDir,
		clock: createFakeClock(),
		axios: transport.axios,
		logger: silentLogger(),
	})

	return { client, transport }
}

describe("fetchVitalEntities", () => {
	it("requests only the ranked ids not yet on disk and appends their records", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-entities-")
		const entitiesPath = scratch.path("entities.jsonl")
		const present: VitalEntityRecord = { qid: "Q1", qrank: 9, missing: true }

		await writeLocalJSONLFile([present], entitiesPath)

		const { client, transport } = stubAPI(
			[{ body: { entities: { Q243: EIFFEL_TOWER, Q9: { id: "Q9", missing: "" } } } }],
			scratch.path("http-cache").toString()
		)

		await using _client = client
		const lines: string[] = []

		const result = await fetchVitalEntities(client, [{ qid: "Q1", qrank: 9 }, ROW, { qid: "Q9", qrank: 1 }], {
			entitiesPath,
			languages: ["en"],
			report: (line) => lines.push(line),
		})

		expect(result).toEqual({ skipped: 1, fetched: 2, failedBatches: [] })
		expect(transport.calls).toHaveLength(1)
		expect(new URL(transport.calls[0]!).searchParams.get("ids")).toBe("Q243|Q9")

		const records = await readEntityRecords(entitiesPath)

		expect(records.map((record) => record.qid)).toEqual(["Q1", "Q243", "Q9"])
		expect(lines[0]).toBe("  entities: 1 of 3 already on disk, 1 requests to go")
		expect(lines[1]).toMatch(/^ {2}entities: \[1\/1\] 2 fetched, 1 with a coordinate, \d+\.\d s$/u)
	})

	it("re-keys a redirected item under the requested id", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-redirect-")

		const { client } = stubAPI(
			[{ body: { entities: { Q243: { ...EIFFEL_TOWER, redirects: { from: "Q999", to: "Q243" } } } } }],
			scratch.path("http-cache").toString()
		)

		await using _client = client

		const entities = await client.getEntities(["Q999"], ["en"])

		expect(entities.get("Q999")?.id).toBe("Q243")
	})

	it("reports a failed request and leaves its ids for a rerun", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-failed-")
		const entitiesPath = scratch.path("entities.jsonl")

		const { client } = stubAPI(
			[{ status: 400, body: { error: { code: "no-such-entity" } } }],
			scratch.path("http-cache").toString()
		)

		await using _client = client
		const lines: string[] = []

		const result = await fetchVitalEntities(client, [ROW], { entitiesPath, report: (line) => lines.push(line) })

		expect(result).toEqual({ skipped: 0, fetched: 0, failedBatches: ["Q243"] })
		expect(lines.some((line) => line.startsWith("  ✗ entities: request 1 (Q243…): "))).toBe(true)
		await expect(readEntityRecords(entitiesPath)).resolves.toEqual([])
	})
})

describe("readCountryCodes", () => {
	it("asks only for the unknown countries and reads their alpha-2 codes", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-countries-")

		const france: WikidataEntityBody = {
			id: "Q142",
			claims: {
				P297: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { type: "string", value: "FR" } } }],
			},
		}

		const { client, transport } = stubAPI(
			[{ body: { entities: { Q142: france, Q15180: { id: "Q15180", claims: {} } } } }],
			scratch.path("http-cache").toString()
		)

		await using _client = client

		const codes = await readCountryCodes(client, ["Q30", "Q142", "Q15180"], { Q30: "US" })

		expect(codes).toEqual({ Q30: "US", Q142: "FR", Q15180: null })
		expect(transport.calls).toHaveLength(1)
		expect(new URL(transport.calls[0]!).searchParams.get("ids")).toBe("Q142|Q15180")
	})
})
