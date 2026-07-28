/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three-law selectivity's unit surface (pure functions) + a DB-gated integration pass for the
 *   locality-surface build. Each law traces to a falsified training run (v3.16→v3.18) — these tests
 *   are the regression fence around that tuition.
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"

import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import {
	buildStreetTypeLexicon,
	clearsProminenceFloor,
	isSubPhraseAlias,
	loadDirectionalSurfaces,
	loadPersonNameSurfaces,
	loadUSRegionVocabulary,
	ONE_TOKEN_IMPORTANCE_FLOOR,
	painterFold,
	PERSON_NAME_IMPORTANCE_FLOOR,
} from "./evidence-lexicons.ts"
import { loadDegenerateSurfaces } from "./fst.ts"

describe("three-law selectivity — pure units", () => {
	const personNames = loadPersonNameSurfaces()

	it("law 3: person-name surfaces exist and carry the flip-row names", () => {
		// The v3.17→v3.18 flip rows: given names that are prominent-place homographs.
		for (const name of ["joseph", "pierre", "louis", "thomas"]) {
			expect(personNames.has(name), name).toBe(true)
		}
		// Titles ride personal_titles ("Rue Baron Desgenettes").
		expect(personNames.has("baron")).toBe(true)
	})

	it("law 3: metros clear the person-name tier, given names do not", () => {
		// paris/lyon/nancy are IN the name lists — the tiered floor keeps them at metro prominence.
		expect(clearsProminenceFloor("paris", 0.85, personNames)).toBe(true)
		expect(clearsProminenceFloor("lyon", 0.6, personNames)).toBe(true)
		// A given-name homograph at ordinary-town prominence is refused…
		expect(clearsProminenceFloor("joseph", 0.3, personNames)).toBe(false)
		// …while the same prominence on a non-name surface passes (law 2 only applies).
		expect(clearsProminenceFloor("rennes", 0.3, personNames)).toBe(true)
	})

	it("law 2: the plain prominence floor", () => {
		expect(clearsProminenceFloor("smallville", ONE_TOKEN_IMPORTANCE_FLOOR - 0.01, personNames)).toBe(false)
		expect(clearsProminenceFloor("smallville", ONE_TOKEN_IMPORTANCE_FLOOR, personNames)).toBe(true)
	})

	it("floors are ordered: person-name tier is strictly higher", () => {
		expect(PERSON_NAME_IMPORTANCE_FLOOR).toBeGreaterThan(ONE_TOKEN_IMPORTANCE_FLOOR)
	})

	it("law-3 guard: parent prominence never launders a person-name surface", () => {
		// A neighbourhood named "Joseph" inside a metropolis (parent 0.9) is still the Rue-Joseph
		// hazard — only OWN metropolis-tier importance clears a person-name surface.
		expect(clearsProminenceFloor("joseph", 0.1, personNames, 0.9)).toBe(false)
		expect(clearsProminenceFloor("joseph", PERSON_NAME_IMPORTANCE_FLOOR, personNames, 0)).toBe(true)
		// Non-name neighbourhoods DO inherit parent prominence (the Montmartre-class fix).
		expect(clearsProminenceFloor("belleville", 0.0, personNames, 0.9)).toBe(true)
		expect(clearsProminenceFloor("obscureplace", 0.0, personNames, 0.1)).toBe(false)
	})

	it("law 1: the degenerate set carries the shipped-index victims", () => {
		const { surfaces, stopwordTokens } = loadDegenerateSurfaces()

		// The case-folded alias collisions + street vocabulary the FST curation prunes.
		for (const s of ["la", "op", "boulevard", "lane", "street"]) {
			expect(surfaces.has(s), s).toBe(true)
		}
		// The compositional clause's token source ("de la" class).
		expect(stopwordTokens.has("de")).toBe(true)
		expect(stopwordTokens.has("la")).toBe(true)
	})

	it("law-1 directional closure (v5): the census flip surfaces are in the directional set", () => {
		const directionals = loadDirectionalSurfaces()

		// The v3.19 flip census: US neighbourhoods literally named these painted evidence onto street
		// directionals ("3rd Ave East" → street "3rd", "Fargo" → locality "North").
		for (const s of ["east", "west", "north", "south", "northeast", "northwest", "southeast", "southwest"]) {
			expect(directionals.has(s), s).toBe(true)
		}
		// The set stays out of the shipped FST policy — loadDegenerateSurfaces alone must NOT carry
		// "northeast" (policy separation: degenerate-surface-exclusion v1.1 is baked into FST trailers).
		expect(loadDegenerateSurfaces(undefined, painterFold).surfaces.has("northeast")).toBe(false)
	})

	it("law 4 (v5): US region vocabulary carries the census flip surfaces", () => {
		const region = loadUSRegionVocabulary()

		// The evidence→REGION rotation rows: Washington DC, Missouri Break Ln, Frannie Wyoming, Vermont 05454.
		for (const s of ["washington", "wyoming", "vermont", "missouri", "wy", "ct", "dc", "north dakota"]) {
			expect(region.has(s), s).toBe(true)
		}
		// Not a blanket word ban — ordinary locality surfaces stay out.
		expect(region.has("fargo")).toBe(false)
		expect(region.has("springfield")).toBe(false)
	})

	it("alt-name sub-phrase hygiene (v5): sub-phrases rejected, real nicknames kept", () => {
		// "East" ⊂ "East Nashville", "Washington" ⊂ "Mount Washington" — the names-table leak.
		expect(isSubPhraseAlias(painterFold("East"), painterFold("East Nashville"))).toBe(true)
		expect(isSubPhraseAlias(painterFold("Washington"), painterFold("Mount Washington"))).toBe(true)
		expect(isSubPhraseAlias(painterFold("Nashville"), painterFold("East Nashville"))).toBe(true)
		// Equality is not a sub-phrase (re-adding the primary through names is harmless)…
		expect(isSubPhraseAlias(painterFold("Frisco"), painterFold("Frisco"))).toBe(false)
		// …and genuine nicknames survive.
		expect(isSubPhraseAlias(painterFold("Frisco"), painterFold("San Francisco"))).toBe(false)
		// Contiguity required — a scattered subsequence is not a sub-phrase.
		expect(isSubPhraseAlias(painterFold("East Village"), painterFold("East Nashville Village Green"))).toBe(false)
	})
})

