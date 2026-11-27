// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The acceptance fixtures of `docs/engineering/reference/outcome-kinds.mdx`,
 *   over a fixture candidate.db built through the real {@link buildCandidateTable} and a
 *   fixture landmarks.db, each given the two outcome tables, behind the real resolver walk.
 *
 *   The trees stand for the parse, so a fixture states the spans the parser reads.
 *   The outcome head is a stub distribution.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { ResolvedPlace, ResolveOpts } from "@mailwoman/core/resolver"
import {
	OutcomeRefusal,
	OutcomeRequestError,
	type OutcomeMembership,
	type OutcomeOptions,
	type OutcomeVocabularyLike,
	type ResolveOutcome,
} from "@mailwoman/core/resolver/outcome"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build/candidate"
import {
	createLandmarkTables,
	LandmarkSqliteLookup,
	type LandmarkDatabase,
} from "@mailwoman/resolver-wof-sqlite/landmark"
import { landmarkNameKey } from "@mailwoman/resolver-wof-sqlite/landmark/rows"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type Kysely, sql } from "kysely"
import type { PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { extractGeocodeResult } from "#geocode/result"
import { applyOutcomeResult, resolveOutcomeFor } from "#geocode/result/outcome"

/**
 * The vocabulary table of the design, numbered in its order.
 */
const VOCABULARY: readonly OutcomeVocabularyLike[] = [
	"address",
	"address.street",
	"address.intersection",
	"place",
	"place.neighbourhood",
	"place.borough",
	"place.locality",
	"place.county",
	"place.region",
	"place.country",
	"place.continent",
	"postal",
	"natural",
	"natural.mountain",
	"natural.water",
	"natural.island",
	"natural.forest",
	"natural.beach",
	"venue",
	"venue.park",
	"venue.campus",
	"venue.cemetery",
	"venue.stadium",
	"transit",
	"transit.airport",
	"transit.station",
	"transit.port",
	"landmark",
].map((name, i) => ({ id: i + 1, name, facet: name === "landmark" ? "role" : "identity" }))

const idOf = (name: string): number => VOCABULARY.find((m) => m.name === name)!.id

/**
 * An id the database's newer revision holds and the request's vocabulary doesn't.
 */
const NEWER_MEMBER_ID = 99

const USA = 100
const OREGON = 101
const PORTLAND = 102
const MT_TABOR_HOOD = 103
const NEW_YORK = 104
const MANHATTAN = 105
const ISRAEL = 106

const MANHATTAN_ITEM = "Q11299"
const BUTTE = "Q1952960"
const MOUNT_TABOR_ISRAEL = "Q207128"
const MT_TABOR_PARK = "Q6926051"

function buildFixtureAdmin(path: PathBuilderLike): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		INSERT INTO spr VALUES (${USA}, 'United States', 'country', 'US', 39.0, -97.0, 24.5, -125.0, 49.4, -66.9, -1, 0);
		INSERT INTO spr VALUES (${OREGON}, 'Oregon', 'region', 'US', 44.0, -120.5, 42.0, -124.6, 46.3, -116.5, -1, 0);
		INSERT INTO spr VALUES (${PORTLAND}, 'Portland', 'locality', 'US', 45.52, -122.68, 45.43, -122.84, 45.65, -122.47, -1, 0);
		INSERT INTO spr VALUES (${MT_TABOR_HOOD}, 'Mt. Tabor', 'neighbourhood', 'US', 45.5175, -122.59, 45.51, -122.6, 45.52, -122.58, -1, 0);
		INSERT INTO spr VALUES (${NEW_YORK}, 'New York', 'region', 'US', 43.0, -75.5, 40.5, -79.8, 45.0, -71.8, -1, 0);
		INSERT INTO spr VALUES (${MANHATTAN}, 'Manhattan', 'borough', 'US', 40.78, -73.97, 40.7, -74.02, 40.88, -73.91, -1, 0);
		INSERT INTO spr VALUES (${ISRAEL}, 'Israel', 'country', 'IL', 31.4, 35.0, 29.5, 34.3, 33.3, 35.9, -1, 0);

		INSERT INTO place_population VALUES (${PORTLAND}, 650000);
		INSERT INTO place_population VALUES (${MT_TABOR_HOOD}, 10000);
		INSERT INTO place_population VALUES (${MANHATTAN}, 1600000);
		INSERT INTO place_population VALUES (${OREGON}, 4200000);
		INSERT INTO place_population VALUES (${NEW_YORK}, 19500000);

		INSERT INTO ancestors VALUES (${PORTLAND}, ${OREGON}, 'region');
		INSERT INTO ancestors VALUES (${PORTLAND}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${MT_TABOR_HOOD}, ${PORTLAND}, 'locality');
		INSERT INTO ancestors VALUES (${MT_TABOR_HOOD}, ${OREGON}, 'region');
		INSERT INTO ancestors VALUES (${MT_TABOR_HOOD}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${OREGON}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${MANHATTAN}, ${NEW_YORK}, 'region');
		INSERT INTO ancestors VALUES (${MANHATTAN}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${NEW_YORK}, ${USA}, 'country');
	`)
}

interface OutcomeTablesDatabase {
	outcome_default: { placetype: string; outcome_id: number }
	record_outcome: { spr_id: number; qid: string; outcome_id: number; contested: number }
	concordances: { id: number; other_id: string; other_source: string }
}

/**
 * Adds the two outcome tables, keyed by `recordColumn`, to a built database.
 */
async function addOutcomeTables(
	db: Kysely<OutcomeTablesDatabase>,
	recordColumn: "spr_id" | "qid",
	defaults: ReadonlyArray<[placetype: string, outcome: string]>,
	asserted: ReadonlyArray<[record: string | number, outcomeID: number, contested: boolean]>
): Promise<void> {
	await db.schema
		.createTable("outcome_default")
		.addColumn("placetype", "text", (c) => c.notNull())
		.addColumn("outcome_id", "integer", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable("record_outcome")
		.addColumn(recordColumn, recordColumn === "qid" ? "text" : "integer", (c) => c.notNull())
		.addColumn("outcome_id", "integer", (c) => c.notNull())
		.addColumn("contested", "integer", (c) => c.notNull())
		.execute()

	for (const [placetype, outcome] of defaults) {
		await db
			.insertInto("outcome_default")
			.values({ placetype, outcome_id: idOf(outcome) })
			.execute()
	}

	// The record column differs between the two layers, so the row is written by column reference.
	for (const [record, outcomeID, contested] of asserted) {
		await sql`INSERT INTO record_outcome (${sql.ref(recordColumn)}, outcome_id, contested) VALUES (${record}, ${outcomeID}, ${contested ? 1 : 0})`.execute(
			db
		)
	}
}

async function buildFixtureCandidate(input: PathBuilderLike, output: PathBuilderLike, withOutcomes: boolean) {
	await buildCandidateTable({ input, output })

	if (!withOutcomes) return

	using db = new DatabaseClient<OutcomeTablesDatabase>(output)

	await addOutcomeTables(
		db,
		"spr_id",
		[
			["neighbourhood", "place.neighbourhood"],
			["borough", "place.borough"],
			["locality", "place.locality"],
			["region", "place.region"],
			["country", "place.country"],
		],
		[
			[MANHATTAN, idOf("natural.island"), false],
			// A member the database's newer revision added.
			[PORTLAND, NEWER_MEMBER_ID, false],
		]
	)

	await db.schema
		.createTable("concordances")
		.addColumn("id", "integer", (c) => c.notNull())
		.addColumn("other_id", "text", (c) => c.notNull())
		.addColumn("other_source", "text", (c) => c.notNull())
		.execute()

	await db
		.insertInto("concordances")
		.values({ id: MANHATTAN, other_id: MANHATTAN_ITEM, other_source: "wd:id" })
		.execute()
}

async function buildFixtureLandmarks(path: PathBuilderLike): Promise<void> {
	using db = new DatabaseClient<LandmarkDatabase & OutcomeTablesDatabase>(path)

	await createLandmarkTables(db)

	const row = (
		name: string,
		written: string,
		qid: string,
		country: string,
		lat: number,
		lon: number,
		sitelinks: number
	) => ({
		name_key: landmarkNameKey(written),
		qid,
		name,
		kind: "venue" as const,
		country,
		latitude: lat,
		longitude: lon,
		sitelinks,
		code: null,
		is_primary: 1,
		importance: null,
		h3_cell: null,
	})

	await db
		.insertInto("landmark_name")
		.values([
			row("Mount Tabor", "Mt. Tabor", BUTTE, "US", 45.511, -122.594, 12),
			row("Mount Tabor", "Mt. Tabor", MOUNT_TABOR_ISRAEL, "IL", 32.687, 35.39, 60),
			row("Mt. Tabor Park", "Mt. Tabor Park", MT_TABOR_PARK, "US", 45.511, -122.594, 3),
			row("Manhattan", "Manhattan", MANHATTAN_ITEM, "US", 40.78, -73.97, 200),
		])
		.execute()

	await addOutcomeTables(
		db,
		"qid",
		[],
		[
			[BUTTE, idOf("natural.mountain"), false],
			[BUTTE, idOf("landmark"), false],
			[MOUNT_TABOR_ISRAEL, idOf("natural.mountain"), false],
			[MOUNT_TABOR_ISRAEL, idOf("landmark"), false],
			[MT_TABOR_PARK, idOf("venue.park"), false],
			[MT_TABOR_PARK, idOf("landmark"), false],
			[MANHATTAN_ITEM, idOf("natural.island"), true],
		]
	)
}

let scratch: TemporaryDirectory
let candidate: WOFCandidateTableLookup
let predating: WOFCandidateTableLookup
let landmarks: LandmarkSqliteLookup

beforeAll(async () => {
	scratch = await temporaryDirectory("mailwoman-outcome-fixtures-")

	const admin = scratch.path("admin.db")

	buildFixtureAdmin(admin)
	await buildFixtureCandidate(admin, scratch.path("candidate.db"), true)
	await buildFixtureCandidate(admin, scratch.path("candidate-predating.db"), false)
	await buildFixtureLandmarks(scratch.path("landmarks.db"))

	candidate = new WOFCandidateTableLookup({ databasePath: scratch.path("candidate.db") })
	predating = new WOFCandidateTableLookup({ databasePath: scratch.path("candidate-predating.db") })
	landmarks = new LandmarkSqliteLookup(scratch.path("landmarks.db"))
})

afterAll(async () => {
	candidate[Symbol.dispose]()
	predating[Symbol.dispose]()
	landmarks[Symbol.dispose]()
	await scratch[Symbol.asyncDispose]()
})

function node(tag: string, value: string, start: number, children: AddressNode[] = []): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start, end: start + value.length, confidence: 0.9, children }
}

function outcomeOf(options: OutcomeOptions, head: readonly string[] | null = null): ResolveOutcome {
	return resolveOutcomeFor(
		options,
		{ vocabulary: VOCABULARY, headOrder: head, headOrdering: !!head },
		{ kind: "bare_toponym", interpretedSpan: false }
	)!
}

async function resolve(tree: AddressTree, outcome: ResolveOutcome | null, backend = candidate): Promise<AddressTree> {
	const opts: ResolveOpts = { landmarks, writtenInput: tree.raw, ...(outcome ? { outcome } : {}) }

	return createWOFResolver(backend).resolveTree(tree, opts)
}

/**
 * The resolved node of the leading span, and its places in rank order: the answer, then its alternatives.
 */
function ranking(resolved: AddressTree): { answer: AddressNode; places: Array<{ id: string; outcomes: string[] }> } {
	const answer = [...walkNodes(resolved.roots)].toSorted((a, b) => a.start - b.start)[0]!
	const alternatives = (answer.alternatives ?? []) as ResolvedPlace[]

	const names = (members: readonly OutcomeMembership[] | null | undefined) => (members ?? []).map((m) => m.outcome)

	return {
		answer,
		places: [
			{ id: String(answer.placeID), outcomes: names(answer.metadata?.["outcomes"] as OutcomeMembership[]) },
			...alternatives.map((a) => ({
				id: typeof a.id === "number" ? `wof:${a.id}` : `wikidata:${a.id}`,
				outcomes: names(a.outcomes),
			})),
		],
	}
}

const bareTabor = (): AddressTree => ({ raw: "Mt. Tabor", roots: [node("locality", "Mt. Tabor", 0)] })

function geocode(tree: AddressTree, resolved: AddressTree, outcome: ResolveOutcome, headLoaded = false): GeocodeResult {
	return applyOutcomeResult(extractGeocodeResult(tree.raw, resolved), resolved, outcome, {
		kind: "bare_toponym",
		headLoaded,
		unresolved: () => extractGeocodeResult(tree.raw, tree),
	})
}

describe("outcome kinds: the acceptance fixtures", () => {
	test("`Mt. Tabor` lists the neighborhood and both mountains, each with its outcome set", async () => {
		const { places } = ranking(await resolve(bareTabor(), outcomeOf({}, ["place", "natural"])))

		expect(places.map((p) => p.id)).toEqual([
			`wof:${MT_TABOR_HOOD}`,
			`wikidata:${MOUNT_TABOR_ISRAEL}`,
			`wikidata:${BUTTE}`,
		])

		expect(places[0]!.outcomes).toEqual(["place.neighbourhood"])
		expect(places[1]!.outcomes).toEqual(["landmark", "natural.mountain"])
	})

	test("`Mt. Tabor` with the hint `natural.mountain` answers a mountain and keeps the neighborhood", async () => {
		const tree = bareTabor()
		const resolved = await resolve(tree, outcomeOf({ outcomeHint: "natural.mountain" }))
		const { places } = ranking(resolved)

		expect(places[0]!.outcomes).toContain("natural.mountain")
		expect(places.map((p) => p.id)).toContain(`wof:${MT_TABOR_HOOD}`)

		const result = geocode(tree, resolved, outcomeOf({ outcomeHint: "natural.mountain" }))

		expect(result.lat).toBeCloseTo(32.687, 3)
		expect(result.intent_markers.map((m) => m.code)).not.toContain("outcome_hint_unsatisfied")
		expect(result.candidates[0]!.outcomes?.map((m) => m.outcome)).toEqual(["landmark", "natural.mountain"])
	})

	test("`Mt. Tabor Park` answers the park with zero hints and with `natural.mountain`, and reports that hint unsatisfied", async () => {
		const tree = (): AddressTree => ({ raw: "Mt. Tabor Park", roots: [node("venue", "Mt. Tabor Park", 0)] })

		const unhinted = await resolve(tree(), null)
		const hinted = await resolve(tree(), outcomeOf({ outcomeHint: "natural.mountain" }))

		expect(ranking(unhinted).answer.placeID).toBe(`wikidata:${MT_TABOR_PARK}`)
		expect(ranking(hinted).answer.placeID).toBe(`wikidata:${MT_TABOR_PARK}`)

		const result = geocode(tree(), hinted, outcomeOf({ outcomeHint: "natural.mountain" }))

		expect(result.intent_markers.map((m) => m.code)).toContain("outcome_hint_unsatisfied")
	})

	test("`Mt. Tabor, Portland, Oregon` never puts the mountain in Israel ahead of a Portland candidate", async () => {
		const tree = (): AddressTree => ({
			raw: "Mt. Tabor, Portland, Oregon",
			roots: [
				node("region", "Oregon", 21, [node("locality", "Portland", 11, [node("dependent_locality", "Mt. Tabor", 0)])]),
			],
		})

		const arms: Array<ResolveOutcome | null> = [
			null,
			outcomeOf({ outcomeHint: "natural.mountain" }),
			outcomeOf({ outcomeHint: "place" }),
			outcomeOf({}, ["natural", "place"]),
			outcomeOf({}, ["place", "natural"]),
		]

		for (const outcome of arms) {
			const ids = ranking(await resolve(tree(), outcome)).places.map((p) => p.id)
			const israel = ids.indexOf(`wikidata:${MOUNT_TABOR_ISRAEL}`)

			for (const portland of [`wof:${MT_TABOR_HOOD}`, `wikidata:${BUTTE}`]) {
				const at = ids.indexOf(portland)

				if (at !== -1 && israel !== -1) {
					expect(at).toBeLessThan(israel)
				}
			}
		}
	})

	test("`coffee near Mt. Tabor` reads the anchor the same with and without a hint", async () => {
		const tree = (): AddressTree => ({
			raw: "coffee near Mt. Tabor",
			roots: [node("venue", "coffee", 0), node("locality", "Mt. Tabor", 12)],
		})

		const anchor = (resolved: AddressTree) => resolved.roots.find((n) => n.tag === "locality")

		const unhinted = anchor(await resolve(tree(), null))
		const hinted = anchor(await resolve(tree(), outcomeOf({ outcomeHint: "natural.mountain" })))

		expect(hinted?.placeID).toBe(unhinted?.placeID)
		expect(hinted?.metadata?.["outcome_target"]).toBeUndefined()
	})

	test("`Manhattan` is one place holding `place.borough` and `natural.island`, admitted by either filter", async () => {
		const tree = (): AddressTree => ({ raw: "Manhattan", roots: [node("locality", "Manhattan", 0)] })

		for (const filter of [["natural"], ["place"]]) {
			const outcome = outcomeOf({ outcomeFilter: filter })
			const resolved = await resolve(tree(), outcome)
			const { answer, places } = ranking(resolved)

			expect(answer.placeID).toBe(`wof:${MANHATTAN}`)
			expect(places[0]!.outcomes).toEqual(["natural.island", "place.borough"])

			const result = geocode(tree(), resolved, outcome)

			expect(result.lat).toBeCloseTo(40.78, 2)
			expect(result.intent_markers.map((m) => m.code)).not.toContain("outcome_filter_empty")
		}
	})

	test("`97215`: a postcode-only query never reads the outcome head", () => {
		const outcome = resolveOutcomeFor(
			{ outcomeFilter: ["postal"] },
			{ vocabulary: VOCABULARY, headOrder: ["place"], headOrdering: true },
			{ kind: "postcode_only", interpretedSpan: false }
		)

		expect(outcome?.headOrder).toBeNull()
	})

	test("a hint the text contradicts leaves the parsed spans as they were and reports the hint unsatisfied", async () => {
		const tree = (): AddressTree => ({ raw: "Mt. Tabor Park", roots: [node("venue", "Mt. Tabor Park", 0)] })
		const spans = (t: AddressTree) => [...walkNodes(t.roots)].map((n) => [n.tag, n.value, n.start, n.end])

		const unhinted = await resolve(tree(), null)
		const hinted = await resolve(tree(), outcomeOf({ outcomeHint: "place" }))

		expect(spans(hinted)).toEqual(spans(unhinted))

		const result = geocode(tree(), hinted, outcomeOf({ outcomeHint: "place" }))

		expect(result.intent_markers.find((m) => m.code === "outcome_hint_unsatisfied")?.evidence).toMatchObject({
			hint: "place",
		})
	})

	test("a record with zero rows in a source holds exactly its placetype defaults", async () => {
		const [hood] = await candidate.findPlace({
			text: "Mt. Tabor",
			placetype: "neighbourhood",
			outcome: { vocabulary: VOCABULARY, admit: null },
		})

		expect(hood?.outcomes).toEqual([
			{ outcome: "place.neighbourhood", contested: false, sources: ["candidate:default"] },
		])
	})

	test("a database pinned to a newer vocabulary answers a request checked against the older one", async () => {
		const [portland] = await candidate.findPlace({
			text: "Portland",
			placetype: "locality",
			outcome: { vocabulary: VOCABULARY, admit: null },
		})

		// The older vocabulary lacks the newer member, so the read leaves it out.
		expect(portland?.outcomes?.map((m) => m.outcome)).toEqual(["place.locality"])
	})

	test("one entity in two data layers is one place with the union of both sets and their sources", async () => {
		const tree: AddressTree = { raw: "Manhattan", roots: [node("locality", "Manhattan", 0)] }
		const { answer, places } = ranking(await resolve(tree, outcomeOf({ outcomeHint: "natural.island" })))

		expect(places.filter((p) => p.id === `wof:${MANHATTAN}` || p.id === `wikidata:${MANHATTAN_ITEM}`)).toHaveLength(1)

		const members = (answer.metadata?.["outcomes"] ?? []) as OutcomeMembership[]
		const island = members.find((m) => m.outcome === "natural.island")

		expect(island).toEqual({
			outcome: "natural.island",
			contested: true,
			sources: ["candidate:asserted", "landmarks:asserted"],
		})
	})
})

describe("outcome kinds: the request", () => {
	test("a filter is a predicate of the fetch and admits only satisfying rows", async () => {
		const rows = await candidate.findPlace({
			text: "Manhattan",
			placetype: "locality",
			outcome: { vocabulary: VOCABULARY, admit: [idOf("natural.water")] },
		})

		expect(rows).toEqual([])
	})

	test("a filter that admits zero candidates answers zero places with an advisory", async () => {
		const tree = bareTabor()
		const outcome = outcomeOf({ outcomeFilter: ["transit"] })
		const result = geocode(tree, await resolve(tree, outcome), outcome)

		expect(result.lat).toBeNull()
		expect(result.candidates).toEqual([])
		expect(result.intent_markers.map((m) => m.code)).toEqual(["outcome_filter_empty"])
	})

	test("an id outside the vocabulary and a hint no filter id admits are refused", () => {
		const refusal = (options: OutcomeOptions) => {
			try {
				outcomeOf(options)
			} catch (error) {
				return error instanceof OutcomeRequestError ? error.code : null
			}

			return null
		}

		expect(refusal({ outcomeHint: "natural.volcano" })).toBe(OutcomeRefusal.UnknownOutcome)
		expect(refusal({ outcomeFilter: ["coffee"] })).toBe(OutcomeRefusal.UnknownOutcome)

		expect(refusal({ outcomeHint: "natural.mountain", outcomeFilter: ["place"] })).toBe(
			OutcomeRefusal.HintOutsideFilter
		)

		expect(refusal({ outcomeHint: "natural.mountain", outcomeFilter: ["natural"] })).toBeNull()
	})

	test("a database that predates the outcome tables is refused with the tables named", async () => {
		await expect(resolve(bareTabor(), outcomeOf({ outcomeHint: "place" }), predating)).rejects.toThrow(
			/outcome_default and record_outcome/
		)
	})

	test("a model without an outcome head states `outcome_hint_model: unsupported`", async () => {
		const tree = bareTabor()
		const outcome = outcomeOf({ outcomeHint: "place" })

		expect(geocode(tree, await resolve(tree, outcome), outcome).outcome_hint_model).toBe("unsupported")
	})

	test("the head's order is read only with the switch on and no hint", () => {
		const headOrder = ["natural"]

		const read = (
			options: OutcomeOptions,
			headOrdering: boolean,
			query: Parameters<typeof resolveOutcomeFor>[3] = { kind: "bare_toponym", interpretedSpan: false }
		) => resolveOutcomeFor(options, { vocabulary: VOCABULARY, headOrder, headOrdering }, query)?.headOrder

		expect(read({ outcomeFilter: ["place", "natural"] }, false)).toBeNull()
		expect(read({ outcomeHint: "place" }, true)).toBeNull()
		expect(read({ outcomeFilter: ["place", "natural"] }, true)).toEqual(["natural"])

		// Outside a bare name, a span with a small-margin runner-up label is eligible.
		const landmarkQuery = { kind: "landmark", interpretedSpan: false } as const

		expect(read({ outcomeFilter: ["place"] }, true, landmarkQuery)).toBeNull()
		expect(read({ outcomeFilter: ["place"] }, true, { ...landmarkQuery, interpretedSpan: true })).toEqual(["natural"])
	})

	test("a resolve without outcome options reads no outcome sets", async () => {
		const resolved = await resolve(bareTabor(), null)

		for (const n of walkNodes(resolved.roots)) {
			expect(n.metadata?.["outcomes"]).toBeUndefined()
			expect(n.metadata?.["outcome_target"]).toBeUndefined()
		}
	})
})
