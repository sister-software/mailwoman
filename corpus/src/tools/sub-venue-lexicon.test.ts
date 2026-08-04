/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins the sub-venue lexicon builder. Everything here runs over synthetic inputs — the builder is a
 *   pure function of parsed data by design, so no fixture on disk and no network is involved.
 *
 *   The two tests that matter most are the DRIFT pin (the seed against
 *   `neural/venue-structure.ts`, which `@mailwoman/corpus` cannot import — see the module docstring)
 *   and the NAME-HARVEST GATE, which is the filter standing between this table and 250,000 German and
 *   British street names.
 */

import { expect, test } from "vitest"

import {
	buildSubVenueLexicon,
	classifyIdentifier,
	CONCEPT_QIDS,
	extractAttestedPhrases,
	nameContainsSurface,
	normalizeSurface,
	SHIPPED_DESIGNATOR_SEED,
	SHIPPED_MODIFIER_SEED,
	serializeSubVenueLexicon,
	surfacesFromWikidata,
} from "./sub-venue-lexicon.ts"

/**
 * A minimal SPARQL envelope in the exact shape WDQS serves.
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

test("SHIPPED_DESIGNATOR_SEED mirrors neural/venue-structure.ts's VENUE_STRUCTURE_DESIGNATORS", () => {
	// THE DRIFT PIN. `@mailwoman/corpus` does not depend on `@mailwoman/neural`, so this list is a copy
	// and the copy is what this test exists to catch. If `VENUE_STRUCTURE_DESIGNATORS` gains or loses a
	// term, update both and update this literal.
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
	// `gate` and `building` are excluded UPSTREAM because "East Gate" and "Building Society Place" are
	// real GB streets. Measured on the GB extract 2026-08-04: the token `gate` appears in 890 named
	// transport features — Park Gate, Notting Hill Gate, Queens Gate, Lancaster Gate, North Gate — and
	// essentially none of them is a sub-venue. The exclusion is right and this pins it.
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
	// Mirrors `fetch/wikidata-subvenue.ts`'s SUBVENUE_CONCEPTS. `wing` is absent from BOTH on purpose:
	// Wikidata has no clean "wing of a building" concept.
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
	// Japanese and Chinese have no case to fold; `toLowerCase` would be a no-op here but the guard is
	// what keeps a mixed string like `Terminal ターミナル` from being half-folded.
	expect(normalizeSurface("空港ターミナル")).toBe("空港ターミナル")
	expect(normalizeSurface("航站楼")).toBe("航站楼")
})

test("surfacesFromWikidata maps QIDs to designators and drops untagged and unknown rows", () => {
	const surfaces = surfacesFromWikidata(wikidataFixture)

	expect(surfaces).toEqual([
		{
			phrase: "terminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "de",
			source: "wikidata:label",
			curated: false,
			observations: 0,
		},
		{
			phrase: "flughafenterminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "de",
			source: "wikidata:alt",
			curated: false,
			observations: 0,
		},
		{
			phrase: "空港ターミナル",
			recordID: "terminal",
			recordKind: "designator",
			lang: "ja",
			source: "wikidata:label",
			curated: false,
			observations: 0,
		},
	])
})

test("surfacesFromWikidata: nothing it produces is curated", () => {
	// The load-bearing invariant. A Wikidata class label is a CONCEPT NAME, not an addressed
	// designator (`puerta de embarque` vs `Puerta`), so promotion is a human act.
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

test("nameContainsSurface matches whole tokens, not substrings", () => {
	const known = new Set(["terminal", "wing", "gate"])

	expect(nameContainsSurface("Terminal E (Untere Ebene)", known)).toBe("terminal")
	expect(nameContainsSurface("South Terminal", known)).toBe("terminal")
	expect(nameContainsSurface("Terminal 3, Pier 6", known)).toBe("terminal")
	// The compound miss, documented and deliberate: admitting suffix matches would fire on every
	// -gate/-hall compound in Germanic and Nordic street naming (Briggate, Kirkgate).
	expect(nameContainsSurface("Nordterminal", known)).toBeNull()
	expect(nameContainsSurface("Briggate", known)).toBeNull()
	// And the whole point of the gate: an ordinary venue name contributes nothing.
	expect(nameContainsSurface("Otto Lilienthal Flughafen Berlin Tegel", known)).toBeNull()
})

test("extractAttestedPhrases counts observations and derives identifier shapes from ref, not name", () => {
	const rows = [
		{ designatorID: "terminal", name: "South Terminal", ref: null },
		{ designatorID: "terminal", name: "North Terminal", ref: null },
		{ designatorID: "terminal", name: "Otto Lilienthal Flughafen Berlin Tegel", ref: null },
		{ designatorID: "gate", name: null, ref: "A12" },
		{ designatorID: "gate", name: null, ref: "13" },
		{ designatorID: "gate", name: null, ref: "16-18" },
	]

	const { surfaces, identifierShapes } = extractAttestedPhrases(rows, new Set(["terminal", "gate"]))

	expect(surfaces).toEqual([
		{
			phrase: "terminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "und",
			source: "osm:name",
			curated: false,
			observations: 2,
		},
	])

	expect(identifierShapes).toEqual(
		expect.arrayContaining([
			{ designatorID: "gate", shape: "letter-digit", observations: 1, examples: ["A12"] },
			{ designatorID: "gate", shape: "digit", observations: 1, examples: ["13"] },
			{ designatorID: "gate", shape: "range", observations: 1, examples: ["16-18"] },
		])
	)
})

test("extractAttestedPhrases harvests localized names under their own language tag", () => {
	const rows = [{ designatorID: "terminal", name: null, ref: null, localizedNames: { es: "Terminal Sur" } }]
	const { surfaces } = extractAttestedPhrases(rows, new Set(["terminal"]))

	expect(surfaces).toEqual([
		{
			phrase: "terminal",
			recordID: "terminal",
			recordKind: "designator",
			lang: "es",
			source: "osm:name:es",
			curated: false,
			observations: 1,
		},
	])
})

test("buildSubVenueLexicon: the seed's English surfaces are curated, everything machine-derived is not", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, osmRows: [], sources: [] })

	const curated = table.surfaces.filter((s) => s.curated)

	// Nine shipped designators plus twelve modifiers. The five PROPOSED designators contribute an
	// English surface too, but uncurated — nothing new auto-promotes.
	expect(curated).toHaveLength(SHIPPED_DESIGNATOR_SEED.length + SHIPPED_MODIFIER_SEED.length)
	expect(curated.every((s) => s.source === "seed")).toBe(true)
	expect(table.surfaces.filter((s) => s.source.startsWith("wikidata")).every((s) => !s.curated)).toBe(true)
})

test("buildSubVenueLexicon: proposed designators land unshipped and not modifier-eligible", () => {
	const table = buildSubVenueLexicon({ wikidata: null, osmRows: [], sources: [] })
	const proposed = table.designators.filter((d) => !d.shipped)

	expect(proposed.map((d) => d.id)).toEqual(["airport", "hall", "platform", "satellite", "station"])
	// `hall` is the one to watch: the token appears in 3,274 named GB transport features and the top of
	// that distribution is Village Hall (418), Town Hall (73), Hall Lane, Hall Road. Promoting it would
	// be a disaster in en-GB. Measured 2026-08-04.
	expect(proposed.every((d) => !d.modifierEligible)).toBe(true)
})

test("buildSubVenueLexicon: a Wikidata QID becomes provenance on its designator", () => {
	const table = buildSubVenueLexicon({ wikidata: null, osmRows: [], sources: [] })
	const terminal = table.designators.find((d) => d.id === "terminal")

	expect(terminal?.provenance).toContain("wikidata:Q849706")
	expect(terminal?.provenance).toContain("osm:aeroway=terminal")
	// `wing` has no Wikidata concept, so its provenance stays WOF-only.
	expect(table.designators.find((d) => d.id === "wing")?.provenance).toEqual(["wof:placetype"])
})

test("buildSubVenueLexicon is deterministic — same inputs, byte-identical output", () => {
	const rows = [
		{ designatorID: "terminal", name: "South Terminal", ref: null },
		{ designatorID: "gate", name: null, ref: "A12" },
	]

	const input = { wikidata: wikidataFixture, osmRows: rows, sources: [] }

	expect(serializeSubVenueLexicon(buildSubVenueLexicon(input))).toBe(
		serializeSubVenueLexicon(buildSubVenueLexicon(input))
	)
})

test("buildSubVenueLexicon: every array is sorted, so a regenerate cannot reorder", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, osmRows: [], sources: [] })

	expect(table.designators.map((d) => d.id)).toEqual(table.designators.map((d) => d.id).toSorted())
	expect(table.modifiers.map((m) => m.id)).toEqual(table.modifiers.map((m) => m.id).toSorted())

	expect(table.surfaces.map((s) => s.phrase)).toEqual(
		table.surfaces.map((s) => s.phrase).toSorted((a, b) => a.localeCompare(b))
	)
})

test("buildSubVenueLexicon: every surface points at a record that exists", () => {
	const table = buildSubVenueLexicon({ wikidata: wikidataFixture, osmRows: [], sources: [] })
	const designatorIDs = new Set(table.designators.map((d) => d.id))
	const modifierIDs = new Set(table.modifiers.map((m) => m.id))

	for (const surface of table.surfaces) {
		const pool = surface.recordKind === "designator" ? designatorIDs : modifierIDs

		expect(pool.has(surface.recordID)).toBe(true)
	}
})
