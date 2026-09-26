/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Pins the sub-venue lexicon builder.
 * Everything here runs over synthetic inputs, because the builder is a pure function of parsed data.
 */

import {
	applyPromotions,
	buildSubVenueLexicon,
	buildSurfaceIndex,
	classifyIdentifier,
	CONCEPT_QIDS,
	deriveHeadNounSurfaces,
	extractAttestedPhrases,
	nameContainsSurfaces,
	normalizeSurface,
	SHIPPED_DESIGNATOR_SEED,
	SHIPPED_MODIFIER_SEED,
	serializeSubVenueLexicon,
	type SubVenueSurface,
	surfacesFromWikidata,
} from "@mailwoman/corpus/tools/sub-venue-lexicon"
import { SUBVENUE_PROMOTIONS } from "@mailwoman/corpus/tools/sub-venue-promotions"
import { expect, test } from "vitest"

/**
 * A minimal sparql envelope in the exact shape wdqs serves.
 */
const wikidataFixture = {
	results: {
		bindings: [
			{
				item: { value: "http://www.wikidata.org/entity/Q849706" },
				lang: { value: "de" },
				label: { value: "Terminal" },
				kind: { value: "label" },
			},
			{
				item: { value: "http://www.wikidata.org/entity/Q849706" },
				lang: { value: "de" },
				label: { value: "Flughafenterminal" },
				kind: { value: "alt" },
			},
			{
				item: { value: "http://www.wikidata.org/entity/Q849706" },
				lang: { value: "ja" },
				label: { value: "空港ターミナル" },
				kind: { value: "label" },
			},
			// A second Japanese label, which makes the shared-substring derivation possible:
			// a group of one has no peer to share with.
			{
				item: { value: "http://www.wikidata.org/entity/Q849706" },
				lang: { value: "ja" },
				label: { value: "旅客ターミナル" },
				kind: { value: "alt" },
			},
			// An untagged literal — Wikidata carries these and they name no language.
			{
				item: { value: "http://www.wikidata.org/entity/Q849706" },
				lang: { value: "" },
				label: { value: "terminal" },
				kind: { value: "label" },
			},
			// A concept outside the table.
			{
				item: { value: "http://www.wikidata.org/entity/Q999999" },
				lang: { value: "en" },
				label: { value: "something else" },
				kind: { value: "label" },
			},
		],
	},
}

/**
 * A surface, with the fields a test does not care about filled in.
 */
function surface(partial: Partial<SubVenueSurface> & Pick<SubVenueSurface, "phrase" | "recordID">): SubVenueSurface {
	return {
		recordKind: "designator",
		lang: "en",
		region: "",
		source: "seed",
		curated: false,
		observations: 0,
		context: {},
		...partial,
	}
}

test("SHIPPED_DESIGNATOR_SEED mirrors neural/venue-structure.ts's VENUE_STRUCTURE_DESIGNATORS", () => {
	// The drift pin: `@mailwoman/corpus` does not depend on `@mailwoman/neural`,
	// so this list is a copy and the copy is what this test exists to catch.
	expect(SHIPPED_DESIGNATOR_SEED.map((d) => d.id).toSorted()).toEqual([
		"arcade",
		"building",
		"campus",
		"concourse",
		"enclosure",
		"gate",
		"installation",
		"terminal",
		"wing",
	])
})

test("SHIPPED_DESIGNATOR_SEED's modifierEligible set matches MODIFIER_ELIGIBLE_STRUCTURE_DESIGNATORS", () => {
	// `gate` and `building` are excluded upstream because "East Gate" and "Building
	// Society Place" are real GB streets; the GB extract's 890 `gate` transport
	// features are essentially none of them sub-venues.
	expect(
		SHIPPED_DESIGNATOR_SEED.filter((d) => d.modifierEligible)
			.map((d) => d.id)
			.toSorted()
	).toEqual(["arcade", "campus", "concourse", "terminal", "wing"])
})

test("SHIPPED_MODIFIER_SEED mirrors VENUE_STRUCTURE_MODIFIERS", () => {
	expect(SHIPPED_MODIFIER_SEED.toSorted()).toEqual([
		"central",
		"east",
		"front",
		"inner",
		"lower",
		"main",
		"north",
		"outer",
		"rear",
		"south",
		"upper",
		"west",
	])
})