describe("street-type lexicon build", () => {
	it("canonical lowercase words in entries, short abbreviations uppercase-gated", async () => {
		const tmp = `${tmpdir()}/street-type-lexicon-test.json`
		const built = await buildStreetTypeLexicon({ output: tmp })

		expect(built.entries).toBeGreaterThan(400)
		const { readFileSync } = await import("node:fs")
		const j = JSON.parse(readFileSync(tmp, "utf8"))

		// "rue" must match lowercase (the FR probe class); "R" only as an uppercase code.
		expect(j.entries.rue).toBe(1)
		expect(j.code_entries.R).toBe(1)
		expect(j.entries.r).toBeUndefined()
		expect(j.entries.boulevard).toBe(1)
	})

	it("v2 / census family F1: US-state-homograph codes withheld, directionals kept", async () => {
		const tmp = `${tmpdir()}/street-type-lexicon-v2-test.json`
		const built = await buildStreetTypeLexicon({ output: tmp })

		expect(built.skippedRegionVocabulary).toBeGreaterThanOrEqual(4)
		const { readFileSync } = await import("node:fs")
		const j = JSON.parse(readFileSync(tmp, "utf8"))

		// "MOUNTAIN WAY WY 82601" / "SUSIE CT WY 83101" — the state token must carry NO street evidence.
		for (const code of ["WY", "CT", "KY", "MT", "PR"]) {
			expect(j.code_entries[code], code).toBeUndefined()
		}
		// Directional codes stay (single-letter CA forms; none collide with a state).
		expect(j.code_entries.N).toBe(1)
		expect(j.code_entries.W).toBe(1)
		// The canonical words behind the dropped codes are untouched.
		expect(j.entries.way).toBe(1)
		expect(j.entries.court).toBe(1)
	})
})

const ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))

describe.skipIf(!existsSync(ADMIN_DB))("locality-surface build — integration (admin DB)", () => {
	it("applies all three laws end to end", async () => {
		const { buildLocalitySurfaceLexicon } = await import("./evidence-lexicons.ts")
		const tmp = `${tmpdir()}/locality-surface-lexicon-test.json`
		// v3-parity placetypes for run-to-run comparability with the probe chain's numbers.
		const built = buildLocalitySurfaceLexicon({
			countries: ["FR"],
			placetypes: ["locality", "localadmin"],
			output: tmp,
		})

		expect(built.entries).toBeGreaterThan(10_000)
		expect(built.skippedDegenerate).toBeGreaterThan(0)
		expect(built.skippedProminence).toBeGreaterThan(0)
		const { readFileSync } = await import("node:fs")
		const j = JSON.parse(readFileSync(tmp, "utf8"))

		expect(j.entries.paris).toBe(3) // metro clears the person-name tier, homograph-flagged
		expect(j.entries.joseph).toBeUndefined() // law 3
		expect(j.entries["12"]).toBeUndefined() // letters-required
		expect(j.entries["de la"]).toBeUndefined() // law 1 compositional
	}, 600_000)

	it("v5: the census flip families are out, the legitimate entries stay", async () => {
		const { buildLocalitySurfaceLexicon } = await import("./evidence-lexicons.ts")
		const tmp = `${tmpdir()}/locality-surface-lexicon-v5-us-test.json`
		const built = buildLocalitySurfaceLexicon({
			countries: ["US"],
			placetypes: ["locality", "localadmin", "neighbourhood"],
			output: tmp,
		})

		expect(built.skippedRegionVocabulary).toBeGreaterThan(0)
		expect(built.skippedSubPhrase).toBeGreaterThan(0)
		const { readFileSync } = await import("node:fs")
		const j = JSON.parse(readFileSync(tmp, "utf8"))

		// Family F2b — directionals (neighbourhoods literally named these; law-1 closure):
		for (const s of ["east", "west", "north", "south", "northeast", "southwest"]) {
			expect(j.entries[s], s).toBeUndefined()
		}
		// Family F2 — region vocabulary (the evidence→REGION rotation rows):
		for (const s of ["washington", "wyoming", "vermont", "missouri", "north dakota"]) {
			expect(j.entries[s], s).toBeUndefined()
		}
		// WOF data-noise carriers with census receipts (the evidence supplemental-degenerate set):
		expect(j.entries.school).toBeUndefined()
		expect(j.entries.state).toBeUndefined()
		// The lexicon still carries the ordinary locality surfaces the census rows NEED. (Not casper/
		// powell: Casper WY is a GIVEN-NAME homograph at 0.42 < the 0.45 law-3 tier, Powell WY is below
		// the law-2 floor — both were absent from v4 too; their census flips were family-F1 street-code
		// evidence, fixed in the street lexicon.)
		for (const s of ["fargo", "minot", "rutland", "plainfield", "cheyenne"]) {
			expect(j.entries[s], s).toBeDefined()
		}
		// Multi-token entries with a directional/state INSIDE survive (only whole-surface exclusion):
		expect(j.entries["east nashville"]).toBeDefined()
	}, 600_000)
})
