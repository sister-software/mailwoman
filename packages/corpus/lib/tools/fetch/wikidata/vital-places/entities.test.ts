/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createFakeClock, type FakeClock, realDelay } from "@mailwoman/core/api/test-clocks"
import {
	type AxiosOverrides,
	type StubRequestConfig,
	type StubResult,
	stubTransport,
} from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	buildEntitiesURL,
	createWikidataAPIClient,
	fetchVitalEntities,
	readCountryCodes,
	readEntityRecords,
	readVitalEntity,
	resolveConcurrency,
	SLOW_REQUEST_WAIT_MS,
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
		expect(url.searchParams.get("maxlag")).toBe("5")
		expect(url.searchParams.has("assert")).toBe(false)
		expect(new URL(buildEntitiesURL(["Q243"], ["en"], { assertUser: true })).searchParams.get("assert")).toBe("user")
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

function stubAPI(results: StubResult[], cacheDir: string, clock: FakeClock = createFakeClock()) {
	const transport = stubTransport(results, { clock })

	const client = createWikidataAPIClient({
		cacheDir,
		clock,
		axios: transport.axios,
		logger: silentLogger(),
	})

	return { client, transport, clock }
}

/**
 * A request header's value, whatever case the client set it in.
 */
function headerOf(config: StubRequestConfig, name: string): unknown {
	const entry = Object.entries(config.headers ?? {}).find(([key]) => key.toLowerCase() === name)

	return entry?.[1]
}

const CREDENTIALS = { username: "Mailwoman@vital", password: "hunter2-bot-secret" }

interface RoutedAPI {
	calls: StubRequestConfig[]
	maxInFlight: number
}

/**
 * A stub Action API that answers a login, `meta=userinfo` and any `wbgetentities` batch by
 * its ids, holding each request for a real event-loop turn so concurrent workers overlap.
 */
function routedAPI(options: { loginResult?: string } = {}): { state: RoutedAPI; axios: AxiosOverrides } {
	const state: RoutedAPI = { calls: [], maxInFlight: 0 }
	let inFlight = 0

	const respond = (config: StubRequestConfig, body: unknown, headers: Record<string, string> = {}) => ({
		data: stringifyJSON(body),
		status: 200,
		statusText: "OK",
		headers,
		config,
	})

	const adapter = async (config: StubRequestConfig & { method?: string; data?: unknown }): Promise<unknown> => {
		state.calls.push(config)

		inFlight++
		state.maxInFlight = Math.max(state.maxInFlight, inFlight)

		await realDelay(2)

		inFlight--

		const params = new URL(String(config.url)).searchParams

		if (config.method?.toLowerCase() === "post") {
			return respond(
				config,
				options.loginResult
					? { login: { result: options.loginResult, reason: `bad login for ${CREDENTIALS.username}` } }
					: { login: { result: "Success", lgusername: "Mailwoman" } },
				{ "set-cookie": "wikidatawikiSession=logged-in; path=/; HttpOnly" } as Record<string, string>
			)
		}

		if (params.get("meta") === "tokens") {
			return respond(
				config,
				{ query: { tokens: { logintoken: "token+\\" } } },
				{ "set-cookie": "wikidatawikiSession=anonymous; path=/" }
			)
		}

		if (params.get("meta") === "userinfo") {
			return respond(config, { query: { userinfo: { id: 7, name: "Mailwoman" } } })
		}

		const ids = params.get("ids")!.split("|")

		return respond(config, { entities: Object.fromEntries(ids.map((id) => [id, { id }])) })
	}

	// Structurally an Axios adapter, as `stubTransport` returns one.
	return { state, axios: { adapter } as AxiosOverrides }
}

function routedClient(cacheDir: string, axios: AxiosOverrides, credentials: typeof CREDENTIALS | null) {
	return createWikidataAPIClient({ cacheDir, clock: createFakeClock(), axios, logger: silentLogger(), credentials })
}