test("CONCEPT_QIDS covers every concept the wikidata fetch pulls", () => {
	// Mirrors `fetch/wikidata-subvenue.ts`'s SUBVENUE_CONCEPTS.
	// `wing` is absent from both on purpose: Wikidata has no clean "wing of a building" concept.
	expect(Object.keys(CONCEPT_QIDS).toSorted()).toEqual([
		"arcade",
		"building",
		"campus",
		"concourse",
		"gate",
		"hall",
		"satellite",
		"terminal",
	])

	expect(CONCEPT_QIDS["wing"]).toBeUndefined()
})

test("normalizeSurface folds case for bicameral scripts and leaves others alone", () => {
	expect(normalizeSurface("  Flughafen   Terminal ")).toBe("flughafen terminal")
	expect(normalizeSurface("Терминал")).toBe("терминал")
	// Japanese and Chinese have no case to fold; the guard is what keeps a mixed
	// string like `Terminal ターミナル` from being half-folded.
	expect(normalizeSurface("空港ターミナル")).toBe("空港ターミナル")
	expect(normalizeSurface("航站楼")).toBe("航站楼")
})

test("surfacesFromWikidata maps QIDs to designators and drops untagged and unknown rows", () => {
	const surfaces = surfacesFromWikidata(wikidataFixture)

	expect(surfaces.map((s) => [s.phrase, s.lang, s.source])).toEqual([
		["terminal", "de", "wikidata:label"],
		["flughafenterminal", "de", "wikidata:alt"],
		["空港ターミナル", "ja", "wikidata:label"],
		["旅客ターミナル", "ja", "wikidata:alt"],
	])

	expect(surfaces.every((s) => s.recordID === "terminal" && s.region === "")).toBe(true)
})

test("surfacesFromWikidata: nothing it produces is curated", () => {
	// A Wikidata class label is a concept name rather than an addressed designator
	// (`puerta de embarque` vs `Puerta`), so promotion is a human act.
	expect(surfacesFromWikidata(wikidataFixture).every((s) => !s.curated)).toBe(true)
})

test("classifyIdentifier covers the shapes real refs take", () => {
	expect(classifyIdentifier("5")).toBe("digit")
	expect(classifyIdentifier("B")).toBe("letter")
	expect(classifyIdentifier("A12")).toBe("letter-digit")
	expect(classifyIdentifier("2F")).toBe("digit-letter")
	// Both separators OSM uses for a gate serving more than one stand — measured on Berlin.
	expect(classifyIdentifier("16-18")).toBe("range")
	expect(classifyIdentifier("0/1")).toBe("range")
	expect(classifyIdentifier("General Aviation Terminal")).toBe("other")
})

test("nameContainsSurfaces matches whole tokens for Latin script, not substrings", () => {
	const index = buildSurfaceIndex([
		surface({ phrase: "terminal", recordID: "terminal" }),
		surface({ phrase: "wing", recordID: "wing" }),
		surface({ phrase: "gate", recordID: "gate" }),
	])

	expect(nameContainsSurfaces("Terminal E (Untere Ebene)", index)).toEqual(["terminal"])
	expect(nameContainsSurfaces("South Terminal", index)).toEqual(["terminal"])
	expect(nameContainsSurfaces("Terminal 3, Pier 6", index)).toEqual(["terminal"])
	// The compound miss is deliberate: admitting suffix matches would fire on every
	// -gate/-hall compound in Germanic and Nordic street naming (Briggate, Kirkgate).
	expect(nameContainsSurfaces("Nordterminal", index)).toEqual([])
	expect(nameContainsSurfaces("Briggate", index)).toEqual([])
	expect(nameContainsSurfaces("Otto Lilienthal Flughafen Berlin Tegel", index)).toEqual([])
})

test("nameContainsSurfaces falls back to substring matching for Han and Kana", () => {
	// The Japanese harvest depends on this branch: `第1ターミナル` has no word boundaries,
	// so a token split returns the whole string and matches no entry.
	const index = buildSurfaceIndex([
		surface({ phrase: "ターミナル", recordID: "terminal", lang: "ja" }),
		surface({ phrase: "terminal", recordID: "terminal" }),
	])

	expect(nameContainsSurfaces("第1ターミナル", index)).toEqual(["ターミナル"])
	expect(nameContainsSurfaces("成田空港第2ターミナル", index)).toEqual(["ターミナル"])
	expect(nameContainsSurfaces("North Terminal", index)).toEqual(["terminal"])
})

