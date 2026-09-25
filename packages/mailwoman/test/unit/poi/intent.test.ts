import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import type { LocaleHint, PipelineResult } from "@mailwoman/core/pipeline"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import type { POIPhraseMatch } from "@mailwoman/kind-classifier"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { loadDefaultReverseGeocoder } from "mailwoman/default"
import { bindCountryScope, createPOIIntentStage, createPOINameLookup, poiTaxonomyLookup } from "mailwoman/poi"
import { createRuntimePipeline } from "mailwoman/runtime-pipeline"
import { describe, expect, it, vi } from "vitest"

const LOCALE: LocaleHint = { locale: "en-US", confidence: 1, alternatives: [], source: "caller" }

const anchorResult = (raw: string): PipelineResult => ({
	input: raw,
	normalized: { raw, normalized: raw },
	queryShape: { knownFormats: [] },
	locale: LOCALE,
	kind: { kind: "structured_address", confidence: 0.5, alternatives: [] },
	phraseProposals: [],
	tree: { raw, roots: [] },
	timing: {},
	faults: [],
	intentMarkers: [],
	path: "full",
})

describe("poiTaxonomyLookup adapter", () => {
	it("maps taxonomy matches into POIPhraseMatch shape", () => {
		const hits = poiTaxonomyLookup("drinking fountain", "en-US")
		expect(hits[0]?.categoryID).toBe("drinking_water")
		expect(hits[0]?.confidence).toBe(1)
		expect(hits[0]?.kind).toBe("category")
	})

	it.each([
		["restaurants", "restaurant"],
		["hotels", "hotel"],
		["pharmacies", "pharmacy"],
	])("recovers the English plural %s only through a taxonomy-backed singular", (phrase, categoryID) => {
		expect(poiTaxonomyLookup(phrase, "en-GB")[0]?.categoryID).toBe(categoryID)
	})

	it.each([
		["places of worship", "place_of_worship"],
		["churches", "place_of_worship"],
		["trains", "trains"],
		["flights", "airport"],
	])("resolves the curated query phrase %s", (phrase, categoryID) => {
		expect(poiTaxonomyLookup(phrase, "en-GB")[0]?.categoryID).toBe(categoryID)
	})

	it("falls through to the brand table on a category miss (exact brand name)", () => {
		const hits = poiTaxonomyLookup("chevron", "en-US")
		expect(hits[0]).toMatchObject({ kind: "brand", categoryID: "Chevron", wikidata: "Q319642", confidence: 1 })
	})

	it("chains through variant-aliases for locale-restricted brand slang, resolving a QID", () => {
		const hits = poiTaxonomyLookup("mcdo", "fr-FR")
		expect(hits[0]).toMatchObject({ kind: "brand", categoryID: "McDonald's", wikidata: "Q38076" })
	})

	it("does not chain locale-restricted brand slang without a locale", () => {
		expect(poiTaxonomyLookup("mcdo", undefined)).toEqual([])
	})

	it("does not match locale-restricted brand slang under an unrelated locale", () => {
		expect(poiTaxonomyLookup("mcdo", "en-US")).toEqual([])
	})

	it("recovers spelling only under the presumed language", () => {
		expect(poiTaxonomyLookup("hopital", "fr-FR")[0]).toMatchObject({
			kind: "category",
			categoryID: "hospital",
			matchedPhrase: "hôpital",
			mechanism: "locale_normalized",
		})

		expect(poiTaxonomyLookup("hopital", "en-US")[0]).toMatchObject({
			kind: "category",
			categoryID: "hospital",
			mechanism: "typo",
		})

		expect(poiTaxonomyLookup("resturant", "en-US")[0]).toMatchObject({
			kind: "category",
			categoryID: "restaurant",
			mechanism: "typo",
		})

		expect(poiTaxonomyLookup("resturant", undefined)).toEqual([])
	})

	it("does not presume that Boots means pharmacy in the US", () => {
		expect(poiTaxonomyLookup("boots", "en-US")).toEqual([])
	})

	it("prefers a category match over a brand match when both could apply (precedence, structural)", () => {
		const hits = poiTaxonomyLookup("hospital", "en-US")
		expect(hits[0]?.kind).toBe("category")
	})
})