function rankedRows(count: number) {
	return Array.from({ length: count }, (_, index) => ({ qid: `Q${index + 1}`, qrank: count - index }))
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
		expect(lines[0]).toBe("  entities: 1 of 3 already on disk, 1 requests to go, 10 ids each, anonymous, concurrency 1")

		expect(lines[1]).toMatch(
			/^ {2}entities: \[1\/1\] 2 fetched, 1 with a coordinate, anonymous, concurrency 1, \d+\.\d{2} requests\/s, \d+\.\d s$/u
		)
	})

	it("sends entity requests past the HTTP cache with gzip asked for, and country lookups through it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-cache-")

		const { client, transport } = stubAPI(
			[{ body: { entities: { Q243: EIFFEL_TOWER } } }, { body: { entities: { Q142: { id: "Q142", claims: {} } } } }],
			scratch.path("http-cache").toString()
		)

		await using _client = client

		await fetchVitalEntities(client, [ROW], { entitiesPath: scratch.path("entities.jsonl"), languages: ["en"] })
		await readCountryCodes(client, ["Q142"])

		expect(transport.configs).toHaveLength(2)
		expect(transport.configs[0]!.cache).toBe(false)
		expect(transport.configs[1]!.cache).not.toBe(false)
		expect(headerOf(transport.configs[0]!, "accept-encoding")).toBe("gzip")
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

	it("requests again, in halves, the ids a size-truncated answer dropped", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-truncated-")

		const truncated = {
			result: { "*": "This result was truncated because it would otherwise be larger than the limit" },
		}

		const { client } = stubAPI(
			[
				{ body: { entities: { Q1: { id: "Q1" } }, warnings: truncated } },
				{ body: { entities: { Q2: { id: "Q2" } } } },
				{ body: { entities: { Q3: { id: "Q3" } } } },
			],
			scratch.path("http-cache").toString()
		)

		await using _client = client

		const entities = await client.getEntities(["Q1", "Q2", "Q3"], ["en"])

		expect([...entities.keys()].toSorted()).toEqual(["Q1", "Q2", "Q3"])
	})

	it("refuses an answer that drops an id without a truncation warning", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-dropped-")

		const { client } = stubAPI([{ body: { entities: { Q1: { id: "Q1" } } } }], scratch.path("http-cache").toString())

		await using _client = client

		await expect(client.getEntities(["Q1", "Q2"], ["en"])).rejects.toThrow(/no entity for Q2/u)
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

describe("WikidataAPIClient request limits", () => {
	it("waits five seconds after a request that took more than one second to serve, and only then", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-slow-")
		const clock = createFakeClock()
		const transport = stubTransport([{ body: { entities: { Q1: { id: "Q1" } } } }], { clock })
		const inner = transport.axios.adapter as (config: StubRequestConfig) => Promise<unknown>
		const serveMs = [1500, 200, 200]
		let request = 0

		const adapter = async (config: StubRequestConfig) => {
			const response = await inner(config)

			clock.advance(serveMs[request++] ?? 0)

			return response
		}

		await using client = createWikidataAPIClient({
			cacheDir: scratch.path("http-cache").toString(),
			clock,
			axios: { adapter } as AxiosOverrides,
			logger: silentLogger(),
		})

		for (let index = 0; index < 3; index++) {
			await client.getEntities(["Q1"], ["en"])
		}

		expect(clock.sleepCalls.filter((ms) => ms === SLOW_REQUEST_WAIT_MS)).toHaveLength(1)

		expect(transport.dispatchTimes[1]! - transport.dispatchTimes[0]!).toBeGreaterThanOrEqual(
			1500 + SLOW_REQUEST_WAIT_MS
		)

		expect(transport.dispatchTimes[2]! - transport.dispatchTimes[1]!).toBeLessThan(SLOW_REQUEST_WAIT_MS)
	})

	it("waits out a maxlag answer by its lag and asks again", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-maxlag-")

		const { client, transport, clock } = stubAPI(
			[
				{
					body: { error: { code: "maxlag", info: "Waiting for db1: 7 seconds lagged", lag: 7 } },
					headers: { "retry-after": "5", "x-database-lag": "7" },
				},
				{ body: { entities: { Q243: EIFFEL_TOWER } } },
			],
			scratch.path("http-cache").toString()
		)

		await using _client = client

		const entities = await client.getEntities(["Q243"], ["en"])

		expect(entities.get("Q243")?.id).toBe("Q243")
		expect(transport.calls).toHaveLength(2)
		expect(clock.sleepCalls).toContain(7000)
		expect(transport.dispatchTimes[1]! - transport.dispatchTimes[0]!).toBeGreaterThanOrEqual(7000)
	})

	it("caps the concurrency at one anonymously and three logged in", () => {
		expect(resolveConcurrency("anonymous")).toBe(1)
		expect(resolveConcurrency("anonymous", 3)).toBe(1)
		expect(resolveConcurrency("logged-in")).toBe(3)
		expect(resolveConcurrency("logged-in", 2)).toBe(2)
		expect(resolveConcurrency("logged-in", 8)).toBe(3)
		expect(() => resolveConcurrency("logged-in", 0)).toThrow(RangeError)
	})
})