test("extractAttestedPhrases attributes a hit to the record the PHRASE names, not the row's designator", () => {
	const index = buildSurfaceIndex([
		surface({ phrase: "hall", recordID: "hall" }),
		surface({ phrase: "west", recordID: "west", recordKind: "modifier" }),
	])

	const { surfaces } = extractAttestedPhrases(
		[
			{ designatorID: "platform", name: "Village Hall" },
			{ designatorID: "platform", name: "West Kensington" },
		],
		index,
		{ region: "GB" }
	)

	expect(surfaces.map((s) => [s.phrase, s.recordID, s.recordKind])).toEqual([
		["hall", "hall", "designator"],
		["west", "west", "modifier"],
	])

	// The row's own designator survives as context, which makes the confound board possible:
	// a `hall` seen on a platform is a bus stop, a `hall` seen on a terminal is a hall.
	expect(surfaces.every((s) => s.context["platform"] === 1)).toBe(true)
})

test("extractAttestedPhrases counts observations and derives identifier shapes from ref, not name", () => {
	const index = buildSurfaceIndex([
		surface({ phrase: "terminal", recordID: "terminal" }),
		surface({ phrase: "gate", recordID: "gate" }),
	])

	const { surfaces, identifierShapes } = extractAttestedPhrases(
		[
			{ designatorID: "terminal", name: "South Terminal", ref: null },
			{ designatorID: "terminal", name: "North Terminal", ref: null },
			{ designatorID: "terminal", name: "Otto Lilienthal Flughafen Berlin Tegel", ref: null },
			{ designatorID: "gate", name: null, ref: "A12" },
			{ designatorID: "gate", name: null, ref: "13" },
			{ designatorID: "gate", name: null, ref: "16-18" },
		],
		index,
		{ region: "GB" }
	)

	expect(surfaces).toEqual([
		{
			phrase: "terminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "und",
			region: "GB",
			source: "osm:name",
			curated: false,
			observations: 2,
			context: { terminal: 2 },
		},
	])

	expect(identifierShapes).toEqual(
		expect.arrayContaining([
			{ designatorID: "gate", region: "GB", shape: "letter-digit", observations: 1, examples: ["A12"] },
			{ designatorID: "gate", region: "GB", shape: "digit", observations: 1, examples: ["13"] },
			{ designatorID: "gate", region: "GB", shape: "range", observations: 1, examples: ["16-18"] },
		])
	)
})

test("extractAttestedPhrases harvests localized names under their own language tag", () => {
	const index = buildSurfaceIndex([surface({ phrase: "terminal", recordID: "terminal" })])

	const { surfaces } = extractAttestedPhrases(
		[{ designatorID: "terminal", name: null, ref: null, localizedNames: { es: "Terminal Sur" } }],
		index,
		{ region: "ES" }
	)

	expect(surfaces).toEqual([
		{
			phrase: "terminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "es",
			region: "ES",
			source: "osm:name:es",
			curated: false,
			observations: 1,
			context: { terminal: 1 },
		},
	])
})

test("extractAttestedPhrases stamps the source family it was given", () => {
	// Overture needed a parameter rather than a row-shape adaptation: the shape fits,
	// but the `osm:name` stamp did not, and a mislabelled ODbL provenance is not a cosmetic error.
	const index = buildSurfaceIndex([surface({ phrase: "concourse", recordID: "concourse" })])

	const { surfaces } = extractAttestedPhrases([{ designatorID: "terminal", name: "Concourse B" }], index, {
		source: "overture",
		region: "US",
	})

	expect(surfaces[0]?.source).toBe("overture:name")
	expect(surfaces[0]?.region).toBe("US")
})

test("deriveHeadNounSurfaces pulls the cognate out of a Latin encyclopaedic label", () => {
	const derived = deriveHeadNounSurfaces([
		surface({ phrase: "terminal aeroportuaria", recordID: "terminal", lang: "es", source: "wikidata:label" }),
		surface({ phrase: "letištní terminál", recordID: "terminal", lang: "cs", source: "wikidata:label" }),
		surface({ phrase: "havalimanı terminali", recordID: "terminal", lang: "tr", source: "wikidata:label" }),
	])

	expect(derived.map((s) => [s.lang, s.phrase])).toEqual([
		["es", "terminal"],
		["cs", "terminál"],
		["tr", "terminali"],
	])

	expect(derived.every((s) => s.source === "derived:head-noun" && !s.curated)).toBe(true)
})

test("deriveHeadNounSurfaces does not mistake the modifier half for the head", () => {
	const derived = deriveHeadNounSurfaces([
		surface({ phrase: "universiteit", recordID: "campus", lang: "nl" }),
		surface({ phrase: "campus universitario", recordID: "campus", lang: "es" }),
	])

	expect(derived.map((s) => s.phrase)).toEqual(["campus"])
})