describe("createPOINameLookup", () => {
	const statueHit = { name: "Statue of Liberty", confidence: 0.99 }

	it("turns an exact FTS candidate into positive name evidence", () => {
		const lookup = createPOINameLookup({ search: () => [statueHit] })

		expect(lookup("statue OF liberty", "en-US")).toEqual([
			{
				kind: "name",
				categoryID: "Statue of Liberty",
				matchedPhrase: "Statue of Liberty",
				confidence: 1,
			},
		])
	})

	it("rejects an FTS token-overlap candidate whose full name differs", () => {
		const lookup = createPOINameLookup({
			search: () => [{ name: "Statue of Liberty Museum", confidence: 0.8 }],
		})

		expect(lookup("Statue of Liberty", "en-US")).toEqual([])
	})

	it.each([
		["東京タワー", "東京タワー"],
		["MÜNCHEN HBF", "München Hbf"],
		["Cafe\u0301 de Flore", "Café de Flore"],
	])("accepts normalized exact multilingual name evidence for %s", (query, canonical) => {
		const lookup = createPOINameLookup({ search: () => [{ name: canonical, confidence: 0.9 }] })

		expect(lookup(query)[0]).toMatchObject({ kind: "name", categoryID: canonical, matchedPhrase: canonical })
	})

	it("promotes an exact known name into the POI lane", async () => {
		const lookup = createPOINameLookup({ search: () => [statueHit] })
		const classify = createKindClassifier({ poiLexicon: lookup })

		const result = await classify(
			{ raw: "Statue of Liberty", normalized: "Statue of Liberty" },
			{ knownFormats: [] },
			LOCALE
		)

		expect(result.kind).toBe("poi_query")
	})
})

describe("createPOIIntentStage", () => {
	it("returns a name intent for an exact known POI", async () => {
		const lookup = createPOINameLookup({ search: () => [{ name: "Statue of Liberty", confidence: 0.99 }] })
		const stage = createPOIIntentStage({ lookup, parseAnchor: async (text) => anchorResult(text) })
		const outcome = await stage({ raw: "Statue of Liberty", normalized: "Statue of Liberty" }, LOCALE)

		expect(outcome).toEqual({
			type: "intent",
			intent: { subject: { kind: "name", text: "Statue of Liberty" } },
		})
	})

	it("returns a category intent with a parsed anchor", async () => {
		const parsed: string[] = []

		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async (text) => {
				parsed.push(text)

				return anchorResult(text)
			},
		})

		const outcome = await stage(
			{ raw: "hospital near Springfield IL", normalized: "hospital near Springfield IL" },
			LOCALE
		)

		expect(outcome?.type).toBe("intent")

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).toEqual({ kind: "category", categoryIDs: ["hospital"], matched: "hospital" })
		expect(outcome.intent.anchor?.text).toBe("Springfield IL")
		expect(outcome.intent.relation).toBe("near")
		expect(parsed).toEqual(["Springfield IL"])
	})

	it("returns a brand intent with a parsed anchor", async () => {
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async (text) => anchorResult(text),
		})

		const outcome = await stage({ raw: "chevron near Houston TX", normalized: "chevron near Houston TX" }, LOCALE)

		expect(outcome?.type).toBe("intent")

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).toEqual({
			kind: "brand",
			name: "Chevron",
			wikidata: "Q319642",
			matched: "Chevron",
		})

		expect(outcome.intent.anchor?.text).toBe("Houston TX")
	})

	it("returns a bare-subject intent with no anchor and no anchor parse", async () => {
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async () => {
				throw new Error("must not parse an anchor for a bare subject")
			},
		})

		const outcome = await stage({ raw: "fire hydrant", normalized: "fire hydrant" }, LOCALE)

		expect(outcome?.type).toBe("intent")
	})

	it("returns null when no subject matches (fall-through)", async () => {
		const stage = createPOIIntentStage({ lookup: poiTaxonomyLookup, parseAnchor: async (t) => anchorResult(t) })
		const outcome = await stage({ raw: "Empire State Building", normalized: "Empire State Building" }, LOCALE)

		expect(outcome).toBeNull()
	})
})

const resolvedAnchor = (raw: string, country: string | undefined): PipelineResult => ({
	...anchorResult(raw),
	tree: {
		raw,
		roots: [
			{
				tag: "locality",
				value: raw,
				start: 0,
				end: raw.length,
				confidence: 0.9,
				children: [],
				lat: 48.82,
				lon: 1.7553,
				...(country ? { metadata: { resolver_country: country } } : {}),
			},
		],
	},
})

const PRESCRIPTION_SET: POIPhraseMatch[] = [
	{
		kind: "category",
		categoryID: "drugstore",
		matchedPhrase: "prescription",
		confidence: 1,
		searchAsSet: true,
		countryScope: ["US"],
	},
	{ kind: "category", categoryID: "pharmacy", matchedPhrase: "prescription", confidence: 1, searchAsSet: true },
]

