/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke tests for the street-morphology FST builder. Walks the shipped libpostal dictionaries
 *   in `core/data/libpostal/dictionaries/` and asserts:
 *
 *   - Build completes without error
 *   - Trie contains the canonical English/French/German affixes we expect
 *   - Variants resolve to the same PlaceEntry as their canonical
 *   - Serialize → deserialize round-trips with the new `street_affix` placetype
 */
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { deserializeFst, readFstProvenance, serializeFst } from "./fst-serialize.js"
import { buildStreetMorphologyFst } from "./street-morphology-fst-builder.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DICTIONARIES_DIR = join(__dirname, "..", "core", "data", "libpostal", "dictionaries")

describe("buildStreetMorphologyFst", () => {
	it("ingests the libpostal street_types dictionaries", () => {
		const result = buildStreetMorphologyFst({ dictionariesDir: DICTIONARIES_DIR })

		expect(result.locales.length).toBeGreaterThan(40)
		expect(result.canonicalCount).toBeGreaterThan(500)
		expect(result.insertCount).toBeGreaterThan(result.canonicalCount)
	})

	it("recognises the English canonical 'avenue' and its variants", () => {
		const { matcher } = buildStreetMorphologyFst({ dictionariesDir: DICTIONARIES_DIR, locales: ["en"] })

		const avenue = matcher.query("avenue")
		expect(avenue.accepting.length).toBeGreaterThan(0)
		expect(avenue.accepting[0]!.placetype).toBe("street_affix")
		expect(avenue.accepting[0]!.name).toBe("avenue")

		// Variants 'ave' and 'aven' should resolve to the same canonical's wofID. (The 2-char
		// abbreviation 'av' is filtered out by the default `minVariantLength: 3` to avoid
		// state-abbreviation collisions — see the builder's docstring.)
		const ave = matcher.query("ave")
		const aven = matcher.query("aven")
		expect(ave.accepting[0]?.wofID).toBe(avenue.accepting[0]!.wofID)
		expect(aven.accepting[0]?.wofID).toBe(avenue.accepting[0]!.wofID)

		// Demonstrate the length filter — 'av' should NOT match under default opts.
		const av = matcher.query("av")
		expect(av.accepting.length).toBe(0)
	})

	it("recognises French 'rue' and German 'straße' canonicals", () => {
		const { matcher } = buildStreetMorphologyFst({ dictionariesDir: DICTIONARIES_DIR, locales: ["fr", "de"] })

		const rue = matcher.query("rue")
		expect(rue.accepting.some((e) => e.name === "rue" && e.placetype === "street_affix")).toBe(true)

		// `straße` normalizes via NFKC + lowercase. Verify the canonical is reachable.
		const strasse = matcher.query("straße")
		expect(strasse.accepting.some((e) => e.placetype === "street_affix")).toBe(true)
	})

	it("round-trips through serialize + deserialize", () => {
		const { matcher, provenance } = buildStreetMorphologyFst({
			dictionariesDir: DICTIONARIES_DIR,
			locales: ["en"],
		})
		const buf = serializeFst(matcher, provenance)
		const restored = deserializeFst(buf)
		const restoredProvenance = readFstProvenance(buf)

		expect(restoredProvenance?.placeCount).toBe(provenance.placeCount)
		const avenue = restored.query("avenue")
		expect(avenue.accepting[0]!.placetype).toBe("street_affix")
		expect(avenue.accepting[0]!.name).toBe("avenue")
	})
})