test("deriveHeadNounSurfaces holds the cognate floor at five folded characters", () => {
	// Neither side of the floor is reachable from the committed table, so without this
	// a change to the constant moves the artifact in silence.
	expect(deriveHeadNounSurfaces([surface({ phrase: "campo sportivo", recordID: "campus", lang: "it" })])).toEqual([])

	// `satélite` shares five with `satellite` and is the addressed form.
	// A floor of six loses it.
	expect(
		deriveHeadNounSurfaces([surface({ phrase: "satélite de embarque", recordID: "satellite", lang: "es" })]).map(
			(s) => s.phrase
		)
	).toEqual(["satélite"])
})

test("deriveHeadNounSurfaces finds the Japanese head by shared substring", () => {
	// `ターミナル` is in none of the Wikidata labels on its own, and no other step in the pipeline can produce it.
	const derived = deriveHeadNounSurfaces([
		surface({ phrase: "ターミナルビル", recordID: "terminal", lang: "ja" }),
		surface({ phrase: "旅客ターミナル", recordID: "terminal", lang: "ja" }),
		surface({ phrase: "空港ターミナルビル", recordID: "terminal", lang: "ja" }),
	])

	expect(derived.map((s) => s.phrase)).toContain("ターミナル")
})

test("deriveHeadNounSurfaces keeps a spaced non-Latin candidate to whole tokens", () => {
	const derived = deriveHeadNounSurfaces([
		surface({ phrase: "공항 터미널", recordID: "terminal", lang: "ko" }),
		surface({ phrase: "공항터미널", recordID: "terminal", lang: "ko" }),
	])

	// `터미널` and `공항` are both whole tokens of the spaced member.
	// A fragment straddling the space is never offered.
	expect(derived.map((s) => s.phrase).toSorted()).toEqual(["공항", "터미널"])
})

test("applyPromotions curates only the matching designator, phrase and locale", () => {
	const surfaces = [
		surface({ phrase: "halle", recordID: "hall", lang: "de", region: "DE", source: "osm:name" }),
		surface({ phrase: "halle", recordID: "hall", lang: "und", region: "GB", source: "osm:name" }),
		surface({ phrase: "hall", recordID: "hall", lang: "und", region: "GB", source: "osm:name" }),
	]

	const curated = applyPromotions(surfaces, [
		{
			designatorID: "hall",
			phrase: "halle",
			locale: "de-DE",
			decision: "promote",
			real: 1,
			confound: 0,
			confoundNote: "test",
			census: "test",
		},
		{
			designatorID: "hall",
			phrase: "hall",
			locale: "en-GB",
			decision: "reject",
			real: 0,
			confound: 1,
			confoundNote: "test",
			census: "test",
		},
	])

	expect(curated.map((s) => s.curated)).toEqual([true, false, false])
})

test("applyPromotions refuses a region-free surface when the same language has a rejection", () => {
	// The `pier` case: without this guard the en-GB promotion curates the region-free
	// English surface and hands `Pier 1 Imports` what en-US was refused.
	const surfaces = [
		surface({ phrase: "pier", recordID: "pier", lang: "en", region: "", source: "seed" }),
		surface({ phrase: "pier", recordID: "pier", lang: "und", region: "GB", source: "osm:name" }),
	]

	const curated = applyPromotions(surfaces, [
		{
			designatorID: "pier",
			phrase: "pier",
			locale: "en-GB",
			decision: "promote",
			real: 120,
			confound: 44,
			confoundNote: "test",
			census: "test",
		},
		{
			designatorID: "pier",
			phrase: "pier",
			locale: "en-US",
			decision: "reject",
			real: 278,
			confound: 2330,
			confoundNote: "test",
			census: "test",
		},
	])

	expect(curated.map((s) => s.curated)).toEqual([false, true])
})

test("applyPromotions reaches a region-free Wikidata surface through the locale's language", () => {
	const surfaces = [surface({ phrase: "halle", recordID: "hall", lang: "de", region: "", source: "wikidata:label" })]

	const curated = applyPromotions(surfaces, [
		{
			designatorID: "hall",
			phrase: "halle",
			locale: "de-DE",
			decision: "promote",
			real: 1,
			confound: 0,
			confoundNote: "test",
			census: "test",
		},
	])

	expect(curated[0]?.curated).toBe(true)
})