const prescriptionLookup = (phrase: string): ReadonlyArray<POIPhraseMatch> =>
	phrase === "prescription" ? PRESCRIPTION_SET : []

describe("The place binding of a country-scoped claim", () => {
	it("drops a scoped category at an anchor outside its scope, and records what fell out", async () => {
		const stage = createPOIIntentStage({
			lookup: prescriptionLookup,
			parseAnchor: async (text) => resolvedAnchor(text, "FR"),
		})

		const outcome = await stage(
			{ raw: "prescription near Garancières", normalized: "prescription near Garancières" },
			LOCALE
		)

		if (outcome?.type !== "intent") throw new Error(`expected an intent, got ${stringifyJSON(outcome)}`)

		expect(outcome.intent.subject).toEqual({
			kind: "category",
			categoryIDs: ["pharmacy"],
			matched: "prescription",
			countryBinding: { anchorCountry: "FR", excludedCategoryIDs: ["drugstore"] },
		})
	})

	it("keeps a scoped category at an anchor inside its scope, and still records the binding", async () => {
		const stage = createPOIIntentStage({
			lookup: prescriptionLookup,
			parseAnchor: async (text) => resolvedAnchor(text, "US"),
		})

		const outcome = await stage(
			{ raw: "prescription near Denver CO", normalized: "prescription near Denver CO" },
			LOCALE
		)

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).toEqual({
			kind: "category",
			categoryIDs: ["drugstore", "pharmacy"],
			matched: "prescription",
			countryBinding: { anchorCountry: "US", excludedCategoryIDs: [] },
		})
	})

	it("admits no scoped claim when the anchor resolved to no country, or when there is no anchor", async () => {
		const countryless = createPOIIntentStage({
			lookup: prescriptionLookup,
			parseAnchor: async (text) => resolvedAnchor(text, undefined),
		})

		const bare = createPOIIntentStage({
			lookup: prescriptionLookup,
			parseAnchor: async () => {
				throw new Error("must not parse an anchor for a bare subject")
			},
		})

		for (const outcome of [
			await countryless({ raw: "prescription near Zzyzx", normalized: "prescription near Zzyzx" }, LOCALE),
			await bare({ raw: "prescription", normalized: "prescription" }, LOCALE),
		]) {
			if (outcome?.type !== "intent") throw new Error("unreachable")

			expect(outcome.intent.subject).toMatchObject({
				categoryIDs: ["pharmacy"],
				countryBinding: { anchorCountry: null, excludedCategoryIDs: ["drugstore"] },
			})
		}
	})

	it("abstains as country_scope_excluded when every reached category falls out", async () => {
		const stage = createPOIIntentStage({
			lookup: (phrase) => (phrase === "prescription" ? [PRESCRIPTION_SET[0]!] : []),
			parseAnchor: async (text) => resolvedAnchor(text, "FR"),
			execute: () => {
				throw new Error("the executor must not run on an emptied set")
			},
		})

		const outcome = await stage({ raw: "prescription near Toulouse", normalized: "prescription near Toulouse" }, LOCALE)

		expect(outcome).toEqual({ type: "abstain", reason: "country_scope_excluded" })
	})

	it("records no binding when no reached category carries a scope — there was nothing to bind", async () => {
		const stage = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			parseAnchor: async (text) => resolvedAnchor(text, "FR"),
		})

		const outcome = await stage({ raw: "hospital near Toulouse", normalized: "hospital near Toulouse" }, LOCALE)

		if (outcome?.type !== "intent") throw new Error("unreachable")

		expect(outcome.intent.subject).not.toHaveProperty("countryBinding")
	})

	it("bindCountryScope keeps a category that an unscoped hit also reaches", () => {
		const scoped: POIPhraseMatch = { ...PRESCRIPTION_SET[1]!, countryScope: ["US"] }

		expect(bindCountryScope([scoped, PRESCRIPTION_SET[1]!], "FR")).toEqual({
			anchorCountry: "FR",
			categoryIDs: ["pharmacy"],
			excludedCategoryIDs: [],
		})

		expect(bindCountryScope([PRESCRIPTION_SET[1]!], "FR")).toBeNull()

		const lowerScoped: POIPhraseMatch = { ...PRESCRIPTION_SET[0]!, countryScope: ["us"] }

		expect(bindCountryScope([lowerScoped], "US")?.categoryIDs).toEqual(["drugstore"])
	})
})