describe("WikidataAPIClient login", () => {
	it("takes a login token, logs in, confirms through userinfo and sends the session cookie afterwards", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-login-")
		const { state, axios } = routedAPI()

		await using client = routedClient(scratch.path("http-cache").toString(), axios, CREDENTIALS)

		expect(client.mode).toBe("anonymous")
		await expect(client.logIn()).resolves.toBe("Mailwoman")
		expect(client.mode).toBe("logged-in")

		await client.getEntities(["Q1"], ["en"])

		const [token, login, userinfo, entities] = state.calls

		expect(new URL(String(token!.url)).searchParams.get("type")).toBe("login")
		expect(token!.cache).toBe(false)
		expect(headerOf(token!, "cookie")).toBeUndefined()

		const form = new URLSearchParams(String((login as { data?: unknown }).data))

		expect(form.get("action")).toBe("login")
		expect(form.get("lgname")).toBe(CREDENTIALS.username)
		expect(form.get("lgpassword")).toBe(CREDENTIALS.password)
		expect(form.get("lgtoken")).toBe("token+\\")
		expect(String(login!.url)).not.toContain(CREDENTIALS.password)
		expect(headerOf(login!, "cookie")).toBe("wikidatawikiSession=anonymous")

		expect(new URL(String(userinfo!.url)).searchParams.get("meta")).toBe("userinfo")
		expect(headerOf(userinfo!, "cookie")).toBe("wikidatawikiSession=logged-in")

		expect(headerOf(entities!, "cookie")).toBe("wikidatawikiSession=logged-in")
		expect(new URL(String(entities!.url)).searchParams.get("assert")).toBe("user")
	})

	it("reports a refused login without the credential values", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-login-failed-")
		const { axios } = routedAPI({ loginResult: "Failed" })

		await using client = routedClient(scratch.path("http-cache").toString(), axios, CREDENTIALS)

		const error = await client.logIn().then(
			() => null,
			(error_: unknown) => error_ as Error
		)

		expect(error?.message).toMatch(/^Wikidata login: action=login answered Failed: /u)
		expect(error?.message).not.toContain(CREDENTIALS.username)
		expect(error?.message).not.toContain(CREDENTIALS.password)
		expect(error?.cause).toBeUndefined()
		expect(client.mode).toBe("anonymous")
	})
})

describe("fetchVitalEntities with concurrent workers", () => {
	it("keeps one request in flight anonymously even when more are asked for", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-anonymous-")
		const { state, axios } = routedAPI()

		await using client = routedClient(scratch.path("http-cache").toString(), axios, null)
		const lines: string[] = []

		const result = await fetchVitalEntities(client, rankedRows(12), {
			entitiesPath: scratch.path("entities.jsonl"),
			languages: ["en"],
			batchSize: 2,
			concurrency: 3,
			report: (line) => lines.push(line),
		})

		expect(result.fetched).toBe(12)
		expect(state.maxInFlight).toBe(1)
		expect(lines[0]).toBe("  entities: concurrency 3 capped at 1 while anonymous")
	})

	it("runs three workers logged in, appends every record once and resumes by id", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-concurrent-")
		const entitiesPath = scratch.path("entities.jsonl")
		const rows = rankedRows(30)
		const present: VitalEntityRecord[] = rows.slice(0, 5).map((row) => ({ ...row, missing: true }))

		await writeLocalJSONLFile(present, entitiesPath)

		const { state, axios } = routedAPI()

		await using client = routedClient(scratch.path("http-cache").toString(), axios, CREDENTIALS)

		await client.logIn()

		const lines: string[] = []

		const result = await fetchVitalEntities(client, rows, {
			entitiesPath,
			languages: ["en"],
			batchSize: 3,
			report: (line) => lines.push(line),
		})

		expect(result).toEqual({ skipped: 5, fetched: 25, failedBatches: [] })
		expect(state.maxInFlight).toBe(3)

		const requested = state.calls
			.map((config) => new URL(String(config.url)).searchParams.get("ids"))
			.filter((ids): ids is string => typeof ids === "string")
			.flatMap((ids) => ids.split("|"))

		const expected = rows.slice(5).map((row) => row.qid)

		expect(requested.toSorted()).toEqual(expected.toSorted())

		const qids = (await readEntityRecords(entitiesPath)).map((record) => record.qid)

		expect(qids.toSorted()).toEqual(rows.map((row) => row.qid).toSorted())
		expect(new Set(qids).size).toBe(qids.length)

		expect(lines[0]).toBe(
			"  entities: 5 of 30 already on disk, 9 requests to go, 3 ids each, logged in as Mailwoman, concurrency 3"
		)

		expect(lines.at(-1)).toMatch(
			/^ {2}entities: \[9\/9\] 25 fetched, 0 with a coordinate, logged in as Mailwoman, concurrency 3, /u
		)

		const rerun = await fetchVitalEntities(client, rows, { entitiesPath, languages: ["en"], batchSize: 3 })

		expect(rerun).toEqual({ skipped: 30, fetched: 0, failedBatches: [] })
	})
})