test("every committed promotion carries a confound note and a census", () => {
	// A bare number is not a board; this is the rule the ledger exists to enforce.
	for (const promotion of SUBVENUE_PROMOTIONS) {
		expect(promotion.confoundNote.length, `${promotion.designatorID}/${promotion.locale}`).toBeGreaterThan(0)
		expect(promotion.census.length, `${promotion.designatorID}/${promotion.locale}`).toBeGreaterThan(0)
		expect(promotion.locale, `${promotion.designatorID}/${promotion.locale}`).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
	}
})

test("buildSubVenueLexicon: the seed's English surfaces are curated, everything machine-derived is not", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, harvests: [], sources: [], promotions: [] })
	const curated = table.surfaces.filter((s) => s.curated)

	// The six proposed designators contribute an English surface too but uncurated, because no new entry auto-promotes.
	expect(curated).toHaveLength(SHIPPED_DESIGNATOR_SEED.length + SHIPPED_MODIFIER_SEED.length)
	expect(curated.every((s) => s.source === "seed")).toBe(true)
	expect(table.surfaces.filter((s) => s.source.startsWith("wikidata")).every((s) => !s.curated)).toBe(true)
})

test("buildSubVenueLexicon: proposed designators land unshipped and not modifier-eligible", () => {
	const table = buildSubVenueLexicon({ wikidata: null, harvests: [], sources: [], promotions: [] })
	const proposed = table.designators.filter((d) => !d.shipped)

	expect(proposed.map((d) => d.id)).toEqual(["airport", "hall", "pier", "platform", "satellite", "station"])
	// `hall` is the one to watch: the token appears in 3,273 named GB transport features and 3,204
	// of them sit on a `public_transport=platform`, so promoting it for en-GB would be wrong.
	expect(proposed.every((d) => !d.modifierEligible)).toBe(true)
})

test("buildSubVenueLexicon: a Wikidata QID becomes provenance on its designator", () => {
	const table = buildSubVenueLexicon({ wikidata: null, harvests: [], sources: [], promotions: [] })
	const terminal = table.designators.find((d) => d.id === "terminal")

	expect(terminal?.provenance).toContain("wikidata:Q849706")
	expect(terminal?.provenance).toContain("osm:aeroway=terminal")
	// `wing` has no Wikidata concept, so its provenance stays WOF-only.
	expect(table.designators.find((d) => d.id === "wing")?.provenance).toEqual(["wof:placetype"])
})

test("buildSubVenueLexicon is deterministic — same inputs, byte-identical output", () => {
	const input = {
		wikidata: wikidataFixture,
		harvests: [
			{
				rows: [
					{ designatorID: "terminal", name: "South Terminal", ref: null },
					{ designatorID: "gate", name: null, ref: "A12" },
				],
				source: "osm",
				region: "GB",
			},
		],
		sources: [],
	}

	expect(serializeSubVenueLexicon(buildSubVenueLexicon(input))).toBe(
		serializeSubVenueLexicon(buildSubVenueLexicon(input))
	)
})

test("buildSubVenueLexicon: every array is sorted, so a regenerate cannot reorder", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, harvests: [], sources: [] })

	expect(table.designators.map((d) => d.id)).toEqual(table.designators.map((d) => d.id).toSorted())
	expect(table.modifiers.map((m) => m.id)).toEqual(table.modifiers.map((m) => m.id).toSorted())

	expect(table.surfaces.map((s) => s.phrase)).toEqual(
		table.surfaces.map((s) => s.phrase).toSorted((a, b) => a.localeCompare(b))
	)
})

test("buildSubVenueLexicon: every surface points at a record that exists", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, harvests: [], sources: [] })
	const designatorIDs = new Set(table.designators.map((d) => d.id))
	const modifierIDs = new Set(table.modifiers.map((m) => m.id))

	for (const row of table.surfaces) {
		const pool = row.recordKind === "designator" ? designatorIDs : modifierIDs

		expect(pool.has(row.recordID)).toBe(true)
	}
})

test("buildSubVenueLexicon: a harvest can only match a phrase an EARLIER stage introduced", () => {
	// Order is required and easy to break: head nouns are derived after Wikidata and
	// before the harvests, and reordering silently empties the Japanese harvest.
	const table = buildSubVenueLexicon({
		wikidata: wikidataFixture,
		harvests: [{ rows: [{ designatorID: "terminal", name: "第1ターミナル" }], source: "osm", region: "JP" }],
		sources: [],
		promotions: [],
	})

	const harvested = table.surfaces.find((s) => s.region === "JP")

	expect(harvested?.phrase).toBe("ターミナル")
	expect(harvested?.observations).toBe(1)
})