const HERMETIC = { placeCountry: false as const, streetEvidence: false as const }

describe("createRuntimePipeline poiQueryKind flag", () => {
	it("ON by default: a category phrase takes the poi path without opting in", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC })
		const result = await pipeline("hospital")

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		expect(result.kind.kind).toBe("poi_category")
		expect(result.kind.alternatives.map((a) => a.kind)).toContain("poi_query")
		expect(result.intentMarkers.map((m) => m.code)).toEqual(["poi_category"])
	})

	it("OFF: poiQueryKind: false disables the poi path entirely", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: false })
		const result = await pipeline("hospital")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
		expect(result.kind.kind).not.toBe("poi_query")
	})

	it("ON: a category phrase takes the poi path end-to-end", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("hospital near Springfield")

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(result.poiIntent.intent.subject).toEqual({
			kind: "category",
			categoryIDs: ["hospital"],
			matched: "hospital",
		})

		expect(result.poiIntent.intent.anchor?.text).toBe("Springfield")
	})

	it.each([
		["restaurants in Carmel-by-the-Sea", "restaurant", "in", "Carmel-by-the-Sea"],
		["hotels near Stow-on-the-Wold", "hotel", "near", "Stow-on-the-Wold"],
		["trains to Newcastle-upon-Tyne", "trains", "to", "Newcastle-upon-Tyne"],
		["flights to Isle of Man", "airport", "to", "Isle of Man"],
		["pharmacies in City of London", "pharmacy", "in", "City of London"],
		["churches near Church of the Holy Sepulchre", "place_of_worship", "near", "Church of the Holy Sepulchre"],
		["places of worship in Stratford-upon-Avon", "place_of_worship", "in", "Stratford-upon-Avon"],
	] as const)("keeps span-first POI semantics for %s", async (query, categoryID, relation, anchor) => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline(query, { locale: "en-GB" })

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(result.poiIntent.intent.subject.kind).toBe("category")

		if (result.poiIntent.intent.subject.kind !== "category") throw new Error("unreachable")

		expect(result.poiIntent.intent.subject.categoryIDs).toEqual([categoryID])
		expect(result.poiIntent.intent.relation).toBe(relation)
		expect(result.poiIntent.intent.anchor?.text).toBe(anchor)
	})

	it.each([
		["restaurant in München", "de-DE", "restaurant", "München"],
		["hotel near São Tomé and Príncipe", "pt-PT", "hotel", "São Tomé and Príncipe"],
		["pharmacy in مدينة الكويت", "ar-KW", "pharmacy", "مدينة الكويت"],
		["restaurant in 東京", "ja-JP", "restaurant", "東京"],
		["hotel near Санкт-Петербург", "ru-RU", "hotel", "Санкт-Петербург"],
	] as const)("preserves the multilingual anchor in %s", async (query, locale, categoryID, anchor) => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline(query, { locale })

		expect(result.path).toBe("poi")
		expect(result.poiIntent?.type).toBe("intent")

		if (result.poiIntent?.type !== "intent" || result.poiIntent.intent.subject.kind !== "category") {
			throw new Error("unreachable")
		}

		expect(result.poiIntent.intent.subject.categoryIDs).toEqual([categoryID])
		expect(result.poiIntent.intent.anchor?.text).toBe(anchor)
	})

	it.each(["Carmel-by-the-Sea", "12 Carmel-by-the-Sea Road", "Church of the Holy Sepulchre"])(
		"does not route the control %s as a category query",
		async (query) => {
			const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
			const result = await pipeline(query, { locale: "en-GB" })

			expect(result.path).not.toBe("poi")
		}
	)

	it("routes an exact poi.db name hit and rejects a longer token-overlap control", async () => {
		await using directoryDirectory = await temporaryDirectory("mailwoman-poi-name-")
		const directory = directoryDirectory.path
		const databasePath = directory("poi.db")
		const db = new DatabaseClient<POIDatabase>(databasePath)
		vi.stubEnv("MAILWOMAN_DATA_ROOT", "/nonexistent/never/mailwoman-data-root")

		try {
			db.exec(`
				CREATE TABLE poi_category_codes (id INTEGER PRIMARY KEY, category TEXT NOT NULL UNIQUE);
				CREATE TABLE poi (
					h3_cell INTEGER NOT NULL,
					category_id INTEGER NOT NULL,
					neg_rank REAL NOT NULL,
					name TEXT,
					brand_wikidata TEXT,
					latitude REAL NOT NULL,
					longitude REAL NOT NULL,
					country TEXT NOT NULL,
					confidence REAL NOT NULL,
					name_key TEXT,
					gers_id TEXT
				);
				CREATE INDEX poi_name_key ON poi(name_key);
				CREATE VIRTUAL TABLE poi_search USING fts5(name, name_key UNINDEXED, h3_cell UNINDEXED);
			`)

			const nameKey = "statueofliberty"

			db.prepare(
				`INSERT INTO poi
				 (h3_cell, category_id, neg_rank, name, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(0, 0, -0.99, "Statue of Liberty", null, 40.6892, -74.0445, "US", 0.99, nameKey, "statue")

			db.prepare("INSERT INTO poi_search (name, name_key, h3_cell) VALUES (?, ?, ?)").run(
				"Statue of Liberty",
				nameKey,
				0
			)

			const tokyoNameKey = "東京タワー"

			db.prepare(
				`INSERT INTO poi
				 (h3_cell, category_id, neg_rank, name, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(0, 0, -0.98, "東京タワー", null, 35.6586, 139.7454, "JP", 0.98, tokyoNameKey, "tokyo-tower")

			db.prepare("INSERT INTO poi_search (name, name_key, h3_cell) VALUES (?, ?, ?)").run("東京タワー", tokyoNameKey, 0)

			await db.destroy()

			const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: { poiDatabasePath: databasePath } })
			const result = await pipeline("Statue of Liberty", { locale: "en-US" })

			expect(result.path).toBe("poi")
			expect(result.poiIntent?.type).toBe("intent")

			if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

			expect(result.poiIntent.intent.subject).toEqual({ kind: "name", text: "Statue of Liberty" })
			expect(result.poiIntent.results?.[0]?.name).toBe("Statue of Liberty")

			const multilingual = await pipeline("東京タワー", { locale: "ja-JP" })

			expect(multilingual.path).toBe("poi")
			expect(multilingual.poiIntent?.type).toBe("intent")

			if (multilingual.poiIntent?.type !== "intent") throw new Error("unreachable")

			expect(multilingual.poiIntent.intent.subject).toEqual({ kind: "name", text: "東京タワー" })
			expect(multilingual.poiIntent.results?.[0]?.name).toBe("東京タワー")

			const overlap = await pipeline("Statue of Liberty Museum", { locale: "en-US" })

			expect(overlap.path).not.toBe("poi")
		} finally {
			try {
				await db.destroy()
			} catch {}

			vi.unstubAllEnvs()
		}
	})

	it("ON: a plain address stays on the normal path", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("350 5th Ave, New York, NY 10118")

		expect(result.path).not.toBe("poi")
		expect("poiIntent" in result).toBe(false)
	})

	it("ON: a bare build-local-only category (neither local layer nor db) abstains", async () => {
		const pipeline = createRuntimePipeline({ ...HERMETIC, poiQueryKind: true })
		const result = await pipeline("fire hydrant")

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual({ type: "abstain", reason: "requires_build_local_layer" })
	})

	it("object form: reverse-geocoder degrade is hermetic — no throw, intent outcome, results (if any) carry no ancestry", async () => {
		vi.stubEnv("MAILWOMAN_DATA_ROOT", "/nonexistent/never/mailwoman-data-root")

		try {
			await expect(loadDefaultReverseGeocoder()).resolves.toBeNull()

			const pipeline = createRuntimePipeline({
				...HERMETIC,
				poiQueryKind: { poiDatabasePath: "/nonexistent/never/ancestry-degrade-poi.db" },
			})

			const result = await pipeline("hospital near Springfield")

			expect(result.path).toBe("poi")
			expect(result.poiIntent?.type).toBe("intent")

			if (result.poiIntent?.type !== "intent") throw new Error("unreachable")

			for (const poiResult of result.poiIntent.results ?? []) {
				expect(poiResult).not.toHaveProperty("ancestry")
			}
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("Object form degrades to intent-only when the poi db is missing (neither throw nor retry storm)", async () => {
		const pipeline = createRuntimePipeline({
			...HERMETIC,
			poiQueryKind: { poiDatabasePath: "/nonexistent/never/poi.db" },
		})

		const first = await pipeline("hospital near Springfield")
		expect(first.path).toBe("poi")
		expect(first.poiIntent?.type).toBe("intent")

		if (first.poiIntent?.type !== "intent") throw new Error("unreachable")

		expect(first.poiIntent.results).toBeUndefined()

		const second = await pipeline("hospital near Springfield")
		expect(second.poiIntent?.type).toBe("intent")
	})
})
