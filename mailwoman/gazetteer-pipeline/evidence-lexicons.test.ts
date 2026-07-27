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
	loadPersonNameSurfaces,
	ONE_TOKEN_IMPORTANCE_FLOOR,
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
})
