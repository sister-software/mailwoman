/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke tests for the street-morphology FST builder. Walks the shipped libpostal dictionaries in
 *   `dictionaries/data/libpostal/dictionaries/` and asserts:
 *
 *   - Build completes without error
 *   - Trie contains the canonical English/French/German affixes we expect
 *   - Variants resolve to the same PlaceEntry as their canonical
 *   - Serialize → deserialize round-trips with the new `street_affix` placetype
 */
import { resourceDictionaryPath } from "@mailwoman/dictionaries/paths"
import { describe, expect, it } from "vitest"

import { deserializeFST, readFSTProvenance, serializeFST } from "#fst"
import { buildStreetMorphologyFST } from "#street"

const DICTIONARIES_DIR = resourceDictionaryPath("libpostal")

describe("buildStreetMorphologyFST", () => {
	it("ingests the libpostal street_types dictionaries", async () => {
		const result = await buildStreetMorphologyFST({ dictionariesDir: DICTIONARIES_DIR })

		expect(result.locales.length).toBeGreaterThan(40)
		expect(result.canonicalCount).toBeGreaterThan(500)
		expect(result.insertCount).toBeGreaterThan(result.canonicalCount)
	})

	it("recognizes the English canonical 'avenue' and its variants", async () => {
		const { matcher } = await buildStreetMorphologyFST({ dictionariesDir: DICTIONARIES_DIR, locales: ["en"] })

		const avenue = matcher.query("avenue")
		expect(avenue.accepting.length).toBeGreaterThan(0)
		expect(avenue.accepting[0]!.placetype).toBe("street_affix")
		expect(avenue.accepting[0]!.name).toBe("avenue")

		// Variants 'av', 'ave' and 'aven' resolve to the same canonical's wofID.
		const av = matcher.query("av")
		const ave = matcher.query("ave")
		const aven = matcher.query("aven")
		expect(av.accepting[0]?.wofID).toBe(avenue.accepting[0]!.wofID)
		expect(ave.accepting[0]?.wofID).toBe(avenue.accepting[0]!.wofID)
		expect(aven.accepting[0]?.wofID).toBe(avenue.accepting[0]!.wofID)
	})

	it("admits two-character street types and excludes the region abbreviations", async () => {
		const { matcher } = await buildStreetMorphologyFST({ dictionariesDir: DICTIONARIES_DIR, locales: ["en"] })

		const street = matcher.query("street").accepting[0]!.wofID
		const road = matcher.query("road").accepting[0]!.wofID

		expect(matcher.query("st").accepting[0]?.wofID).toBe(street)
		expect(matcher.query("rd").accepting[0]?.wofID).toBe(road)

		// `ct` is court and Connecticut, `la` is lane and Louisiana, `wy` is way and Wyoming.
		expect(matcher.query("ct").accepting).toHaveLength(0)
		expect(matcher.query("la").accepting).toHaveLength(0)
		expect(matcher.query("wy").accepting).toHaveLength(0)

		// A one-character variant stays out.
		expect(matcher.query("a").accepting).toHaveLength(0)

		const unguarded = await buildStreetMorphologyFST({
			dictionariesDir: DICTIONARIES_DIR,
			locales: ["en"],
			excludedVariants: new Set(),
		})

		expect(unguarded.matcher.query("ct").accepting[0]?.placetype).toBe("street_affix")
	})

	it("recognizes French 'rue' and German 'straße' canonicals", async () => {
		const { matcher } = await buildStreetMorphologyFST({ dictionariesDir: DICTIONARIES_DIR, locales: ["fr", "de"] })

		const rue = matcher.query("rue")
		expect(rue.accepting.some((e) => e.name === "rue" && e.placetype === "street_affix")).toBe(true)

		// `straße` normalizes via nfkc + lowercase.
		// Verify the canonical is reachable.
		const strasse = matcher.query("straße")
		expect(strasse.accepting.some((e) => e.placetype === "street_affix")).toBe(true)
	})

	it("round-trips through serialize + deserialize", async () => {
		const { matcher, provenance } = await buildStreetMorphologyFST({
			dictionariesDir: DICTIONARIES_DIR,
			locales: ["en"],
		})

		const buf = serializeFST(matcher, provenance)
		const restored = deserializeFST(buf)
		const restoredProvenance = readFSTProvenance(buf)

		expect(restoredProvenance?.placeCount).toBe(provenance.placeCount)
		const avenue = restored.query("avenue")
		expect(avenue.accepting[0]!.placetype).toBe("street_affix")
		expect(avenue.accepting[0]!.name).toBe("avenue")
	})
})
